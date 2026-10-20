/**
 * 记录一版产物：宿主的 `/adopt` 与 `bin/record.mjs` 共用的那一份实现。
 *
 * 为什么单独有这一层：以前「记一版」有两条路——面板的 `/adopt`（复制快照 + 追加记录），
 * 和迭代技能教 AI 手写的 `produced.jsonl`（硬链接 + 手写字段）。两套规则各自演进：
 * 快照命名不同、`at` 一个取当前时间一个取 mtime、一个复制一个硬链接。手写那套一旦哪个
 * 字段写错，面板不会报错，只在时间轴上静默错位。这里把「校验 / 快照 / id / 记录格式」
 * 收成一份，两条路都走它，以后改规则只改这里。
 *
 * 只依赖 Node 内置模块：不需要 DSH 宿主跑着，也不需要面板开着。
 *
 * @module dsh-workbench/record
 */

import { constants } from 'node:fs'
import { appendFile, copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

/** 产出记录文件（相对产线目录）。 */
export const PRODUCED_FILE = '.versions/produced.jsonl'

/** 审批事件文件（相对产线目录）——与产出记录放在一起，读的时间轴才有「审没审」。 */
export const DECISIONS_FILE = '.versions/decisions.jsonl'

/** 「产物」的扩展名：能被收编/记录的只有这些（源文档不算，它该被编辑而不是记一版）。 */
export const PRODUCT_EXT = new Set(['.docx', '.doc', '.pdf', '.xlsx', '.pptx', '.html', '.csv', '.png', '.jpg', '.jpeg'])

/** 记录里保留的最大字符数（摘要/备注/命令都截到这么长，避免一行 JSON 撑爆）。 */
const TEXT_LIMIT = 500
const COMMAND_LIMIT = 160

/**
 * 记录器的错误：带一个**语义码**，宿主路由据此映射 HTTP 状态，CLI 据此给人话。
 *
 * - `BAD_INPUT` → 400：产线目录 / 文件名 / 类型不合法
 * - `NOT_FOUND` → 404：产物不在原处
 * - `CONFLICT` → 409：同一分钟里同名的快照已经记过（不覆盖）
 * - `IO` → 500：磁盘上的失败（写快照、写记录）
 */
export class RecordError extends Error {
	/**
	 * @param code - 语义码（BAD_INPUT / NOT_FOUND / CONFLICT / IO）。
	 * @param message - 给用户看的中文原因。
	 */
	constructor(code, message) {
		super(message)
		this.name = 'RecordError'
		this.code = code
	}
}

/** 本地时间戳 `YYYYMMDDTHHmm`（快照名与 id 的前缀）。 */
export function stampOf(date = new Date()) {
	const p = (n) => String(n).padStart(2, '0')
	return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}T${p(date.getHours())}${p(date.getMinutes())}`
}

/**
 * 产线名：就是**存记录的那个目录**的名字。
 *
 * 根产线（记录直接放项目根）与子产线用同一条规则——面板显示的就是目录名，
 * 两边不必各记一套。
 */
export function lineNameOf(lineDir) {
	return basename(resolve(lineDir)) || 'root'
}

/** 快照文件名里只留「能当文件名用」的字符。 */
function safeName(value) {
	return String(value).replace(/[\\/:*?"<>|]/g, '_')
}

/**
 * 读 `produced.jsonl` 里指向某个快照的记录行。
 *
 * 只在**快照撞名**时才调用（正常记录根本不撞），所以这个 IO 不在日常路径上。
 * 坏行不算引用：坏行没人认，交给 `/history` 的健康度提示去提醒修。
 *
 * @param lineDir - 产线目录。
 * @param snapshotRel - 相对产线目录的快照路径（`.versions/…`）。
 * @returns 引用它的记录行数组（可以是空）。
 */
async function snapshotRefs(lineDir, snapshotRel) {
	let text = ''
	try {
		text = await readFile(join(lineDir, PRODUCED_FILE), 'utf8')
	} catch {
		return []
	}
	const refs = []
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue
		try {
			const row = JSON.parse(line)
			if (row !== null && typeof row === 'object' && !Array.isArray(row) && row.snapshot === snapshotRel) refs.push(row)
		} catch {
			/* 坏行不算引用 */
		}
	}
	return refs
}

/**
 * 记一版产物：复制一份快照到 `.versions/`，追加一行 `produced.jsonl`。
 *
 * 快照**用复制而不是硬链接**：硬链接会和「工作副本」共用 inode，下一版脚本若原地覆盖
 * （`open(path,'wb')` 那种），旧快照会跟着一起变——那就不是版本了。复制多占一份磁盘，
 * 换的是「已经记下的版本不会再变」。
 *
 * @param options.lineDir - 产线目录（记录就写进它的 `.versions/`）。
 * @param options.file - 产物文件名（**直接放在产线目录里**，不接受子路径）。
 * @param options.summary - 这一版干了什么（一句话，显示在时间轴那行）。
 * @param options.note - 备注（收编时人补的那句；与 summary 分开存，面板都显示）。
 * @param options.sources - 这一版改过哪些源（字符串或 `{ path }`），最多 20 条。
 * @param options.tool - 生成这一版的命令（最长 160 字符）。
 * @param options.by - 谁记的（默认 `human`；AI 记录时传 `dsh`）。
 * @param options.adopted - 是不是从「未入记录」里补收编的（面板不靠它，但记录里留个痕）。
 * @param options.unique - 同一分钟里重名时：`true` 自动加序号（CLI 用），`false` 直接报冲突（面板用）。
 * @returns `{ id, at, line, artifact, snapshot, bytes, record }`。
 * @throws {RecordError} 输入不合法、产物不在、快照已存在、写盘失败。
 */
export async function recordVersion(options) {
	const rawLineDir = String(options?.lineDir ?? '').trim()
	if (rawLineDir === '') throw new RecordError('BAD_INPUT', '缺少产线目录')
	const lineDir = resolve(rawLineDir)
	const file = String(options?.file ?? '').trim()
	if (file === '') throw new RecordError('BAD_INPUT', '缺少产物文件名')
	// 记录里 artifact 是「相对产线目录」的，所以只收直接放在产线目录里的文件。
	if (basename(file) !== file || file.includes('\\') || file.includes('/') || file.startsWith('.')) {
		throw new RecordError('BAD_INPUT', '产物只能是产线目录里的文件名（不要带路径）')
	}
	const ext = extname(file).toLowerCase()
	if (!PRODUCT_EXT.has(ext)) throw new RecordError('BAD_INPUT', '这个文件类型不算产物')

	const source = resolve(join(lineDir, file))
	const fence = lineDir + (process.platform === 'win32' ? '\\' : '/')
	const sameCase = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)
	if (!sameCase(source).startsWith(sameCase(fence))) throw new RecordError('BAD_INPUT', '目标路径越界')

	let info
	try {
		info = await stat(source)
	} catch {
		throw new RecordError('NOT_FOUND', `文件不在原处了：${file}`)
	}
	if (!info.isFile()) throw new RecordError('BAD_INPUT', '目标不是文件')

	// at 用**产物的 mtime**：这是「这一版什么时候出现的」，不是「什么时候补的记录」。
	// 写当前的 now 会让补记的旧版本排到时间轴最前面，也会让 /scan 的「未入记录」误判。
	const at = Math.floor(info.mtimeMs)
	const line = lineNameOf(lineDir)
	const stamp = stampOf(new Date(at))
	const versionsDir = join(lineDir, '.versions')
	const baseName = `${stamp}-${safeName(line)}-${safeName(file)}`

	// 快照名 = 时间戳 + 产线 + 文件名。撞名只有四种来路，分别处理：
	//   ① 同一版又记了一遍（记录里已有 at 相同的行）→ 谁都别记，省得时间轴出现重复轮次；
	//   ② 同一分钟里又生成了一版（mtime 不同）→ 记录器换一个带序号的名字，面板按冲突处理；
	//   ③ 快照还在、引用它的记录行没了（写记录失败 / 手工删行）→ 复用这份快照补记录（自愈）；
	//   ④ 并发：两个进程同时想写同一个名字 → 靠 COPYFILE_EXCL 兜底，撞了按 ①/② 再来一次。
	let snapshotName = baseName
	let snapshotAbs = join(versionsDir, snapshotName)
	let overwrite = false
	for (let attempt = 0; ; attempt += 1) {
		let occupied = false
		try {
			occupied = (await stat(snapshotAbs)).isFile()
		} catch {
			/* 不存在才是正常路径 */
		}
		if (!occupied) break
		const rel = `.versions/${snapshotName}`
		const refs = await snapshotRefs(lineDir, rel)
		if (refs.length === 0) {
			// ③ 孤儿快照：下面用当前产物覆盖它，让记录和内容重新对上
			overwrite = true
			break
		}
		if (refs.some((row) => Number.isFinite(row.at) && Math.floor(row.at) === at)) {
			// ① 同一版：再记一遍只会多一条重复轮次
			throw new RecordError('CONFLICT', `这一版已经记过（快照 ${rel} 已存在，记录里有 at 相同的条目）`)
		}
		// ② 同一分钟的另一版：只有记录器能接着记（它知道这是连续迭代）
		if (options?.unique !== true) {
			throw new RecordError('CONFLICT', `这一分钟已经记过一版 ${file}（快照 ${rel} 已存在）；等一分钟再收编，或改用记录器 CLI`)
		}
		if (attempt >= 20) throw new RecordError('IO', '同一分钟里记了太多版，等一分钟再记')
		snapshotName = `${stamp}-${safeName(line)}-${attempt + 2}-${safeName(file)}`
		snapshotAbs = join(versionsDir, snapshotName)
	}

	try {
		await mkdir(versionsDir, { recursive: true })
		// 新名字用 EXCL：两个记录器并发时谁先建谁赢，后来者不能覆盖（把 TOCTOU 一起挡住）；
		// 只有复用孤儿快照时才允许覆盖。
		await copyFile(source, snapshotAbs, overwrite ? 0 : constants.COPYFILE_EXCL)
	} catch (error) {
		if (error?.code === 'EEXIST' && options?.unique === true) {
			// 并发撞名：换一个随机后缀再试一次，不走上面的命名循环
			const retryName = `${stamp}-${safeName(line)}-${Math.random().toString(36).slice(2, 5)}-${safeName(file)}`
			try {
				await copyFile(source, join(versionsDir, retryName), constants.COPYFILE_EXCL)
				snapshotName = retryName
			} catch (retryError) {
				throw new RecordError('IO', `写快照失败：${retryError?.code ?? retryError?.message ?? retryError}`)
			}
		} else if (error?.code === 'EEXIST') {
			throw new RecordError('CONFLICT', `这一版已经记过（快照 .versions/${snapshotName} 刚被另一处写出来）`)
		} else {
			throw new RecordError('IO', `写快照失败：${error?.code ?? error?.message ?? error}`)
		}
	}

	const record = {
		// id 里带上产线、产物 mtime 的尾数与一段随机后缀：同一分钟同一份文件的两次记录
		// 若撞了同一个 id，审批会串到另一版上，所以在命名这一步就把碰撞压到可以忽略。
		id: `${stamp}-${safeName(line)}-${String(at).slice(-6)}-${Math.random().toString(36).slice(2, 6)}`,
		at,
		line,
		artifact: file,
		snapshot: `.versions/${snapshotName}`,
		kind: ext.replace('.', ''),
		bytes: info.size,
		tool: String(options?.tool ?? '').slice(0, COMMAND_LIMIT),
		by: String(options?.by ?? '') || 'human',
		sources: normalizeSources(options?.sources),
		summary: String(options?.summary ?? '').slice(0, TEXT_LIMIT),
		note: String(options?.note ?? '').slice(0, TEXT_LIMIT),
		adopted: options?.adopted === true
	}

	try {
		await appendFile(join(lineDir, PRODUCED_FILE), `${JSON.stringify(record)}\n`, 'utf8')
	} catch (error) {
		throw new RecordError('IO', `写记录失败：${error?.code ?? error?.message ?? error}`)
	}

	return { id: record.id, at, line, artifact: file, snapshot: record.snapshot, bytes: info.size, record }
}

/**
 * 归一化「改过哪些源」：字符串或 `{ path }` 都收，去空去重，最多 20 条。
 * @param value - 调用方给的任意值。
 * @returns `{ path, note }` 数组。
 */
export function normalizeSources(value) {
	if (!Array.isArray(value)) return []
	const seen = new Set()
	const out = []
	for (const item of value) {
		const path = typeof item === 'string' ? item : String(item?.path ?? '')
		const trimmed = path.trim()
		if (trimmed === '' || seen.has(trimmed)) continue
		seen.add(trimmed)
		out.push({ path: trimmed, note: typeof item?.note === 'string' ? item.note : '' })
		if (out.length >= 20) break
	}
	return out
}
