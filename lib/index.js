/**
 * dsh-workbench 宿主半侧。
 *
 * 只做一件事：把「宿主才知道的东西」用一组 JSON 路由交给浏览器侧的面板。
 *
 *   GET  /api/dsh-workbench/skills?cwd=<路径>
 *         技能目录（走核心 `ctx.skills` 注册表，和模型看到的是同一份目录：
 *         项目层、用户层 ~/.agents/skills、bundled 层都在里面）。
 *   GET  /api/dsh-workbench/skill?name=<技能名>&cwd=<路径>
 *         单个技能的**全文**，用于在面板里读 SKILL.md。
 *   GET  /api/dsh-workbench/docs?dir=<目录>
 *         扫一个目录，把「源」（md/tex/qmd）与「产物」（docx/pdf/doc…）按同名主干配对，
 *         给出「产物是否比源旧」——也就是文档迭代纪律里最该一眼看到的那件事。
 *   GET  /api/dsh-workbench/workspaces
 *         已登记的工作区列表，给面板做目录下拉。
 *   GET  /api/dsh-workbench/history?dir=<目录>
 *         读各产线的 `.versions/produced.jsonl` + `decisions.jsonl`，折成时间轴。
 *   GET  /api/dsh-workbench/demo
 *         插件自带演示项目的绝对路径。
 *   POST /api/dsh-workbench/scan   （JSON：`{ dir, windowHours?, provenance? }`）
 *         找「已经躺在目录里、但记录里没有」的产物：比对记录与磁盘，
 *         再去 DSH 会话日志里翻出最近一次产出它的命令、以及那前后改过哪些 md。
 *   POST /api/dsh-workbench/adopt  （JSON：`{ dir, line, file, note?, sources?, tool? }`）
 *         把其中一个收编成一条记录：复制一份快照 + 往 produced.jsonl 追加一行。
 *   POST /api/dsh-workbench/decide （JSON：`{ dir, line, id, state, note? }`）
 *         记一次审批（追加一行，不改历史）。
 *   POST /api/dsh-workbench/reveal （JSON：`{ dir, line, file, mode }`）
 *         用系统默认程序打开一版产物，或在文件管理器里定位它。
 *
 * 为什么必须有宿主半侧：浏览器侧读不到这些。技能目录在宿主注册表里；
 * 目录扫描需要 fs；工作区登记表与会话日志都是宿主服务。浏览器侧只负责画。
 *
 * 边界：只有三个路由会碰外界——`decide`（写审批）、`adopt`（写快照与记录）、
 * `reveal`（启动外部程序），三个都收在自己的路径围栏里、且都只收 POST。
 * 其余全部只读。本插件**不做任何模型调用**。
 *
 * @module dsh-workbench
 */

import { readdir, stat, readFile, appendFile, copyFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

/** Cordis 插件名。 */
export const name = 'dsh-workbench'

/** 浏览器 HTTP 载体就是本插件宿主半侧的全部依赖。 */
export const inject = ['webServer']

/** 路由前缀；客户端半侧用同一个常量拼 URL。 */
const PREFIX = '/api/dsh-workbench'

/** 一次扫描最多返回多少个条目（防止把巨型目录整个塞进 JSON）。 */
const MAX_ENTRIES = 1500

/** 「源」的扩展名：这些是唯一该被编辑的东西。 */
const SOURCE_EXT = new Set(['.md', '.markdown', '.tex', '.qmd', '.txt'])

/** 「产物」的扩展名：这些是随时可以重新生成的。 */
const ARTIFACT_EXT = new Set(['.docx', '.doc', '.pdf', '.xlsx', '.pptx'])

/** 扫描时关心的全部扩展名（其余文件不返回，面板不是文件管理器）。 */
const WANTED_EXT = new Set([...SOURCE_EXT, ...ARTIFACT_EXT, '.html', '.csv', '.png', '.jpg'])

/**
 * 算「产物」的扩展名（`/scan` 用）。
 *
 * 比 {@link ARTIFACT_EXT} 多几种：产线目录里真正会被反复覆盖、每次想留一版的，
 * 除了 Word / PDF / Excel，还有打印稿（图片）与导出的表格（csv）。
 */
const PRODUCT_EXT = new Set([...ARTIFACT_EXT, '.html', '.csv', '.png', '.jpg', '.jpeg'])

/**
 * `produced.jsonl` 里的时间戳与文件 mtime 允许差多少毫秒，仍算「这一版就是它」。
 *
 * 两个时钟不可能严格对齐：常见顺序是先复制快照、再追加记录；有些文件系统
 * （FAT、部分网络盘）mtime 只有 2 秒精度。所以「记录时间 ≥ 文件时间 − 3 秒」就算入库。
 */
const MTIME_SLACK = 3000

/** `/scan` 最多回溯多少小时内的会话（再早的产物，生成命令猜不准，不如不猜）。 */
const PROVENANCE_WINDOW_HOURS = 48

/** `/scan` 最多读多少个 DSH 会话（倒序取最近的，不把整个历史读一遍）。 */
const PROVENANCE_MAX_SESSIONS = 40

/** `/scan` 最多读多少条会话事件（读到上限就停，宁可少给几条来源）。 */
const PROVENANCE_MAX_EVENTS = 20000

/** 一条「生成命令」最长留多少字符。 */
const COMMAND_LIMIT = 160

/** 一次最多列出多少个「还没进记录」的产物。 */
const MAX_PRODUCTS = 200

/** 会用「写文件」工具直接产出文件的工具名（其余当命令行看）。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** 参数里可能指向被改写文件的字段名（各家工具叫法不一，逐个试）。 */
const PATH_ARG_KEYS = ['file_path', 'path', 'file', 'filename', 'target_file', 'target']

/**
 * 命令里出现这些词，说明**不是**它在产出这个文件。
 *
 * 判据只往「别说错」的方向收：同一个产物在最近 48 小时里被删过、挪过、打印过都算常见，
 * 一旦把这些命令当成「生成命令」贴上去，用户在时间轴上看到的就是假的归因。
 */
const NOT_PRODUCING = /(^|[^\p{L}])(del|erase|rm|rmdir|remove-item|move-item|move|ren|rename|type|more|cat|get-content|start|invoke-item|ii)([^\p{L}]|$)/iu

/**
 * 「写」的信号，分强弱两档。
 *
 * 强：显式指出输出到哪——重定向、`-o` / `--out` / `--outdir`（`\s*[=:]?\s*` 允许 `-o=路径` 这种写法）。
 * 弱：产出类动词——光有它不够（`soffice --convert-to pdf 论文.docx` 里也有 convert，
 *     但那个文件是**读入**的），所以要求**同一小段里出现目标文件名**才算。
 */
const OUTPUT_FLAG = /(--out(?:put|file)?(?![a-z0-9_\-=])|\s-o(?![a-z0-9_\-])|>>?)/iu
const PRODUCE_VERB = /(?<![\p{L}\p{N}-])(build|generate|export|convert|compile|render|make|save|print|生成|导出|输出|写入|编译|渲染|打印)/iu

/** 技能描述在列表里的截断长度（全文在 /skill 路由里）。 */
const DESCRIPTION_LIMIT = 400

/** 迭代记录最多返回多少轮（防止一个巨型项目把 JSON 撑爆）。 */
const MAX_ROUNDS = 1000

/** 审批事件文件（相对产线目录），与产出记录放在一起。 */
const DECISIONS_FILE = '.versions/decisions.jsonl'

/** 产出记录文件（相对产线目录）。 */
const PRODUCED_FILE = '.versions/produced.jsonl'

/** 合法的审批状态。 */
const DECISION_STATES = new Set(['approved', 'rejected', 'pending'])

/**
 * 「打开」放行的文件类型。
 *
 * 这是**安全边界**，不是偏好：这个接口会拿系统默认程序去开文件，若放行任意路径，
 * 任何能访问本机 Web 服务的页面都能借它执行程序（`.exe` / `.bat` / `.lnk`…）。
 * 只开文档与图片，其余一律拒绝。
 */
const OPENABLE_EXT = new Set([
	'.docx',
	'.doc',
	'.pdf',
	'.xlsx',
	'.xls',
	'.pptx',
	'.md',
	'.markdown',
	'.txt',
	'.csv',
	'.html',
	'.png',
	'.jpg',
	'.jpeg'
])

/**
 * 真正启动外部程序的那一步。做成模块级可替换，是为了自检能把它换掉——
 * 测试里绝不能真的弹出资源管理器窗口。
 */
let launcher = (command, args) => {
	const child = spawn(command, args, { detached: true, stdio: 'ignore' })
	child.unref()
}

/**
 * 用系统默认程序打开一个文件，或在文件管理器里定位它。
 *
 * 三个平台各一套，且都**不经过 shell**（参数以数组交给 spawn）：
 * 路径里的空格或 `&` 不会被当成命令解析。
 *
 * @param target - 已经过越界与白名单校验的绝对路径。
 * @param mode - `open` 用默认程序打开；`reveal` 在文件管理器里选中它。
 */
function launchTarget(target, mode) {
	if (process.platform === 'win32') {
		// explorer 对文件会转交 shell 执行（等于双击）；`/select,` 是「定位并选中」。
		if (mode === 'reveal') launcher('explorer.exe', [`/select,${target}`])
		else launcher('explorer.exe', [target])
		return
	}
	if (process.platform === 'darwin') {
		launcher('open', mode === 'reveal' ? ['-R', target] : [target])
		return
	}
	launcher('xdg-open', [mode === 'reveal' ? dirname(target) : target])
}

/** Windows 上路径比较不区分大小写。 */
const samePathCase = (value) => (process.platform === 'win32' ? value.toLowerCase() : value)

/* ==================== 小工具 ==================== */

/**
 * 发一个 JSON 响应。
 * @param res - Node 响应对象。
 * @param status - HTTP 状态码。
 * @param body - 任意可序列化对象。
 */
function send(res, status, body) {
	const text = JSON.stringify(body)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(text)
	})
	res.end(text)
}

/** 只取字符串叶子，别的都当空串——不把宿主对象带进响应。 */
const str = (value) => (typeof value === 'string' ? value : '')

/** 取路径 */
const pathOfResourceBase = (base) => {
	if (base === null || typeof base !== 'object') return ''
	if (base.kind === 'directory') return str(base.path)
	if (base.kind === 'url') return str(base.url)
	if (base.kind === 'opaque') return str(base.description)
	return ''
}

/** 主干名（去扩展名），用于把 md 与 docx 配对。 */
/**
 * 主干名（去扩展名），用于把 md 与 docx 配对。
 *
 * 会**反复剥掉**末尾的文档扩展名，因为导出产物常常带两层尾巴：
 * `报告.docx` 打印成 PDF 会叫 `报告.docx.pdf`，不剥两层就会和 `报告.docx`
 * 变成两个不同的主干、双双判成「无源产物」。
 */
const stemOf = (file) => {
	let base = basename(file)
	let guard = 0
	while (guard < 3) {
		const ext = extname(base).toLowerCase()
		if (!WANTED_EXT.has(ext)) break
		const trimmed = base.slice(0, base.length - ext.length)
		if (trimmed === '') break
		base = trimmed
		guard += 1
	}
	return base
}

/** 人类可读体积。 */
const humanBytes = (bytes) => {
	if (!Number.isFinite(bytes) || bytes < 0) return ''
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / 1048576).toFixed(1)} MB`
}

/* ==================== 路由：技能库 ==================== */

/**
 * 技能目录。走核心注册表，所以「模型能调用的」与「面板里看到的」不会漂移。
 * @param ctx - 宿主上下文。
 * @param url - 已解析的请求 URL（取 cwd）。
 * @param res - 响应对象。
 */
async function routeSkills(ctx, url, res) {
	const skills = ctx.get('skills')
	if (skills === undefined) return send(res, 200, { complete: false, skills: [], error: '技能注册表不可用' })
	const cwd = str(url.searchParams.get('cwd')) || undefined
	const snapshot = await skills.snapshot(cwd === undefined ? {} : { cwd })
	const list = (snapshot.skills ?? []).map((skill) => ({
		name: str(skill.name),
		description: str(skill.description).slice(0, DESCRIPTION_LIMIT),
		whenToUse: str(skill.whenToUse),
		source: str(skill.source),
		provider: str(skill.provider),
		path: pathOfResourceBase(skill.resourceBase),
		modelInvocable: skill.invocation?.modelInvocable === true,
		userInvocable: skill.invocation?.userInvocable === true
	}))
	return send(res, 200, { complete: snapshot.complete === true, cwd: cwd ?? '', skills: list })
}

/**
 * 单个技能全文。
 * @param ctx - 宿主上下文。
 * @param url - 已解析的请求 URL（取 name 与 cwd）。
 * @param res - 响应对象。
 */
async function routeSkill(ctx, url, res) {
	const skills = ctx.get('skills')
	if (skills === undefined) return send(res, 200, { error: '技能注册表不可用' })
	const skillName = str(url.searchParams.get('name'))
	if (skillName === '') return send(res, 400, { error: '缺少 name 参数' })
	const cwd = str(url.searchParams.get('cwd')) || undefined
	const skill = await skills.get(skillName, cwd === undefined ? {} : { cwd })
	if (skill === undefined) return send(res, 404, { error: `找不到技能 ${skillName}` })
	return send(res, 200, {
		name: str(skill.name),
		description: str(skill.description),
		source: str(skill.source),
		provider: str(skill.provider),
		path: pathOfResourceBase(skill.resourceBase),
		content: str(skill.content)
	})
}

/* ==================== 路由：文档看板 ==================== */

/**
 * 扫描一个目录，配对「源」与「产物」。
 *
 * 判定规则（就是文档迭代纪律里那一条）：同名主干下，
 *   产物 mtime < 源 mtime  →  stale：产物比源旧，需要重新生成；
 *   只有产物、没有源        →  orphan：产物没有对应源，属于历史遗留；
 *   只有源、没有产物        →  pending：源还没生成过产物（不算错）。
 *
 * @param url - 已解析的请求 URL（取 dir）。
 * @param res - 响应对象。
 */
async function routeDocs(url, res) {
	const raw = str(url.searchParams.get('dir'))
	if (raw === '') return send(res, 400, { error: '缺少 dir 参数' })
	const dir = resolve(raw)

	let names
	try {
		names = await readdir(dir)
	} catch (error) {
		return send(res, 200, { dir, exists: false, error: `读不到目录：${error?.code ?? error?.message ?? error}`, entries: [], pairs: [] })
	}

	const entries = []
	let truncated = false
	for (const entryName of names) {
		if (entries.length >= MAX_ENTRIES) {
			truncated = true
			break
		}
		if (entryName.startsWith('.')) continue
		const ext = extname(entryName).toLowerCase()
		if (!WANTED_EXT.has(ext)) continue
		const full = join(dir, entryName)
		let info
		try {
			info = await stat(full)
		} catch {
			continue
		}
		if (!info.isFile()) continue
		entries.push({
			name: entryName,
			stem: stemOf(entryName),
			ext,
			kind: SOURCE_EXT.has(ext) ? 'source' : ARTIFACT_EXT.has(ext) ? 'artifact' : 'other',
			bytes: info.size,
			bytesText: humanBytes(info.size),
			mtime: Math.floor(info.mtimeMs)
		})
	}
	entries.sort((a, b) => b.mtime - a.mtime)

	// 按主干配对。同名只保留最新的一份（目录里常见 v1/v2 副本）。
	const byStem = new Map()
	for (const entry of entries) {
		const bucket = byStem.get(entry.stem) ?? { stem: entry.stem, sources: [], artifacts: [] }
		if (entry.kind === 'source') bucket.sources.push(entry)
		else if (entry.kind === 'artifact') bucket.artifacts.push(entry)
		byStem.set(entry.stem, bucket)
	}

	const pairs = []
	for (const bucket of byStem.values()) {
		if (bucket.sources.length === 0 && bucket.artifacts.length === 0) continue
		const newest = (rows) => rows.reduce((best, row) => (best === null || row.mtime > best.mtime ? row : best), null)
		const source = newest(bucket.sources)
		const artifact = newest(bucket.artifacts)
		let state
		if (source !== null && artifact !== null) state = artifact.mtime < source.mtime ? 'stale' : 'ok'
		else if (artifact !== null) state = 'orphan'
		else state = 'pending'
		pairs.push({
			stem: bucket.stem,
			state,
			source: source === null ? null : { name: source.name, mtime: source.mtime, bytes: source.bytes },
			artifact: artifact === null ? null : { name: artifact.name, mtime: artifact.mtime, bytes: artifact.bytes },
			lagMs: source !== null && artifact !== null ? Math.max(0, source.mtime - artifact.mtime) : 0
		})
	}
	// 该先看的排前面：过期 → 孤儿 → 未生成 → 已同步。
	const ORDER = { stale: 0, orphan: 1, pending: 2, ok: 3 }
	pairs.sort((a, b) => (ORDER[a.state] - ORDER[b.state]) || a.stem.localeCompare(b.stem))

	const counts = { stale: 0, orphan: 0, pending: 0, ok: 0 }
	for (const pair of pairs) counts[pair.state] += 1

	return send(res, 200, { dir, exists: true, truncated, entries, pairs, counts })
}

/* ==================== 路由：工作区 ==================== */

/**
 * 已登记工作区，给面板的目录下拉用。
 * @param ctx - 宿主上下文。
 * @param res - 响应对象。
 */
async function routeWorkspaces(ctx, res) {
	const registry = ctx.get('workspaceRegistry')
	if (registry === undefined) return send(res, 200, { workspaces: [] })
	let list = []
	try {
		list = registry.list() ?? []
	} catch {
		list = []
	}
	const workspaces = list
		.map((workspace) => ({
			id: str(workspace?.id),
			path: str(workspace?.path),
			title: str(workspace?.title)
		}))
		.filter((workspace) => workspace.path !== '')
	return send(res, 200, { workspaces })
}

/* ==================== 路由：迭代时间轴 ==================== */

/**
 * 读一个 jsonl 记录文件。坏行跳过——记录文件宁可少一条，
 * 也不能让整页打不开。
 * @param file - 绝对路径。
 * @returns 解析出来的对象数组。
 */
async function readJsonl(file) {
	let text
	try {
		text = await readFile(file, 'utf8')
	} catch {
		return []
	}
	const rows = []
	for (const line of text.split('\n')) {
		if (line.trim() === '') continue
		try {
			const value = JSON.parse(line)
			if (value !== null && typeof value === 'object' && !Array.isArray(value)) rows.push(value)
		} catch {
			/* 坏行跳过 */
		}
	}
	return rows
}

/** 时间戳 → YYYY-MM-DD（本地日期，用来做「按天归类」）。 */
function dayOf(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return ''
	const d = new Date(ms)
	const p = (n) => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 读一条产线的迭代历史：产出记录 + 人的审批。
 * 审批是**追加式**的，同一个 id 最后一条生效。
 * @param rootDir - 项目根目录。
 * @param name - 产线名（子目录名）。
 * @returns 归一化后的轮次数组（新→旧）。
 */
async function readLine(rootDir, name) {
	const dir = join(rootDir, name)
	const produced = await readJsonl(join(dir, PRODUCED_FILE))
	const decisions = await readJsonl(join(dir, DECISIONS_FILE))

	const latest = new Map()
	for (const decision of decisions) {
		if (typeof decision?.id === 'string') latest.set(decision.id, decision)
	}

	const rounds = []
	for (const row of produced) {
		if (typeof row?.id !== 'string' || row.id === '') continue
		const at = Number.isFinite(row.at) ? row.at : 0
		const decision = latest.get(row.id)
		const state = decision !== undefined && DECISION_STATES.has(decision.state) ? decision.state : 'pending'
		rounds.push({
			id: row.id,
			at,
			day: dayOf(at),
			line: name,
			artifact: str(row.artifact),
			snapshot: str(row.snapshot),
			kind: str(row.kind) !== '' ? str(row.kind) : extname(str(row.artifact)).replace('.', ''),
			bytes: Number.isFinite(row.bytes) ? row.bytes : 0,
			bytesText: humanBytes(row.bytes),
			tool: str(row.tool),
			by: str(row.by),
			summary: str(row.summary),
			sources: Array.isArray(row.sources)
				? row.sources.map((s) => ({ path: str(s?.path), note: str(s?.note) })).filter((s) => s.path !== '')
				: [],
			approval: {
				state,
				at: decision !== undefined && Number.isFinite(decision.at) ? decision.at : 0,
				by: decision !== undefined ? str(decision.by) : '',
				note: decision !== undefined ? str(decision.note) : ''
			}
		})
	}
	rounds.sort((a, b) => b.at - a.at)
	return rounds
}

/**
 * 项目根 → 全部产线的迭代历史。
 * 根目录自己带记录时，根也算一条产线（单产线项目直接放根）。
 * @param url - 已解析的请求 URL（取 dir）。
 * @param res - 响应对象。
 */
async function routeHistory(url, res) {
	const raw = str(url.searchParams.get('dir'))
	if (raw === '') return send(res, 400, { error: '缺少 dir 参数' })
	const root = resolve(raw)

	const lines = []
	const rootRounds = await readLine(root, '.')
	if (rootRounds.length > 0) lines.push({ name: basename(root) || root, rounds: rootRounds })

	let names = []
	try {
		names = await readdir(root, { withFileTypes: true })
	} catch (error) {
		return send(res, 200, {
			dir: root,
			exists: false,
			error: `读不到目录：${error?.code ?? error?.message ?? error}`,
			lines: [],
			totals: { rounds: 0, pending: 0, approved: 0, rejected: 0, lines: 0 }
		})
	}

	for (const dirent of names) {
		if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
		const rounds = await readLine(root, dirent.name)
		if (rounds.length === 0) continue
		lines.push({ name: dirent.name, rounds })
	}

	const totals = { rounds: 0, pending: 0, approved: 0, rejected: 0, lines: lines.length }
	let truncated = false
	const shaped = lines.map((line) => {
		const counts = { pending: 0, approved: 0, rejected: 0 }
		const artifacts = new Set()
		const kinds = new Set()
		const days = new Set()
		const kept = []
		for (const round of line.rounds) {
			counts[round.approval.state] += 1
			artifacts.add(round.artifact)
			kinds.add(round.kind)
			days.add(round.day)
			totals[round.approval.state] += 1
			if (kept.length < MAX_ROUNDS) kept.push(round)
			else truncated = true
		}
		totals.rounds += line.rounds.length
		const times = line.rounds.map((r) => r.at).filter((t) => t > 0)
		return {
			name: line.name,
			counts,
			artifacts: [...artifacts].filter((a) => a !== ''),
			kinds: [...kinds].filter((k) => k !== ''),
			days: [...days].filter((d) => d !== '').sort().reverse(),
			firstAt: times.length === 0 ? 0 : Math.min(...times),
			lastAt: times.length === 0 ? 0 : Math.max(...times),
			rounds: kept
		}
	})

	return send(res, 200, { dir: root, exists: true, truncated, totals, lines: shaped })
}

/**
 * 演示项目目录：插件自带 examples/thesis-workbench，面板上一点就能看到效果。
 * @param res - 响应对象。
 */
async function routeDemo(res) {
	const dir = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'thesis-workbench'))
	let exists = false
	try {
		exists = (await stat(dir)).isDirectory()
	} catch {
		exists = false
	}
	return send(res, 200, { dir, exists })
}

/**
 * 读请求体里的 JSON（小体量接口，超过 64 KiB 直接拒绝）。
 * @param req - Node 请求对象。
 * @returns 解析后的对象。
 */
async function readJsonBody(req) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > 64 * 1024) throw new Error('请求体过大')
		chunks.push(chunk)
	}
	if (size === 0) return {}
	const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/* ==================== 路由：把「还没进记录」的产物收编 ==================== */

/**
 * 参数里出现的绝对路径（命令行里的每个路径、以及文件类参数）。
 *
 * 只在**参数值**里找，不把整个参数的 JSON 拼起来再找：`content` 里的代码片段
 * 也带着反斜杠，拼起来找会捞出半截路径（`"C:\\\\Users\\\\…"`），
 * 那种字符串去和真实路径比，永远比不中。
 *
 * @param args - 解析后的工具参数对象。
 * @returns 绝对路径数组（可能为空）。
 */
function pathTokensOf(args) {
	if (args === null || typeof args !== 'object') return []
	const found = []
	const command = typeof args.command === 'string' ? args.command : ''
	for (const token of command.match(/[A-Za-z]:[\\/][^"'\s|><)]*|\\\\[^"'\s|><)]+/g) ?? []) found.push(token)
	for (const key of PATH_ARG_KEYS) {
		const value = args[key]
		if (typeof value === 'string' && value.trim() !== '') found.push(value.trim().replace(/^"|"$/g, ''))
	}
	return [...new Set(found.filter((token) => token !== ''))]
}

/**
 * 从工具参数里抠出它写的那个文件。
 *
 * 优先认已知字段名（`file_path` 等），认不出来再把参数里出现的第一个路径样字符串
 * 当候选（`{ command: "python build.py --out out/论文.docx" }` 这种就得靠它）。
 * 只认绝对路径：本次会话的工作目录由会话头提供，插件不替它猜相对路径。
 *
 * @param args - 解析后的工具参数对象。
 * @returns 绝对路径或空串。
 */
function pathFromToolArgs(args) {
	if (args === null || typeof args !== 'object') return ''
	for (const key of PATH_ARG_KEYS) {
		const value = args[key]
		if (typeof value === 'string' && value.trim() !== '') return value.trim().replace(/^"|"$/g, '')
	}
	const first = pathTokensOf(args)[0]
	return first === undefined ? '' : first
}

/** 是不是「源」文件（相对路径命中的都算）。 */
const isSourcePath = (file) => SOURCE_EXT.has(extname(String(file)).toLowerCase())

/**
 * 这个产物是不是已经有一条记录了。
 *
 * 判据只有一条：记录里的产物名相同，且记录时间不早于文件时间（{@link MTIME_SLACK}）。
 * **不猜、不补写**——记录该由产出方在产出那一刻写；这里只负责指出「哪些还没写」。
 *
 * @param rounds - 该产线的全部轮次。
 * @param name - 产物文件名。
 * @param mtime - 文件修改时间。
 * @returns 命中的那一条记录，没有则 undefined。
 */
function recordOf(rounds, name, mtime) {
	let best
	for (const round of rounds) {
		if (round.artifact !== name) continue
		if (!(round.at >= mtime - MTIME_SLACK)) continue
		if (best === undefined || round.at < best.at) best = round
	}
	return best
}

/**
 * 扫一条产线的「产物台账」。
 *
 * 产物 = 产线目录里的文档类文件（排除 `.versions`、排除与源同名的导出尾巴、排除根目录上的 md）。
 * 同时回答两个问题：哪些已经进了记录（算 status、不返回给面板），哪些还没有。
 *
 * @param rootDir - 项目根目录。
 * @param name - 产线名（`.` 表示根目录自己）。
 * @returns 全部产物（新→旧）。
 */
async function collectProducts(rootDir, name) {
	const dir = name === '.' ? rootDir : join(rootDir, name)
	let dirents
	try {
		dirents = await readdir(dir, { withFileTypes: true })
	} catch {
		return []
	}
	const records = await readJsonl(join(dir, PRODUCED_FILE))
	const rounds = records
		.filter((row) => typeof row?.id === 'string' && row.id !== '')
		.map((row) => ({ id: row.id, at: Number.isFinite(row.at) ? row.at : 0, artifact: str(row.artifact) }))
	const stemSet = new Set()
	for (const dirent of dirents) {
		if (!dirent.isFile()) continue
		if (SOURCE_EXT.has(extname(dirent.name).toLowerCase())) stemSet.add(stemOf(dirent.name))
	}
	const items = []
	for (const dirent of dirents) {
		if (items.length >= MAX_PRODUCTS) break
		if (!dirent.isFile()) continue
		if (dirent.name.startsWith('.') || dirent.name.startsWith('~$')) continue
		const ext = extname(dirent.name).toLowerCase()
		if (!PRODUCT_EXT.has(ext)) continue
		// 与某份源同名（或去掉导出尾巴后同名）的，是源打印出来的副本，不算独立产物。
		if (stemSet.has(stemOf(dirent.name))) continue
		let info
		try {
			info = await stat(join(dir, dirent.name))
		} catch {
			continue
		}
		if (!info.isFile()) continue
		const mtime = Math.floor(info.mtimeMs)
		const recorded = recordOf(rounds, dirent.name, mtime)
		items.push({
			line: name === '.' ? basename(rootDir) : name,
			dir: name,
			name: dirent.name,
			kind: ext.replace('.', ''),
			bytes: info.size,
			bytesText: humanBytes(info.size),
			mtime,
			recorded: recorded !== undefined,
			recordId: recorded?.id ?? ''
		})
	}
	items.sort((a, b) => b.mtime - a.mtime)
	return items
}

/**
 * 从 DSH 会话日志里读「谁产出过这个目录里的东西」。
 *
 * 一个会话里只有两种事件有用：`tool/call`（模型调了什么工具、参数是什么）。
 * 这里把它们折成 `{ at, name, args, targets }`——`targets` 是参数里出现的绝对路径，
 * 用来和产物路径对齐。读不动就返回空表（面板上就只显示「没找到生成命令」）。
 *
 * @param sessions - 会话查询服务（`ctx.sessionQuery`）。
 * @param dir - 项目根目录。
 * @param since - 只看这个时刻之后的事件。
 * @returns `{ available, events, sessions }`。
 */
async function collectToolCalls(sessions, dir, since) {
	if (sessions === undefined) return { available: false, events: [], sessions: 0 }
	let records = []
	try {
		records = (await sessions.listSessions()) ?? []
	} catch {
		return { available: false, events: [], sessions: 0 }
	}
	const prefix = samePathCase(resolve(dir) + (process.platform === 'win32' ? '\\' : '/'))
	const roots = new Set([prefix, samePathCase(resolve(dir))])
	const picked = []
	for (const record of records) {
		const cwd = str(record?.header?.cwd)
		if (cwd === '') continue
		const key = samePathCase(resolve(cwd))
		if (!roots.has(key) && !samePathCase(key + (process.platform === 'win32' ? '\\' : '/')).startsWith(prefix)) continue
		const createdAt = Number.isFinite(record?.header?.createdAt) ? record.header.createdAt : 0
		picked.push({ id: str(record?.header?.id), createdAt })
	}
	picked.sort((a, b) => b.createdAt - a.createdAt)
	const events = []
	let scanned = 0
	for (const session of picked.slice(0, PROVENANCE_MAX_SESSIONS)) {
		if (session.id === '' || scanned >= PROVENANCE_MAX_EVENTS) break
		let snapshot
		try {
			snapshot = await sessions.readSession(session.id)
		} catch {
			continue
		}
		for (const event of snapshot?.events ?? []) {
			// 事件里没有时间戳的事件只是没参与折叠，跳过。
			if (event?.type !== 'tool/call') continue
			if (!Number.isFinite(event?.time) || event.time < since) continue
			scanned += 1
			if (scanned > PROVENANCE_MAX_EVENTS) break
			const data = event.data ?? {}
			let args = {}
			try {
				const parsed = JSON.parse(str(data.arguments))
				if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
			} catch {
				args = {}
			}
			const writeTool = WRITE_TOOLS.has(str(data.name))
			const command = writeTool ? '' : str(args.command)
			if (command === '' && pathFromToolArgs(args) === '') continue
			events.push({
				at: event.time,
				name: str(data.name),
				command,
				writeTool,
				args: JSON.stringify(args).slice(0, 2000),
				targets: pathTokensOf(args)
			})
		}
	}
	events.sort((a, b) => a.at - b.at)
	return { available: true, events, sessions: picked.length }
}

/**
 * 一个产物落在哪个绝对路径上。
 * @param rootDir - 项目根目录。
 * @param line - 产线名（`.` = 根目录）。
 * @param file - 产物文件名。
 * @returns 绝对路径。
 */
const productPath = (rootDir, line, file) => (line === '.' ? join(rootDir, file) : join(rootDir, line, file))

/** 缩短一条命令，只留一行。 */
const shortCommand = (command) => {
	const oneLine = command.replace(/\s+/g, ' ').trim()
	return oneLine.length > COMMAND_LIMIT ? `${oneLine.slice(0, COMMAND_LIMIT)}…` : oneLine
}

/**
 * 这条命令看起来是不是在**产出**这个文件。
 *
 * 光有「命令里出现过这个路径」不够，分三步看路径附近那一小段（前 60 / 后 40 字符）：
 *   1. 有 {@link OUTPUT_FLAG}（`--out` / `-o` / 重定向）→ 是在写它；
 *   2. 有 {@link PRODUCE_VERB} **且同一段里出现目标文件名** → 也算（`python build.py 论文.docx`）；
 *   3. 都没有 → 不认。
 *
 * 反例都是真的踩过的：`soffice --convert-to pdf 论文.docx --outdir …` 里那个 docx 是**读入**的，
 * 而 `--outdir` 不是输出到它；`Get-Content 论文.docx` 只是看。归因错一次，
 * 时间轴上就多一条假历史——所以宁可少给。
 *
 * @param command - 完整命令行。
 * @param target - 目标文件的绝对路径（Windows 上大小写不敏感）。
 * @returns 看起来是在写它则为 true。
 */
function looksLikeOutput(command, target) {
	const at = samePathCase(command).indexOf(samePathCase(target))
	if (at < 0) return false
	const window = command.slice(Math.max(0, at - 60), at + target.length + 40)
	if (OUTPUT_FLAG.test(window)) return true
	const stem = basename(target)
	return PRODUCE_VERB.test(window) && samePathCase(window).includes(samePathCase(stem))
}

/**
 * 找出每个产物「最近一次由哪条命令产出」。
 *
 * 判据刻意保守，三条：
 *   1. 取该产物时间**之前**最近的一条工具调用；
 *   2. 参数里必须出现过这个文件；
 *   3. 用「写文件」工具写的算；命令行则要求 {@link looksLikeOutput} 认，
 *      且命令里没有删除/移动/查看这类动词（否则 `del 论文.docx` 会被认成生成）。
 *
 * 同一条命令产出多个文件（Word + PDF，或一次重建 8 个分章）是常态：
 * 每个产物各算各的，不去抢归属。找不到就不给——面板上写「没找到生成命令」。
 * 宁可少说，也不能把别的项目的命令安到它头上。
 *
 * @param products - {@link collectProducts} 的结果。
 * @param rootDir - 项目根目录。
 * @param provenance - {@link collectToolCalls} 的结果。
 * @returns 每个条目多出 `tool` / `toolAt` 两个字段（新数组）。
 */
function attributeProducts(products, rootDir, provenance) {
	const timed = provenance.events.filter((event) => event.at > 0)
	return products.map((product) => {
		// 用 `dir` 而不是 `line`：根目录那条产线的 `line` 是目录名，拼路径会多一层。
		const target = samePathCase(productPath(rootDir, product.dir ?? product.line, product.name))
		let hit = null
		for (const event of timed) {
			if (event.at > product.mtime) continue
			const owns = event.writeTool === true ? event.targets.length > 0 : event.command !== '' && looksLikeOutput(event.command, target)
			if (!owns) continue
			if (event.command !== '' && NOT_PRODUCING.test(event.command)) continue
			if (!event.targets.some((path) => samePathCase(resolve(path)) === target)) continue
			if (hit === null || event.at > hit.at) hit = event
		}
		return { ...product, tool: hit === null ? '' : shortCommand(hit.command !== '' ? hit.command : hit.name), toolAt: hit === null ? 0 : hit.at }
	})
}

/**
 * 产物旁边最近改过哪些「源」。
 *
 * 只看同一产线目录里的 md/tex，且修改时间落在「产出前 12 小时」这个窗口里——
 * 这正是「改了这几份稿 → 重新生成了这一版」那次动作的形状。
 *
 * @param rootDir - 项目根目录。
 * @param line - 产线名。
 * @param mtime - 产物时间。
 * @returns `{ path, note, mtime }` 数组（新→旧）。
 */
async function sourcesOf(rootDir, line, mtime) {
	const dir = line === '.' ? rootDir : join(rootDir, line)
	let dirents
	try {
		dirents = await readdir(dir, { withFileTypes: true })
	} catch {
		return []
	}
	const found = []
	for (const dirent of dirents) {
		if (!dirent.isFile() || !isSourcePath(dirent.name)) continue
		let info
		try {
			info = await stat(join(dir, dirent.name))
		} catch {
			continue
		}
		// 产出前 12 小时内改过的源才算「这一版的来源」。
		if (info.mtimeMs > mtime || info.mtimeMs < mtime - 12 * 3600 * 1000) continue
		found.push({ path: dirent.name, note: '', mtime: Math.floor(info.mtimeMs) })
	}
	found.sort((a, b) => b.mtime - a.mtime)
	return found
}

/**
 * 找「已经躺在目录里、但记录里还没有」的产物。
 * @param ctx - 宿主上下文（取会话查询服务；没有也不影响，只是拿不到生成命令）。
 * @param rootDir - 项目根目录。
 * @param windowHours - 回溯多少小时（更早的产物仍会列出，只是不去翻会话找命令）。
 * @param withProvenance - 是否去 DSH 会话日志里翻生成命令。
 * @returns `{ products, lines, provenance }`。
 */
async function scanProducts(ctx, rootDir, windowHours, withProvenance) {
	const since = Date.now() - windowHours * 3600 * 1000
	const groups = []
	const rootProducts = await collectProducts(rootDir, '.')
	if (rootProducts.length > 0) groups.push({ name: basename(rootDir) || rootDir, products: rootProducts })
	let dirents = []
	try {
		dirents = await readdir(rootDir, { withFileTypes: true })
	} catch (error) {
		return { products: [], lines: [], provenance: { available: false, sessions: 0 }, error: `读不到目录：${error?.code ?? error?.message ?? error}` }
	}
	for (const dirent of dirents) {
		if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue
		const products = await collectProducts(rootDir, dirent.name)
		if (products.length > 0) groups.push({ name: dirent.name, products })
	}
	let sessions
	try {
		sessions = ctx.get('sessionQuery')
	} catch {
		sessions = undefined
	}
	const waiting = groups.flatMap((group) => group.products.filter((product) => !product.recorded && product.mtime >= since))
	const provenance = withProvenance && waiting.length > 0 ? await collectToolCalls(sessions, rootDir, since) : { available: false, events: [], sessions: 0 }
	const attributed = new Map()
	if (provenance.events.length > 0) {
		for (const entry of attributeProducts(waiting, rootDir, provenance)) attributed.set(`${entry.line}\u0000${entry.name}`, entry)
	}
	const lines = []
	const all = []
	for (const group of groups) {
		const out = []
		for (const product of group.products) {
			if (product.recorded) continue
			const extra = attributed.get(`${product.line}\u0000${product.name}`) ?? { tool: '', toolAt: 0 }
			const sources = (await sourcesOf(rootDir, product.dir, product.mtime)).map((source) => source.path)
			const entry = { ...product, tool: extra.tool, toolAt: extra.toolAt, sources }
			out.push(entry)
			all.push(entry)
		}
		if (out.length > 0) lines.push({ name: group.name, products: out })
	}
	return { products: all, lines, provenance: { available: provenance.available, sessions: provenance.sessions, events: provenance.events.length } }
}

/**
 * 找「还没进记录」的产物（只读，不写任何东西）。
 *
 * 这是在补那个最要命的缺口：迭代页读的是 `produced.jsonl`，而真实项目里**没有人写过它**，
 * 于是时间轴永远是空的。这里不替你写记录（记录必须由产出那一刻写下来），
 * 只把「目录里躺着、记录里没有」的那些列出来，让你一句话就能收编。
 *
 * @param ctx - 宿主上下文。
 * @param req - Node 请求对象（JSON：`{ dir, windowHours?, provenance? }`）。
 * @param res - 响应对象。
 */
async function routeScan(ctx, req, res) {
	let body
	try {
		body = await readJsonBody(req)
	} catch (error) {
		return send(res, 400, { error: `请求体不是合法 JSON：${error?.message ?? error}` })
	}
	const raw = str(body.dir)
	if (raw === '') return send(res, 400, { error: '缺少 dir 参数' })
	const rootDir = resolve(raw)
	const windowHours = Number.isFinite(body.windowHours) && body.windowHours > 0 ? Math.min(body.windowHours, 24 * 30) : PROVENANCE_WINDOW_HOURS
	const result = await scanProducts(ctx, rootDir, windowHours, body.provenance !== false)
	if (result.error !== undefined) return send(res, 200, { dir: rootDir, exists: false, error: result.error, lines: [], totals: { products: 0, lines: 0 } })
	return send(res, 200, {
		dir: rootDir,
		exists: true,
		windowHours,
		provenance: result.provenance,
		totals: { products: result.products.length, lines: result.lines.length },
		lines: result.lines
	})
}

/**
 * 把目录里的一个产物收编成一条记录：复制一份快照 + 追加一行 `produced.jsonl`。
 *
 * 这是本插件**第三个会写文件的操作**（前两个是记审批、打开文件），边界照样收死：
 * 只写「项目根目录下某个直接子目录的 `.versions/`」，拒绝路径穿越，
 * 文件必须真的存在、必须是允许的文档类型，快照同名时**只新建不覆盖**。
 *
 * @param req - Node 请求对象（JSON：`{ dir, line, file, note?, sources?, tool?, summary? }`）。
 * @param res - 响应对象。
 */
async function routeAdopt(req, res) {
	let body
	try {
		body = await readJsonBody(req)
	} catch (error) {
		return send(res, 400, { error: `请求体不是合法 JSON：${error?.message ?? error}` })
	}
	const root = str(body.dir)
	const line = str(body.line) === '' ? '.' : str(body.line)
	const file = str(body.file)
	if (root === '' || file === '') return send(res, 400, { error: '缺少 dir / file' })
	if (line !== '.' && (line === '..' || line.includes('/') || line.includes('\\') || line.includes(':'))) {
		return send(res, 400, { error: 'line 只能是产线目录名' })
	}
	if (basename(file) !== file || file.includes('\\') || file.startsWith('.')) return send(res, 400, { error: 'file 只能是产线目录里的文件名' })
	const source = resolve(productPath(resolve(root), line, file))
	const rootDir = resolve(root)
	const fence = rootDir + (process.platform === 'win32' ? '\\' : '/')
	if (!samePathCase(source).startsWith(samePathCase(fence))) return send(res, 400, { error: '目标路径越界' })
	if (!PRODUCT_EXT.has(extname(source).toLowerCase())) return send(res, 400, { error: '这个文件类型不算产物' })
	let info
	try {
		info = await stat(source)
	} catch {
		return send(res, 404, { error: '文件不在原处了' })
	}
	if (!info.isFile()) return send(res, 400, { error: '目标不是文件' })

	const stamp = (() => {
		const d = new Date()
		const p = (n) => String(n).padStart(2, '0')
		return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}`
	})()
	// 快照名里只留「能当文件名用」的字符，产线名不会跑出这个目录。
	const safeLine = (line === '.' ? (basename(rootDir) || 'root') : line).replace(/[\\/:*?"<>|]/g, '_')
	const snapshotName = `${stamp}-${safeLine}-${file}`
	const versionsDir = join(rootDir, line, '.versions')
	const snapshotRel = `.versions/${snapshotName}`
	const snapshotAbs = join(versionsDir, snapshotName)
	try {
		const existing = await stat(snapshotAbs)
		// 同一分钟内连续收编两次：不覆盖，直接告诉调用方等一会儿。
		if (existing.isFile()) return send(res, 409, { error: `这一分钟已经收编过 ${file}（快照 ${snapshotRel} 已存在）` })
	} catch {
		/* 不存在才是正常的 */
	}
	try {
		await copyFile(source, snapshotAbs)
	} catch (error) {
		return send(res, 500, { error: `写快照失败：${error?.code ?? error?.message ?? error}` })
	}
	const at = Date.now()
	const id = `${stamp}-${safeLine}-${String(info.mtimeMs).slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`
	const record = {
		id,
		at,
		line: line === '.' ? (basename(rootDir) || 'root') : line,
		artifact: file,
		snapshot: snapshotRel,
		kind: extname(file).replace('.', '').toLowerCase(),
		bytes: info.size,
		tool: str(body.tool).slice(0, COMMAND_LIMIT),
		by: str(body.by) || 'human',
		sources: Array.isArray(body.sources) ? body.sources.slice(0, 20).map((s) => ({ path: str(s?.path ?? s), note: '' })).filter((s) => s.path !== '') : [],
		summary: str(body.summary).slice(0, 500),
		note: str(body.note).slice(0, 500),
		adopted: true
	}
	try {
		await appendFile(join(rootDir, line, PRODUCED_FILE), `${JSON.stringify(record)}\n`, 'utf8')
	} catch (error) {
		return send(res, 500, { error: `写记录失败：${error?.code ?? error?.message ?? error}` })
	}
	return send(res, 200, { ok: true, id, snapshot: snapshotRel, bytes: info.size })
}

/**
 * 记一次审批（追加一行，不改历史）。
 * 这是本插件唯一的写操作，且只写产线目录下的 `.versions/decisions.jsonl`。
 * @param req - Node 请求对象。
 * @param res - 响应对象。
 */
async function routeDecide(req, res) {
	let body
	try {
		body = await readJsonBody(req)
	} catch (error) {
		return send(res, 400, { error: `请求体不是合法 JSON：${error?.message ?? error}` })
	}
	const root = str(body.dir)
	const line = str(body.line)
	const id = str(body.id)
	const state = str(body.state)
	const note = str(body.note).slice(0, 500)
	if (root === '' || line === '' || id === '') return send(res, 400, { error: '缺少 dir / line / id' })
	if (!DECISION_STATES.has(state)) return send(res, 400, { error: `state 必须是 ${[...DECISION_STATES].join(' / ')}` })
	// 只允许写进「根目录下的某个直接子目录」，不接受任何路径穿越。
	if (line === '.' || line === '..' || line.includes('/') || line.includes('\\') || line.includes(':')) {
		return send(res, 400, { error: 'line 只能是产线目录名' })
	}
	const rootDir = resolve(root)
	const target = resolve(join(rootDir, line, DECISIONS_FILE))
	if (!target.startsWith(resolve(rootDir) + (process.platform === 'win32' ? '\\' : '/'))) {
		return send(res, 400, { error: '目标路径越界' })
	}
	try {
		await appendFile(target, `${JSON.stringify({ id, at: Date.now(), state, by: str(body.by) || 'human', note })}\n`, 'utf8')
	} catch (error) {
		return send(res, 500, { error: `写入失败：${error?.code ?? error?.message ?? error}` })
	}
	return send(res, 200, { ok: true, id, state })
}

/**
 * 用系统默认程序打开一版产物，或在文件管理器里定位它。
 *
 * 这是本插件**第二个会碰外界的操作**（严格说是「启动外部程序」），所以边界收得很紧：
 * 只认白名单里的文档类型、只认项目根目录里的文件（拒绝路径穿越）、文件必须真的存在。
 * 少了任何一条，任何能访问本机 Web 服务的页面都能借这个接口执行任意程序。
 *
 * @param req - Node 请求对象（JSON：`{ dir, line, file, mode }`）。
 * @param res - 响应对象。
 */
async function routeReveal(req, res) {
	let body
	try {
		body = await readJsonBody(req)
	} catch (error) {
		return send(res, 400, { error: `请求体不是合法 JSON：${error?.message ?? error}` })
	}
	const root = str(body.dir)
	const line = str(body.line) === '' ? '.' : str(body.line)
	const file = str(body.file)
	const mode = str(body.mode) === 'reveal' ? 'reveal' : 'open'
	if (root === '' || file === '') return send(res, 400, { error: '缺少 dir / file' })
	// 产线名只允许是「根目录下的一个直接子目录」，不接受任何路径穿越。
	if (line !== '.' && (line === '..' || line.includes('/') || line.includes('\\') || line.includes(':'))) {
		return send(res, 400, { error: 'line 只能是产线目录名' })
	}
	const rootDir = resolve(root)
	const target = resolve(join(rootDir, line, file))
	const fence = rootDir + (process.platform === 'win32' ? '\\' : '/')
	if (!samePathCase(target).startsWith(samePathCase(fence))) return send(res, 400, { error: '目标路径越界' })
	if (!OPENABLE_EXT.has(extname(target).toLowerCase())) return send(res, 400, { error: '这个文件类型不通过「打开」接口' })
	let info
	try {
		info = await stat(target)
	} catch {
		return send(res, 404, { error: '文件不在原处了（快照可能被移走或删掉）' })
	}
	if (!info.isFile()) return send(res, 400, { error: '目标不是文件' })
	try {
		launchTarget(target, mode)
	} catch (error) {
		return send(res, 500, { error: `打不开：${error?.code ?? error?.message ?? error}` })
	}
	return send(res, 200, { ok: true, mode, path: target })
}

/* ==================== 插件主体 ==================== */

/**
 * 注册三个只读路由；返回的 disposer 由路由服务自己管，插件卸载即摘除。
 * @param ctx - 宿主上下文。
 */
export function apply(ctx) {
	ctx.webServer.register({
		kind: 'prefix',
		path: PREFIX,
		handler: async (req, res) => {
			const method = req.method ?? 'GET'
			if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return send(res, 405, { error: '只支持 GET / POST' })
			const url = new URL(req.url ?? '/', 'http://localhost')
			const route = url.pathname.slice(PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
			// 写接口一律收 POST：decide（记审批）/ reveal（打开文件）/ scan（找没进记录的）/ adopt（收编一版）。
			if (method === 'POST' && route !== 'decide' && route !== 'reveal' && route !== 'scan' && route !== 'adopt') {
				return send(res, 405, { error: `${route === '' ? '根路径' : route} 只支持 GET` })
			}
			try {
				switch (route) {
					case 'skills':
						return await routeSkills(ctx, url, res)
					case 'skill':
						return await routeSkill(ctx, url, res)
					case 'docs':
						return await routeDocs(url, res)
					case 'workspaces':
						return await routeWorkspaces(ctx, res)
					case 'history':
						return await routeHistory(url, res)
					case 'demo':
						return await routeDemo(res)
					case 'decide':
						if (method !== 'POST') return send(res, 405, { error: 'decide 只接受 POST' })
						return await routeDecide(req, res)
					case 'reveal':
						if (method !== 'POST') return send(res, 405, { error: 'reveal 只接受 POST' })
						return await routeReveal(req, res)
					case 'scan':
						if (method !== 'POST') return send(res, 405, { error: 'scan 只接受 POST' })
						return await routeScan(ctx, req, res)
					case 'adopt':
						if (method !== 'POST') return send(res, 405, { error: 'adopt 只接受 POST' })
						return await routeAdopt(req, res)
					default:
						return send(res, 404, { error: `未知路由 ${route}` })
				}
			} catch (error) {
				// 任何意外都收敛成一个 JSON 错误：面板要能显示原因，而不是白屏。
				return send(res, 500, { error: error?.message ?? String(error) })
			}
		}
	})
}

/** 供自检脚本复用，不进运行时。 */
export const __internals = {
	stemOf,
	humanBytes,
	SOURCE_EXT,
	ARTIFACT_EXT,
	WANTED_EXT,
	PRODUCT_EXT,
	OPENABLE_EXT,
	recordOf,
	collectProducts,
	attributeProducts,
	pathFromToolArgs,
	pathTokensOf,
	looksLikeOutput,
	sourcesOf,
	scanProducts,
	/** 让自检换掉「真的启动外部程序」那一步，免得测试里弹出资源管理器。 */
	setLauncher(next) {
		launcher = next
	}
}
