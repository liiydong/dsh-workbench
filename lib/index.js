/**
 * dsh-workbench 宿主半侧。
 *
 * 只做一件事：把「宿主才知道的东西」用三个只读 JSON 路由交给浏览器侧的面板。
 *
 *   GET /api/dsh-workbench/skills?cwd=<路径>
 *        技能目录（走核心 `ctx.skills` 注册表，和模型看到的是同一份目录：
 *        项目层、用户层 ~/.agents/skills、bundled 层都在里面）。
 *   GET /api/dsh-workbench/skill?name=<技能名>&cwd=<路径>
 *        单个技能的**全文**，用于在面板里读 SKILL.md。
 *   GET /api/dsh-workbench/docs?dir=<目录>
 *        扫一个目录，把「源」（md/tex/qmd）与「产物」（docx/pdf/doc…）按同名主干配对，
 *        给出「产物是否比源旧」——也就是文档迭代纪律里最该一眼看到的那件事。
 *   GET /api/dsh-workbench/workspaces
 *        已登记的工作区列表，给面板做目录下拉。
 *
 * 为什么必须有宿主半侧：浏览器侧读不到这些。技能目录在宿主注册表里；
 * 目录扫描需要 fs；工作区登记表是宿主服务。浏览器侧只负责画。
 *
 * 只读：本插件不写任何文件，不做任何模型调用。
 *
 * @module dsh-workbench
 */

import { readdir, stat, readFile, appendFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
			// 读接口一律只读：只有 decide 收 POST。
			if (method === 'POST' && route !== 'decide') return send(res, 405, { error: `${route === '' ? '根路径' : route} 只支持 GET` })
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
export const __internals = { stemOf, humanBytes, SOURCE_EXT, ARTIFACT_EXT, WANTED_EXT }
