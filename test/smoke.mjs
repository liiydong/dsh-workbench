/**
 * dsh-workbench 自检：在 Node 里跑真实的客户端组件树，不开浏览器。
 *
 * 原理：客户端 bundle 的 factory 与视图组件都是普通函数。
 *   1. 桩掉 window.__ModuleLoader__.load 拿到 factory；
 *   2. 给 require('react') 一个迷你 React 运行时（hooks + 渲染循环 + effect）；
 *   3. 桩掉 fetch，喂固定数据，遍历产出的元素树做断言。
 *
 * 三个会让测试本身失效的坑（本文件按手册逐条规避）：
 *   - hook 槽按**组件实例**分配，不能共用一个扁平数组；
 *   - effect 去重按**组件类型 + hook 序号**，不带实例序号（树形一变就无限重跑）；
 *   - 必须在渲染循环里**展开整棵树**（递归调用函数组件），否则子组件 effect 永不执行。
 *
 * 跑法：node test\smoke.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(here, '..', 'lib', 'client.js')
const HOST = join(here, '..', 'lib', 'index.js')

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
	if (condition) {
		passed += 1
		console.log(`  ✓ ${label}`)
		return
	}
	failed += 1
	failures.push(label)
	console.log(`  ✗ ${label}${detail === undefined ? '' : `  ← ${detail}`}`)
}

/* ==================== 迷你 React ==================== */

const instances = new Map()
let current = null
let dirty = false
let rootElement = null
let effectQueue = []

const isElement = (value) => value !== null && typeof value === 'object' && value.__el === true

function flatten(children, out) {
	for (const child of children) {
		if (Array.isArray(child)) flatten(child, out)
		else if (child === null || child === undefined || child === false || child === true) continue
		else out.push(child)
	}
	return out
}

function createElement(type, props, ...children) {
	const merged = { ...(props ?? {}) }
	const kids = flatten(children, [])
	if (kids.length > 0) merged.children = kids
	return { __el: true, type, props: merged }
}

/** 按路径取/建实例：hook 槽挂在实例上，不跨组件共用。 */
function instanceFor(path, type) {
	let instance = instances.get(path)
	if (instance === undefined || instance.type !== type) {
		instance = { type, path, hooks: [], cursor: 0 }
		instances.set(path, instance)
	}
	instance.cursor = 0
	return instance
}

function useState(initial) {
	const instance = current
	const index = instance.cursor++
	if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial
	const setState = (next) => {
		const value = typeof next === 'function' ? next(instance.hooks[index]) : next
		if (Object.is(value, instance.hooks[index])) return
		instance.hooks[index] = value
		dirty = true
	}
	return [instance.hooks[index], setState]
}

function useEffect(fn, deps) {
	const instance = current
	const index = instance.cursor++
	let entry = instance.hooks[index]
	const changed =
		entry === undefined ||
		deps === undefined ||
		entry.deps === undefined ||
		deps.length !== entry.deps.length ||
		deps.some((dep, i) => !Object.is(dep, entry.deps[i]))
	if (entry === undefined) {
		entry = { deps, cleanup: undefined, fn, changed: true }
		instance.hooks[index] = entry
	} else {
		entry.fn = fn
		entry.changed = changed
		if (changed) entry.deps = deps
	}
	// 去重键 = 组件类型 + hook 序号（不含实例序号）。
	effectQueue.push({ key: `${instance.type.name || 'anon'}#${index}`, entry })
}

function useMemo(fn, deps) {
	const instance = current
	const index = instance.cursor++
	let entry = instance.hooks[index]
	const changed =
		entry === undefined ||
		deps === undefined ||
		entry.deps === undefined ||
		deps.length !== entry.deps.length ||
		deps.some((dep, i) => !Object.is(dep, entry.deps[i]))
	if (changed) {
		entry = { deps, value: fn() }
		instance.hooks[index] = entry
	}
	return entry.value
}

function useCallback(fn, deps) {
	return useMemo(() => fn, deps)
}

function useRef(initial) {
	const instance = current
	const index = instance.cursor++
	if (!(index in instance.hooks)) instance.hooks[index] = { current: initial }
	return instance.hooks[index]
}

const miniReact = { createElement, useState, useEffect, useMemo, useCallback, useRef }

/* ==================== 渲染循环 ==================== */

/** 递归展开整棵树：函数组件就地调用，宿主元素留成节点。 */
function expand(node, path) {
	if (node === null || node === undefined || node === false || node === true) return null
	if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
	if (!isElement(node)) return { text: String(node) }
	if (typeof node.type === 'function') {
		const instance = instanceFor(path, node.type)
		const parent = current
		current = instance
		let out
		try {
			out = node.type({ ...node.props })
		} finally {
			current = parent
		}
		return expand(out, path)
	}
	const children = []
	const kids = node.props.children ?? []
	for (let i = 0; i < kids.length; i += 1) {
		const child = expand(kids[i], `${path}/${i}`)
		if (child !== null) children.push(child)
	}
	return { host: node.type, props: node.props, children }
}

function runEffects() {
	const seen = new Set()
	for (const { key, entry } of effectQueue) {
		if (seen.has(key)) continue
		seen.add(key)
		if (entry.changed !== true) continue
		if (typeof entry.cleanup === 'function') {
			try {
				entry.cleanup()
			} catch {
				/* 清理失败不影响断言 */
			}
		}
		const cleanup = entry.fn()
		entry.cleanup = typeof cleanup === 'function' ? cleanup : undefined
	}
}

/** 把树渲染到稳定：反复「展开 → 跑 effect → 让微任务落地」，直到没人再改状态。 */
async function settle(root, rounds = 12) {
	let tree = null
	for (let i = 0; i < rounds; i += 1) {
		effectQueue = []
		current = null
		tree = expand(root, 'root')
		runEffects()
		await new Promise((resolve) => setTimeout(resolve, 0))
		if (!dirty) return tree
		dirty = false
	}
	return tree
}

/* ==================== 树查询 ==================== */

function walk(node, visit) {
	if (node === null || node === undefined) return
	visit(node)
	for (const child of node.children ?? []) walk(child, visit)
}

function allText(tree) {
	let out = ''
	walk(tree, (node) => {
		if (typeof node.text === 'string') out += node.text
	})
	return out
}

function findAll(tree, predicate) {
	const found = []
	walk(tree, (node) => {
		if (node.host !== undefined && predicate(node)) found.push(node)
	})
	return found
}

const clickable = (tree, label) =>
	findAll(tree, (node) => node.host === 'button' && allText(node).includes(label) && typeof node.props.onClick === 'function')[0]

const inputByPlaceholder = (tree, fragment) =>
	findAll(tree, (node) => node.host === 'input' && String(node.props.placeholder ?? '').includes(fragment))[0]

/** 角标就是图标盒子上那个数字（没有待审时它整个不渲染）。 */
const badgeOf = (node) => findAll(node, (child) => typeof child.props?.['data-workbench-badge'] === 'string')[0]

/** 图标渲染时排掉的定时器数（后面数「自动检测」的定时器时要减掉它）。 */
let iconTimers = 0

/**
 * 左栏那枚面板图标是个座位组件，得在渲染树里跑（它自己带 hook）。
 * 这个壳子把当前注册的图标拿出来渲染——panelEntry 在注册那一段之后才赋值，
 * 这里只声明、不执行，所以顺序没问题。
 */
function IconHarness() {
	return createElement(panelEntry.component, { size: 18, active: false })
}

/* ==================== 桩数据 ==================== */

const SKILLS = [
	{ name: 'doc-iteration-control', description: '文档迭代的版本控制纪律：md 是源，docx/pdf 是产物', source: 'user-agents', provider: 'filesystem', path: 'C:\\Users\\me\\.agents\\skills\\doc-iteration-control', modelInvocable: true, userInvocable: true },
	{ name: 'book-to-skill', description: '把书与文档变成结构化技能', source: 'bundled', provider: 'filesystem', path: '', modelInvocable: true, userInvocable: true },
	{ name: 'cordis-plugin-development', description: '创建与调试动态 Cordis 插件', source: 'bundled', provider: 'filesystem', path: '', modelInvocable: true, userInvocable: false }
]

const DOCS = {
	dir: 'D:\\work\\thesis',
	exists: true,
	truncated: false,
	entries: [{ name: '03_第三章.md', stem: '03_第三章', ext: '.md', kind: 'source', bytes: 2048, bytesText: '2.0 KB', mtime: 1789000000000 }],
	counts: { stale: 1, orphan: 1, pending: 1, ok: 1 },
	pairs: [
		{
			stem: '03_第三章',
			state: 'stale',
			source: { name: '03_第三章.md', mtime: 1789000000000, bytes: 2048 },
			artifact: { name: '03_第三章.docx', mtime: 1788000000000, bytes: 40960 },
			lagMs: 1000000000
		},
		{ stem: '04_旧稿', state: 'orphan', source: null, artifact: { name: '04_旧稿.docx', mtime: 1788000000000, bytes: 1024 }, lagMs: 0 },
		{ stem: '05_新章', state: 'pending', source: { name: '05_新章.md', mtime: 1788900000000, bytes: 100 }, artifact: null, lagMs: 0 },
		{
			stem: '02_第二章',
			state: 'ok',
			source: { name: '02_第二章.md', mtime: 1788000000000, bytes: 100 },
			artifact: { name: '02_第二章.docx', mtime: 1788900000000, bytes: 100 },
			lagMs: 0
		}
	]
}

const requests = []
/** 审批状态存在桩里：POST /decide 之后再 GET /history 应该看得到变化。 */
const decisions = new Map()
const DEMO_DIR = 'C:\\demo\\thesis-workbench'

/** 桩的「一版正文」：旧版。 */
const TEXT_OLD = [
	{ kind: 'h1', text: '第三章 物料衡算' },
	{ kind: 'p', text: '乙苯转化率取 0.62，塔顶采出 1.2 t/h' },
	{ kind: 'p', text: '未改动甲' },
	{ kind: 'p', text: '未改动乙' },
	{ kind: 'p', text: '未改动丙' },
	{ kind: 'p', text: '未改动丁' },
	{ kind: 'p', text: '设备选型按老方案' },
	{ kind: 'h2', text: '本节小结' }
]
/** 桩的「一版正文」：新版——改了一个数、换了一段，中间四段一字未动。 */
const TEXT_NEW = TEXT_OLD.map((block, index) =>
	index === 1 ? { kind: 'p', text: '乙苯转化率取 0.58，塔顶采出 1.2 t/h' } : index === 6 ? { kind: 'p', text: '热量衡算表已重算' } : block
)
/** 桩的「一版正文」：和新版一字不差（脚本跑了但内容没变）。 */
const TEXT_SAME = TEXT_NEW.map((block) => ({ ...block }))
/** 桩的「读不出来的正文」（扩展名对、内容不是 zip）。 */
const TEXT_BROKEN = { ok: false, error: '这个 docx 里找不到 word/document.xml' }

/** 桩的两版表格：行结构一样，只有一个格子变了（0.58 → 0.61）、另一行整个换掉。 */
const TABLE_OLD = [
	{ kind: 'sheet', text: '物料衡算' },
	{ kind: 'row', text: '组分 | 进料 | 出料' },
	{ kind: 'row', text: '乙苯 | 1.2 | 0.44' },
	{ kind: 'row', text: '苯乙烯 | 0 | 0.58' },
	{ kind: 'sheet', text: '设备' },
	{ kind: 'row', text: '项目 | 数值' },
	{ kind: 'row', text: '塔径 | 1.2' }
]
const TABLE_NEW = [
	{ kind: 'sheet', text: '物料衡算' },
	{ kind: 'row', text: '组分 | 进料 | 出料' },
	{ kind: 'row', text: '乙苯 | 1.2 | 0.44' },
	{ kind: 'row', text: '苯乙烯 | 0 | 0.61' },
	{ kind: 'sheet', text: '设备' },
	{ kind: 'row', text: '项目 | 数值' },
	{ kind: 'row', text: '塔径 | 1.4' }
]
const TEXT_DOCS = {
	'.versions/20260910T1400-论文全文.docx': TEXT_OLD,
	'.versions/20260911T2210-论文全文.docx': TEXT_NEW,
	'.versions/20260912T1000-论文全文.docx': TEXT_OLD,
	'.versions/20260912T1600-论文全文.docx': TEXT_OLD,
	'.versions/20260913T1000-论文全文.docx': TEXT_SAME,
	'.versions/打不开的.docx': TEXT_BROKEN,
	'.versions/20260910T1400-衡算表.xlsx': TABLE_OLD,
	'.versions/20260911T2210-衡算表.xlsx': TABLE_NEW,
	'.versions/打不开的.xlsx': TEXT_BROKEN
}
/** 桩的 md 源（磁盘上只有一份，所以两轮读到的永远一样——这正是「比 md 源」不做的原因）。 */
const TEXT_SOURCES = { '03-第三章-物料衡算.md': [{ kind: 'h1', text: '第三章' }, { kind: 'p', text: '转化率 0.55' }] }

/**
 * 桩 DSH 的目录选择服务（`ctx.get('uiWorkspace')`）：
 * `nextPicked` 是下一次 `pickDirectory()` 的结果——字符串=选中，null=用户取消，
 * 'THROW'=原生选择器被宿主拒绝（本机就是这种：browse 后端）。
 */
const pickCalls = []
let nextPicked = null

/** 桩的目录树：原生不可用时，应用内浏览器用 `listDirectory` 列它。 */
const TREE = {
	'C:\\Users\\me': {
		path: 'C:\\Users\\me',
		home: 'C:\\Users\\me',
		crumbs: [
			{ name: 'C:', path: 'C:\\' },
			{ name: 'Users', path: 'C:\\Users' },
			{ name: 'me', path: 'C:\\Users\\me' }
		],
		entries: [
			{ name: 'work', path: 'C:\\Users\\me\\work', hidden: false },
			{ name: '.config', path: 'C:\\Users\\me\\.config', hidden: true }
		],
		truncated: false
	},
	'C:\\Users\\me\\work': {
		path: 'C:\\Users\\me\\work',
		home: 'C:\\Users\\me',
		crumbs: [
			{ name: 'C:', path: 'C:\\' },
			{ name: 'Users', path: 'C:\\Users' },
			{ name: 'me', path: 'C:\\Users\\me' },
			{ name: 'work', path: 'C:\\Users\\me\\work' }
		],
		entries: [{ name: 'thesis', path: 'C:\\Users\\me\\work\\thesis', hidden: false }],
		truncated: false
	}
}
const listCalls = []

/** 桩布局服务：只记 selectPanel 收到什么（null = 回会话界面）。 */
const panelSelections = []
const fakeLayout = {
	selectPanel(id) {
		panelSelections.push(id)
	}
}

const fakeUiWorkspace = {
	async pickDirectory() {
		pickCalls.push(nextPicked)
		if (nextPicked === 'THROW') throw new Error('directoryPicker.pick needs the native capability; the composed picker serves "browse"')
		return nextPicked
	},
	async listDirectory(target) {
		listCalls.push(target)
		const key = target === undefined ? 'C:\\Users\\me' : target
		if (TREE[key] === undefined) throw new Error(`没有这个目录：${key}`)
		return TREE[key]
	}
}

const ROUND_DEFS = [
	{
		id: '20260911T2210-毕业论文-3',
		at: 1789000200000,
		day: '2026-09-11',
		line: '毕业论文',
		artifact: '论文全文.docx',
		snapshot: '.versions/20260911T2210-论文全文.docx',
		kind: 'docx',
		bytes: 38000,
		bytesText: '37.1 KB',
		tool: 'python thesis_docx.py',
		by: 'dsh',
		summary: '第3章：修正乙苯转化率 0.62→0.58，重算全表',
		sources: [{ path: '03-第三章-物料衡算.md', note: '' }]
	},
	{
		id: '20260910T1400-毕业论文-2',
		at: 1788900000000,
		day: '2026-09-10',
		line: '毕业论文',
		artifact: '论文全文.docx',
		snapshot: '.versions/20260910T1400-论文全文.docx',
		kind: 'docx',
		bytes: 36000,
		bytesText: '35.2 KB',
		tool: 'python thesis_docx.py',
		by: 'dsh',
		summary: '第二章重写：按精馏/萃取/吸附重新组织文献',
		sources: [{ path: '02-第二章-文献综述.md', note: '' }]
	},
	{
		id: '20260909T0900-流程模拟-1',
		at: 1788800000000,
		day: '2026-09-09',
		line: 'Aspen流程模拟',
		artifact: '工艺流程图.pdf',
		snapshot: '.versions/20260909T0900-工艺流程图.pdf',
		kind: 'pdf',
		bytes: 180000,
		bytesText: '175.8 KB',
		tool: 'python export_pfd.py',
		by: 'dsh',
		summary: '补流程图导出脚本，PFD 自动出图',
		sources: [{ path: '流程说明.md', note: '' }]
	}
]

/**
 * 假定时器：真的 setInterval 会让 Node 挂着不退出，而且自动检测得能**手动触发**才测得准。
 * 组件排进来的每个定时器都收在这里，测试用 tickOnce() 手动跑一拍。
 */
const timers = new Set()
const fakeSetInterval = (fn, ms) => {
	const handle = { fn, ms }
	timers.add(handle)
	return handle
}
const fakeClearInterval = (handle) => {
	timers.delete(handle)
}
/** 手动跑一拍自动检测。 */
async function tickOnce() {
	for (const handle of [...timers]) await handle.fn()
}

/** 桩服务端的「后来又跑出来的记录」：测试中途往里塞，模拟产线目录里多了内容。 */
const extraRounds = []

/** 桩服务端的「还没进记录的产物」：/adopt 成功一条就从这里摘掉一条。 */
const UNRECORDED = [
	{
		line: '毕业论文',
		dir: '毕业论文',
		name: '论文全文.docx',
		kind: 'docx',
		bytes: 38000,
		bytesText: '37.1 KB',
		mtime: 1789000000000,
		tool: 'python thesis_docx.py --out 论文全文.docx',
		sources: ['03-第三章-物料衡算.md']
	},
	{
		line: '毕业论文',
		dir: '毕业论文',
		name: '会失败的.docx',
		kind: 'docx',
		bytes: 1000,
		bytesText: '1000 B',
		mtime: 1789000000000,
		tool: '',
		sources: []
	}
]

/** 测试里收到的收编请求。 */
const adopted = []

/** /scan 的响应体（按当前 UNRECORDED 现算）。 */
function scanBody() {
	const byLine = new Map()
	for (const entry of UNRECORDED) {
		const bucket = byLine.get(entry.line) ?? []
		bucket.push(entry)
		byLine.set(entry.line, bucket)
	}
	return {
		dir: DEMO_DIR,
		exists: true,
		windowHours: 48,
		provenance: { available: true, sessions: 2, events: 9 },
		totals: { products: UNRECORDED.length, lines: byLine.size },
		lines: [...byLine.entries()].map(([name, products]) => ({ name, products }))
	}
}

function historyBody() {
	const lines = new Map()
	for (const round of [...ROUND_DEFS, ...extraRounds]) {
		const state = decisions.get(round.id) ?? 'pending'
		const bucket = lines.get(round.line) ?? { name: round.line, rounds: [], counts: { pending: 0, approved: 0, rejected: 0 }, artifacts: [], kinds: [] }
		bucket.rounds.push({ ...round, approval: { state, at: 0, by: state === 'pending' ? '' : 'tester', note: '' } })
		bucket.counts[state] += 1
		if (!bucket.artifacts.includes(round.artifact)) bucket.artifacts.push(round.artifact)
		if (!bucket.kinds.includes(round.kind)) bucket.kinds.push(round.kind)
		bucket.days = [...new Set(bucket.rounds.map((r) => r.day))].sort().reverse()
		lines.set(round.line, bucket)
	}
	const list = [...lines.values()]
	// 真宿主是按时间新→旧排的，桩也得一样，否则「上一版」指不定是谁。
	for (const line of list) line.rounds.sort((a, b) => b.at - a.at)
	const totals = { rounds: ROUND_DEFS.length + extraRounds.length, pending: 0, approved: 0, rejected: 0, lines: list.length }
	for (const line of list) for (const key of ['pending', 'approved', 'rejected']) totals[key] += line.counts[key]
	return { dir: DEMO_DIR, exists: true, truncated: false, totals, lines: list }
}

async function fakeFetch(url, options) {	const method = options?.method ?? 'GET'
	requests.push(method === 'POST' ? `POST ${url} ${options.body}` : url)
	if (url.includes('/text?')) {
		const query = new URL(url, 'http://localhost').searchParams
		const file = query.get('file') ?? ''
		const blocks = TEXT_DOCS[file] ?? TEXT_SOURCES[file]
		if (blocks === undefined) return { status: 404, async text() { return JSON.stringify({ error: '文件不在原处了' }) } }
		const kind = /\.([^.]+)$/.exec(file)?.[1] ?? 'txt'
		return { status: 200, async text() { return JSON.stringify({ ok: blocks !== TEXT_BROKEN, file, kind, blocks: blocks === TEXT_BROKEN ? [] : blocks, truncated: false, ...(blocks === TEXT_BROKEN ? { error: TEXT_BROKEN.error } : {}) }) } }
	}
	if (method === 'POST' && url.includes('/decide')) {
		const payload = JSON.parse(options.body)
		if (!['approved', 'rejected', 'pending'].includes(payload.state)) return { status: 400, async text() { return JSON.stringify({ error: 'bad state' }) } }
		decisions.set(payload.id, payload.state)
		return { status: 200, async text() { return JSON.stringify({ ok: true, id: payload.id, state: payload.state }) } }
	}
	if (method === 'POST' && url.includes('/reveal')) {
		const payload = JSON.parse(options.body)
		return { status: 200, async text() { return JSON.stringify({ ok: true, mode: payload.mode, path: `C:\\demo\\${payload.line}\\${payload.file}` }) } }
	}
	if (method === 'POST' && url.includes('/scan')) {
		return { status: 200, async text() { return JSON.stringify(scanBody()) } }
	}
	if (method === 'POST' && url.includes('/adopt')) {
		const payload = JSON.parse(options.body)
		if (payload.file === '会失败的.docx') return { status: 409, async text() { return JSON.stringify({ error: '这一分钟已经收编过它' }) } }
		adopted.push(payload)
		const key = `${payload.line}/${payload.file}`
		const index = UNRECORDED.findIndex((entry) => `${entry.line}/${entry.name}` === key)
		if (index >= 0) UNRECORDED.splice(index, 1)
		return { status: 200, async text() { return JSON.stringify({ ok: true, id: 'adopted-1', snapshot: `.versions/20260919T2100-${payload.file}`, bytes: 38000 }) } }
	}
	let body
	if (url.includes('/demo')) body = { dir: DEMO_DIR, exists: true }
	else if (url.includes('/history?')) body = historyBody()
	else if (url.includes('/skills')) body = { complete: true, cwd: '', skills: SKILLS }
	else if (url.includes('/skill?')) body = { name: 'doc-iteration-control', content: '# 文档迭代控制\n\nMarkdown 是唯一的源。', path: 'C:\\Users\\me\\.agents\\skills\\doc-iteration-control\\SKILL.md' }
	else if (url.includes('/workspaces')) body = { workspaces: [{ id: 'w1', path: 'D:\\work\\my-project', title: 'my-project' }] }
	else if (url.includes('/docs?')) body = DOCS
	else body = { error: `未桩住的 URL：${url}` }
	return {
		status: 200,
		async text() {
			return JSON.stringify(body)
		}
	}
}

/* ==================== 载入 bundle ==================== */

console.log('dsh-workbench 自检\n')

const source = readFileSync(CLIENT, 'utf8')
const loaded = []
const fakeWindow = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } }
// 只用 new Function 注入 window / fetch：其余内置对象来自正常全局作用域。
// eslint-disable-next-line no-new-func
const run = new Function('window', 'fetch', 'setInterval', 'clearInterval', `${source}\n`)
run(fakeWindow, fakeFetch, fakeSetInterval, fakeClearInterval)

check('bundle 调用了 __ModuleLoader__.load', loaded.length === 1, `实际 ${loaded.length} 次`)
check('bundle id 等于包名', loaded[0]?.id === 'dsh-workbench', String(loaded[0]?.id))

const client = loaded[0].factory((name) => {
	if (name === 'react') return miniReact
	throw new Error(`未桩住的模块：${name}`)
})

check('导出 apply 与 inject', typeof client.apply === 'function' && Array.isArray(client.inject))
check('inject 声明了 slots', client.inject.includes('slots'))

/* ==================== 注册座位 ==================== */

const registrations = []
const tabRegistrations = []
/** 桩 better-sidebar 的客户端服务：registerTab + 它声明自己有 badge 能力。 */
const fakeBetterSidebar = {
	version: '0.19.1',
	features: ['badge', 'tabLifecycle', 'updateTab'],
	registerTab(descriptor) {
		tabRegistrations.push(descriptor)
		return () => {}
	}
}
/** 桩官方右栏服务（ctx.sidebarRight）：tabs.register + openTab。 */
const rightTabTypes = []
const rightOpens = []
const fakeSidebarRight = {
	tabs: {
		register(definition) {
			rightTabTypes.push(definition)
			return () => {}
		}
	},
	openTab(kind) {
		rightOpens.push(kind)
		if (rightTabTypes.length === 0) throw new Error('sidebarRight: no tab type is registered as ' + kind)
	}
}
const fakeCtx = {
	slots: {
		// 真运行时既接受普通函数，也接受生成器（后者可以 yield 多个注册）；
		// 右栏座位就是这么用的，桩必须跟着一样跑，否则生成器体根本不会执行。
		inject(name, factory) {
			const produced = factory()
			if (produced !== undefined && typeof produced.next === 'function') for (const step of produced) void step
			return () => {}
		},
		register(definition, component) {
			registrations.push({ definition, component })
			return () => {}
		}
	},
	get(name) {
		if (name === 'betterSidebar') return fakeBetterSidebar
		if (name === 'uiWorkspace') return fakeUiWorkspace
		if (name === 'layout') return fakeLayout
		if (name === 'sidebarRight') return fakeSidebarRight
		return undefined
	},
	effect(factory) {
		factory()
		return () => {}
	}
}
client.apply(fakeCtx)

const panelEntry = registrations.find((r) => r.definition.name === 'sidebar.panellist')
const mainEntry = registrations.find((r) => r.definition.name === 'main')
check('注册了 sidebar.panellist 图标', panelEntry !== undefined)
check('注册了 main 面板', mainEntry !== undefined)
check('两处 id 对应（侧栏图标 ↔ 主面板）', panelEntry?.definition.id === 'workbench' && mainEntry?.definition.key === 'workbench')

/* ==================== 双落点：better-sidebar 页签 ==================== */

check('同时注册了 better-sidebar 页签', tabRegistrations.length === 1, `实际 ${tabRegistrations.length}`)
check('页签 id 唯一且带包名前缀', tabRegistrations[0]?.id === 'dsh-workbench', String(tabRegistrations[0]?.id))
check('页签标题是中文「工作台」', tabRegistrations[0]?.title() === '工作台')
check('页签带一行说明（+ 菜单里会显示）', typeof tabRegistrations[0]?.description?.() === 'string' && tabRegistrations[0].description().length > 8)
check('页签声明单实例（不重复开）', tabRegistrations[0]?.single === true)
check('页签图标能渲染出 svg', typeof tabRegistrations[0]?.icon === 'function' && expand(createElement(tabRegistrations[0].icon, { size: 16 }), 'tabicon').host === 'svg')
check('页签组件就是工作台面板', tabRegistrations[0]?.component === client.__internals.WorkbenchPanel)
check('better-sidebar 声明了 badge 能力时报上「待我审」', typeof tabRegistrations[0]?.badge === 'function')
client.__internals.__debugReportPending(7, DEMO_DIR)
check('页签角标跟着面板的数走', tabRegistrations[0]?.badge() === 7, String(tabRegistrations[0]?.badge?.()))
client.__internals.__debugReportPending(0, '')
check('没有待审时页签角标返回 null（不画 0）', tabRegistrations[0]?.badge() === null, String(tabRegistrations[0]?.badge?.()))

/* ==================== 第三个落点：官方右栏页签 ==================== */

const rightSeat = registrations.find((r) => r.definition.name === 'sidebar.right.pane.tab')
check('注册了右栏页签类型', rightTabTypes.length === 1, `实际 ${rightTabTypes.length}`)
check('右栏类型的 kind 与座位一致', rightTabTypes[0]?.kind === client.__internals.RIGHT_TAB_KIND && rightSeat?.definition.id === 'dsh-workbench', `${rightTabTypes[0]?.kind} / ${rightSeat?.definition.id}`)
check('右栏类型声明为外部扩展（不抢别人的 kind）', rightTabTypes[0]?.priority === 'extension')
check('右栏页签标题是中文「工作台」', rightTabTypes[0]?.title?.() === '工作台')
check('右栏类型带引导卡片（右栏「+」里能找到它）', Array.isArray(rightTabTypes[0]?.guide) && rightTabTypes[0].guide[0]?.title() === '工作台')
check('右栏引导卡片的图标能渲染出 svg', expand(createElement(rightTabTypes[0].guide[0].icon, { size: 16 }), 'guideicon').host === 'svg')

// 正文是同一个面板（只是标记了「已经在右栏」，好把那枚按钮收起来）
const rightBodyTree = await settle(createElement(rightSeat.component, {}))
check('右栏正文渲染的就是工作台', allText(rightBodyTree).includes('工作台') && allText(rightBodyTree).includes('迭代'))
check('已经在右栏时不再显示「搬到右栏」', clickable(rightBodyTree, '搬到右栏') === undefined)

// 主区域那份要有这枚按钮，点了会请宿主把工作台开在右栏
const mainTree = await settle(createElement(mainEntry.component, {}))
const dockButton = clickable(mainTree, '搬到右栏')
check('主区域面板上有「搬到右栏」', dockButton !== undefined)
check('按钮悬停说明写清了它做什么', String(dockButton?.props?.title).includes('一边看对话'))
if (dockButton !== undefined) dockButton.props.onClick()
check('点击后请宿主把工作台开在右栏', rightOpens.length === 1 && rightOpens[0] === client.__internals.RIGHT_TAB_KIND, JSON.stringify(rightOpens))
check('搬过去之后按钮仍在（面板状态不变，对话不再被挤走）', clickable(mainTree, '搬到右栏') !== undefined)

// 宿主没有右栏服务时：不注册、不报错、也不放这个按钮
const noRightRegistrations = []
const noRightCtx = {
	slots: {
		inject(name, factory) {
			factory()
			return () => {}
		},
		register(definition, component) {
			noRightRegistrations.push({ definition, component })
			return () => {}
		}
	},
	get() {
		return undefined
	},
	effect(factory) {
		factory()
		return () => {}
	}
}
client.apply(noRightCtx)
check('没有右栏服务时不注册右栏座位', noRightRegistrations.every((r) => r.definition.name !== 'sidebar.right.pane.tab'))
check('没有右栏服务时官方两处座位照常', noRightRegistrations.some((r) => r.definition.name === 'sidebar.panellist') && noRightRegistrations.some((r) => r.definition.name === 'main'))
check('没有右栏服务时 registerRightColumn 如实回报', client.__internals.registerRightColumn(noRightCtx) === 'no-service')
check('没有右栏服务时 openInRightColumn 如实返回 false', client.__internals.openInRightColumn() === false)

// 换回带全部服务的上下文（rootContext 是模块级的，后 apply 的覆盖先前那份）
client.apply(fakeCtx)

// 没装 better-sidebar 时：不报错、官方两处座位照常
const bareRegistrations = []
const bareCtx = {
	slots: {
		inject(name, factory) {
			factory()
			return () => {}
		},
		register(definition, component) {
			bareRegistrations.push({ definition, component })
			return () => {}
		}
	},
	get() {
		return undefined
	},
	effect(factory) {
		factory()
		return () => {}
	}
}
let bareThrew = false
try {
	client.apply(bareCtx)
} catch {
	bareThrew = true
}
check('没装 better-sidebar 时不报错', bareThrew === false)
check('没装时官方两处座位照常注册', bareRegistrations.length === 2)
check('图标标签可读', panelEntry?.definition.label() === '工作台')

// 没有目录选择服务时的降级：给一句可读提示，而不是抛异常（此刻的 rootContext 是 bareCtx）
const noChooser = await client.__internals.pickDirectory()
check('没有目录选择服务时降级为「手动填路径」', noChooser.path === null && noChooser.error.includes('没有可用的目录选择器'))

// 两条路都走不通时（没有 uiWorkspace）不能去开浏览器，得回一句可读原因
const noRoute = await client.__internals.chooseDirectory()
check('两条路都不通时返回可读原因', typeof noRoute.error === 'string' && noRoute.open === undefined && noRoute.path === undefined, JSON.stringify(noRoute))

// 没有布局服务时：不渲染「返回对话」（点了也没用），函数也如实说没切
const barePanel = bareRegistrations.find((r) => r.definition.name === 'main')
const bareTree = await settle(createElement(barePanel.component, {}))
check('没有布局服务时不显示「返回对话」', !allText(bareTree).includes('返回对话'))
check('没有布局服务时 backToConversation 如实返回 false', client.__internals.backToConversation() === false)

// 换回带服务的那份上下文：rootContext 是模块级的，后 apply 的覆盖先前那份。
client.apply(fakeCtx)

const iconTree = await settle(createElement(IconHarness, {}))
check('图标渲染出 svg', findAll(iconTree, (node) => node.host === 'svg').length > 0)
check('图标有中文 aria-label', findAll(iconTree, (node) => node.host === 'svg')[0]?.props?.['aria-label'] === '工作台')
// 这一下渲染会把角标的轮询排上（图标自己带的 effect），下面「自动检测」那一段数定时器时先减掉它
iconTimers = timers.size
check('图标自己也排了一个「待我审」的轮询', iconTimers >= 1, `实际 ${iconTimers}`)

/* ==================== 迭代页（默认打开） ==================== */

const Panel = mainEntry.component
let tree = await settle(createElement(Panel, {}))

check('默认打开迭代页', allText(tree).includes('载入演示'))
check('提示说明工作模式', allText(tree).includes('你审没审') || allText(tree).includes('AI 改 md'))

/* ==================== 返回对话 ==================== */

const backButton = clickable(tree, '返回对话')
check('面板顶部有「返回对话」按钮', backButton !== undefined)
check('按钮说明写清了它做什么', typeof backButton?.props.title === 'string' && backButton.props.title.includes('会话不变'))
backButton.props.onClick()
check('点击后请布局服务把中央区域切回会话', panelSelections.length === 1 && panelSelections[0] === null, JSON.stringify(panelSelections))

/* ==================== 上一步 / 下一步（面板里的浏览历史） ==================== */

/** 按悬停说明找两个步进按钮（它们只标着箭头，靠 title 认）。 */
const stepBy = (label) =>
	findAll(tree, (node) => node.host === 'button' && typeof node.props.title === 'string' && node.props.title.startsWith(label))[0]

check('一开始「上一步」是灰的（没走过路）', stepBy('上一步')?.props.disabled === true)
check('一开始「下一步」也是灰的', stepBy('下一步')?.props.disabled === true)

// 外观：不是 12px 的文字箭头，是画出来的 chevron + 方形按钮
const backIcon = findAll(tree, (node) => node.host === 'svg' && node.props['aria-label'] === '上一步')[0]
check('上一步是 svg 图标而不是文字箭头', backIcon !== undefined)
check('图标够大（≥16px）', Number(backIcon?.props.width) >= 16, String(backIcon?.props.width))
check('按钮是 28×28 的方形', stepBy('上一步')?.props.style.width === '28px' && stepBy('上一步')?.props.style.height === '28px')
check('灰掉时半透明', Number(stepBy('上一步')?.props.style.opacity) < 1)

// 第 1 步：切到技能库
clickable(tree, '技能库').props.onClick()
tree = await settle(createElement(Panel, {}))
check('切页签记了一步', stepBy('上一步')?.props.disabled === false)
check('悬停说明报出剩余步数', stepBy('上一步')?.props.title.includes('还能退 1 步'))

// 可点的时候，悬停要有底色反馈
stepBy('上一步').props.onMouseEnter()
tree = await settle(createElement(Panel, {}))
check('悬停时按钮浮起来（底色变 raised）', String(stepBy('上一步')?.props.style.background).includes('layer-2'), String(stepBy('上一步')?.props.style.background))
stepBy('上一步').props.onMouseLeave()
tree = await settle(createElement(Panel, {}))
check('移开后底色落回去', !String(stepBy('上一步')?.props.style.background).includes('layer-2'))

// 第 2 步：打开一个技能
const histSkillRow = findAll(tree, (node) => node.host === 'div' && allText(node).includes('doc-iteration-control') && typeof node.props.onClick === 'function')[0]
histSkillRow.props.onClick()
tree = await settle(createElement(Panel, {}))
check('打开技能又记一步', stepBy('上一步')?.props.title.includes('还能退 2 步'))

// 退两步：技能全文收起 → 回到迭代页
stepBy('上一步').props.onClick()
tree = await settle(createElement(Panel, {}))
check('退一步：技能全文收起来了', !allText(tree).includes('Markdown 是唯一的源'))
check('退一步后「下一步」亮了', stepBy('下一步')?.props.disabled === false)
stepBy('上一步').props.onClick()
tree = await settle(createElement(Panel, {}))
check('再退一步：回到迭代页', allText(tree).includes('载入演示'))
check('退到底后「上一步」又灰了', stepBy('上一步')?.props.disabled === true)

// 进两步：回到「技能库 + 那个技能开着」
stepBy('下一步').props.onClick()
tree = await settle(createElement(Panel, {}))
check('前进一步：回到技能库（技能还没开）', !allText(tree).includes('Markdown 是唯一的源'))
stepBy('下一步').props.onClick()
tree = await settle(createElement(Panel, {}))
check('再前进一步：技能又是打开状态', allText(tree).includes('Markdown 是唯一的源'))
check('走到头后「下一步」又灰了', stepBy('下一步')?.props.disabled === true)

// 退回去之后做新动作 → 「下一步」那条线要被清掉
stepBy('上一步').props.onClick()
tree = await settle(createElement(Panel, {}))
check('退回去之后「下一步」可用', stepBy('下一步')?.props.disabled === false)
clickable(tree, '迭代').props.onClick()
tree = await settle(createElement(Panel, {}))
check('走了新的一步后「下一步」被清掉', stepBy('下一步')?.props.disabled === true)
check('而「上一步」还能继续退', stepBy('上一步')?.props.disabled === false)

const demoButton = clickable(tree, '载入演示')
check('找到「载入演示」按钮', demoButton !== undefined)
demoButton.props.onClick()
tree = await settle(createElement(Panel, {}))
check('取了演示目录', requests.some((url) => url.includes('/demo')))
check('按目录拉了历史', requests.some((url) => url.includes('/history?dir=')))
check('渲染出产线分组', allText(tree).includes('毕业论文') && allText(tree).includes('Aspen流程模拟'))
check('渲染出轮次摘要', allText(tree).includes('修正乙苯转化率'))
check('渲染出按天小节', allText(tree).includes('2026-09-11'))
check('显示审批状态徽章', allText(tree).includes('待我审'))

// 悬停 → 摘要卡
const hoverRow = findAll(tree, (node) => node.host === 'div' && allText(node).includes('修正乙苯转化率') && typeof node.props.onMouseEnter === 'function')[0]
check('轮次行可悬停', hoverRow !== undefined)
hoverRow.props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({ top: 120, right: 260 }) } })
tree = await settle(createElement(Panel, {}))
check('悬停出现摘要卡', allText(tree).includes('快照：') && allText(tree).includes('python thesis_docx.py'))
check('摘要卡带改动来源', allText(tree).includes('03-第三章-物料衡算.md'))

// 点击 → 审批
const pickRow = findAll(tree, (node) => node.host === 'div' && allText(node).includes('修正乙苯转化率') && typeof node.props.onClick === 'function')[0]
check('轮次行可点击', pickRow !== undefined)
pickRow.props.onClick()
tree = await settle(createElement(Panel, {}))
const approve = clickable(tree, '通过')
check('出现「通过」按钮', approve !== undefined)

/* ==================== 打开这一版 / 打开成品 / 在文件夹里 ==================== */

const revealCalls = () => requests.filter((r) => r.startsWith('POST') && r.includes('/reveal'))

check('选中一轮后有「打开这一版」', clickable(tree, '打开这一版') !== undefined)
check('也有「打开成品」和「在文件夹里」', clickable(tree, '打开成品') !== undefined && clickable(tree, '在文件夹里') !== undefined)

clickable(tree, '打开这一版').props.onClick()
tree = await settle(createElement(Panel, {}))
check('「打开这一版」把快照路径交给宿主', revealCalls().some((r) => r.includes('.versions/20260911T2210-论文全文.docx')), revealCalls()[0])
check('「打开这一版」是 open 模式', revealCalls().some((r) => r.includes('"mode":"open"')))

clickable(tree, '打开成品').props.onClick()
tree = await settle(createElement(Panel, {}))
check('「打开成品」交的是工作副本文件名', revealCalls().some((r) => r.includes('"file":"论文全文.docx"')))

clickable(tree, '在文件夹里').props.onClick()
tree = await settle(createElement(Panel, {}))
check('「在文件夹里」用 reveal 模式', revealCalls().some((r) => r.includes('"mode":"reveal"')))
check('三次都带着产线名', revealCalls().every((r) => r.includes('"line":"毕业论文"')))
check('打开动作不改动审批状态', !requests.some((r) => r.startsWith('POST') && r.includes('/decide') && r.includes('"state":"pending"')))

approve.props.onClick()
tree = await settle(createElement(Panel, {}))
check('发出了审批写请求', requests.some((r) => r.startsWith('POST') && r.includes('/decide') && r.includes('"state":"approved"')))
check('写完后重新拉取历史', requests.filter((url) => url.includes('/history?dir=')).length >= 2)
check('该轮变成「已通过」', allText(tree).includes('已通过'))

/* ==================== 目录里多了内容：自动检测 + 手动刷新 ==================== */

// 角标的轮询跟着图标一起排上（上面已渲染过图标），所以这里一共两个定时器：
// 一个是「待我审」角标，一个是本页的「目录有没有新东西」。
check('目录行有自动档位按钮（默认 10 秒）', clickable(tree, '自动：10 秒') !== undefined)
check('自动检测已排上定时器（角标那个 + 这一个）', timers.size === iconTimers + 1, `实际 ${timers.size}`)

// 服务端多了一条记录 → 探一拍只该给提示，不该自己跳屏
extraRounds.push({
	id: '20260912T1000-毕业论文-4',
	at: 1789100000000,
	day: '2026-09-12',
	line: '毕业论文',
	artifact: '论文全文.docx',
	snapshot: '.versions/20260912T1000-论文全文.docx',
	kind: 'docx',
	bytes: 39000,
	bytesText: '38.1 KB',
	tool: 'python thesis_docx.py',
	by: 'dsh',
	summary: '第4章：补设备选型对比表',
	sources: [{ path: '04-第四章-设备选型.md', note: '' }]
})
await tickOnce()
tree = await settle(createElement(Panel, {}))
check('探到新记录后给出提示', allText(tree).includes('多了 1 轮'))
check('提示不擅自改屏幕（那一轮还没进来）', !allText(tree).includes('补设备选型对比表'))

// 「稍后」：收起提示，同一批变化不再重复打扰
clickable(tree, '稍后').props.onClick()
tree = await settle(createElement(Panel, {}))
check('点「稍后」提示收起', !allText(tree).includes('多了 1 轮'))
await tickOnce()
tree = await settle(createElement(Panel, {}))
check('内容没再变就不重复提醒', !allText(tree).includes('多了 1 轮'))

// 再变一次 → 又要提醒
extraRounds.push({
	id: '20260912T1600-毕业论文-5',
	at: 1789120000000,
	day: '2026-09-12',
	line: '毕业论文',
	artifact: '论文全文.docx',
	snapshot: '.versions/20260912T1600-论文全文.docx',
	kind: 'docx',
	bytes: 39500,
	bytesText: '38.6 KB',
	tool: 'python thesis_docx.py',
	by: 'dsh',
	summary: '第5章：补经济分析敏感性',
	sources: [{ path: '05-第五章-经济分析.md', note: '' }]
})
await tickOnce()
tree = await settle(createElement(Panel, {}))
check('内容再变一次又会提醒（按屏幕上的内容算，所以是 2 轮）', allText(tree).includes('多了 2 轮'))

// 「现在刷新」→ 提示消失、新记录进时间轴
clickable(tree, '现在刷新').props.onClick()
tree = await settle(createElement(Panel, {}))
check('刷新后提示消失', !allText(tree).includes('多了 1 轮'))
check('刷新后新记录出现在时间轴上', allText(tree).includes('补经济分析敏感性'))
await tickOnce()
tree = await settle(createElement(Panel, {}))
check('刷新完不会再报同一批变化', !allText(tree).includes('多了 '))

// 档位循环：10 秒 → 30 秒 → 1 分钟 → 关
clickable(tree, '自动：10 秒').props.onClick()
tree = await settle(createElement(Panel, {}))
check('档位切到 30 秒', clickable(tree, '自动：30 秒') !== undefined)
clickable(tree, '自动：30 秒').props.onClick()
tree = await settle(createElement(Panel, {}))
clickable(tree, '自动：1 分钟').props.onClick()
tree = await settle(createElement(Panel, {}))
check('一直点可以关掉自动', clickable(tree, '自动：关') !== undefined)
check('关掉之后本页不再排定时器（只剩角标那个）', timers.size === iconTimers, `实际 ${timers.size}`)

/* ==================== 还没进记录的产物（/scan + /adopt） ==================== */

const scanCalls = () => requests.filter((r) => r.startsWith('POST') && r.includes('/scan'))
const adoptCalls = () => requests.filter((r) => r.startsWith('POST') && r.includes('/adopt'))

check('默认不扫（不给时间轴添乱）', scanCalls().length === 0)
const openAdopt = clickable(tree, '未入记录')
check('顶栏有「未入记录」按钮', openAdopt !== undefined)
openAdopt.props.onClick()
tree = await settle(createElement(Panel, {}))
check('展开后扫了一次', scanCalls().length === 1, `实际 ${scanCalls().length}`)
check('列出没进记录的产物', allText(tree).includes('还没进记录的产物') && allText(tree).includes('论文全文.docx'))
check('显示生成方式', allText(tree).includes('python thesis_docx.py --out 论文全文.docx'))
check('显示改过的源', allText(tree).includes('03-第三章-物料衡算.md'))
check('没找到生成命令时如实说', allText(tree).includes('没找到生成命令'))

const noteInput = inputByPlaceholder(tree, '这一版改了什么')
check('每一行都有「这一版改了什么」输入框', noteInput !== undefined)
noteInput.props.onChange({ target: { value: '第3章：修正乙苯转化率' } })
tree = await settle(createElement(Panel, {}))

const recordButton = findAll(tree, (node) => node.host === 'button' && node.props.title !== undefined && allText(node).includes('记一版'))[0]
check('能找到「记一版」按钮', recordButton !== undefined)
check('按钮悬停说明写清了它会写什么', String(recordButton?.props.title).includes('produced.jsonl'))
recordButton.props.onClick()
tree = await settle(createElement(Panel, {}))
check('发出了收编请求', adoptCalls().length === 1, `实际 ${adoptCalls().length}`)
check('请求带着产线与文件名', adoptCalls()[0].includes('"line":"毕业论文"') && adoptCalls()[0].includes('"file":"论文全文.docx"'))
check('请求带着那句备注', adoptCalls()[0].includes('第3章：修正乙苯转化率'))
check('请求带着找到的生成命令与来源', adoptCalls()[0].includes('thesis_docx.py') && adoptCalls()[0].includes('03-第三章-物料衡算.md'))
check('收编成功后提示快照路径', allText(tree).includes('已收编 1 个') && allText(tree).includes('.versions/20260919T2100-论文全文.docx'))
check('收编后重新扫了一遍', scanCalls().length === 2, `实际 ${scanCalls().length}`)
check('收编过的那条从清单里消失', !allText(tree).includes('生成方式：python thesis_docx.py'))
check('时间轴也跟着刷新了', requests.filter((url) => url.includes('/history?dir=')).length >= 2)

// 失败要如实说，不能默默装作成功
const failing = findAll(tree, (node) => node.host === 'button' && allText(node).includes('记一版')).slice(-1)[0]
failing.props.onClick()
tree = await settle(createElement(Panel, {}))
check('收编失败时把原因显示出来', allText(tree).includes('这一分钟已经收编过它'))
check('失败时不清空清单', allText(tree).includes('会失败的.docx'))

clickable(tree, '收起').props.onClick()
tree = await settle(createElement(Panel, {}))
check('能收起这一块', !allText(tree).includes('还没进记录的产物'))
check('收起后不会再扫', scanCalls().length === 2, `实际 ${scanCalls().length}`)

/* ==================== 左栏图标上的「待我审」角标 ==================== */

/**
 * 面板与图标在同一棵树里渲染：它们是模块级单例，分开渲染会互相打断 effect，
 * 而且角标本来就是「面板报数 → 图标画数字」这条线，同屏才验得到。
 */
function PanelAndIcon() {
	return createElement('div', null, createElement(WorkbenchPanelStub, {}), createElement(IconHarness, {}))
}
/** 面板本体（就是主座位注册的那个组件）。 */
const WorkbenchPanelStub = mainEntry.component

// 角标上该是几：把桩数据按同一口径数一遍（自动检测那一段往 extraRounds 里加过两条）
const pendingNow = [...ROUND_DEFS, ...extraRounds].filter((round) => (decisions.get(round.id) ?? 'pending') === 'pending').length
const bothTree = await settle(createElement(PanelAndIcon, {}))
check('面板与图标同屏：角标出现', badgeOf(bothTree) !== undefined)
check('角标上的数字就是面板算出的待审轮数', badgeOf(bothTree)?.props?.['data-workbench-badge'] === String(pendingNow), `角标 ${badgeOf(bothTree)?.props?.['data-workbench-badge']} ｜ 实际 ${pendingNow}`)
check('角标悬停说明写清是哪个目录', String(badgeOf(bothTree)?.props?.title).includes('待你审') && String(badgeOf(bothTree)?.props?.title).includes('thesis-workbench'), String(badgeOf(bothTree)?.props?.title))

// 数字太大时收成 99+，不然角标会撑到图标外面去
client.__internals.__debugReportPending(137, DEMO_DIR)
const manyTree = await settle(createElement(IconHarness, {}))
check('数字超过 99 收成 99+', badgeOf(manyTree)?.props?.['data-workbench-badge'] === '137' && allText(manyTree).includes('99+'), allText(manyTree))

client.__internals.__debugReportPending(0, '')
const clearTree = await settle(createElement(IconHarness, {}))
check('没有待审时角标整个不渲染（不会画一个 0）', badgeOf(clearTree) === undefined, `实际 ${badgeOf(clearTree)?.props?.['data-workbench-badge']}`)

// 收尾：把页签切回迭代页（面板状态是模块级单例，不切回去后面几段会踩空）
tree = await settle(createElement(WorkbenchPanelStub, {}))
clickable(tree, '迭代').props.onClick()
tree = await settle(createElement(WorkbenchPanelStub, {}))

/* ==================== 技能库页 ==================== */
const skillsTab = clickable(tree, '技能库')
check('找到「技能库」页签', skillsTab !== undefined)
skillsTab.props.onClick()
tree = await settle(createElement(Panel, {}))

check('技能目录已拉取', requests.some((url) => url.includes('/skills')))
check('列出全部三个技能', ['doc-iteration-control', 'book-to-skill', 'cordis-plugin-development'].every((name) => allText(tree).includes(name)))
check('显示来源徽章', allText(tree).includes('用户 · .agents') && allText(tree).includes('内置'))
check('提示文案说明目录来源', allText(tree).includes('模型实际会加载的那份技能目录'))

// 搜索
const search = inputByPlaceholder(tree, '搜索技能名')
check('找到搜索框', search !== undefined)
search.props.onChange({ target: { value: 'doc' } })
tree = await settle(createElement(Panel, {}))
check('搜索 doc 后只剩一个技能', allText(tree).includes('doc-iteration-control') && !allText(tree).includes('book-to-skill'))

// 点开全文
const row = findAll(tree, (node) => node.host === 'div' && allText(node).includes('doc-iteration-control') && typeof node.props.onClick === 'function')[0]
check('技能行可点击', row !== undefined)
row.props.onClick()
tree = await settle(createElement(Panel, {}))
check('拉取了技能全文', requests.some((url) => url.includes('/skill?name=doc-iteration-control')))
check('渲染出 SKILL.md 正文', allText(tree).includes('Markdown 是唯一的源'))
check('显示技能路径', allText(tree).includes('SKILL.md'))

/* ==================== 文档页 ==================== */

const docsTab = clickable(tree, '文档')
check('找到「文档」页签', docsTab !== undefined)
docsTab.props.onClick()
tree = await settle(createElement(Panel, {}))
check('切到文档页', allText(tree).includes('源与产物的配对状态'))
check('拉取了工作区列表', requests.some((url) => url.includes('/workspaces')))
check('列出已登记工作区', allText(tree).includes('my-project'))

const workspaceChip = findAll(tree, (node) => node.host === 'span' && allText(node).includes('my-project') && typeof node.props.onClick === 'function')[0]
check('工作区徽章可点击', workspaceChip !== undefined)
workspaceChip.props.onClick()
tree = await settle(createElement(Panel, {}))

check('扫描请求带上目录', requests.some((url) => url.includes('/docs?dir=') && url.includes('my-project')))
const text = allText(tree)
check('统计徽章出现', text.includes('过期 1') && text.includes('无源产物 1') && text.includes('已同步 1'))
check('过期配对显示为「产物过期」', text.includes('产物过期'))
check('孤儿配对显示为「无源产物」', text.includes('无源产物'))
check('未生成配对显示为「未生成产物」', text.includes('未生成产物'))

// 顺序：过期必须排第一
const ordered = findAll(tree, (node) => node.host === 'div' && typeof node.props.title === 'string' && node.props.title.includes('产物比源旧'))
check('过期项排在最前（先看该处理的）', ordered.length === 1 && allText(ordered[0]).includes('03_第三章'))

/* ==================== 系统目录选择（浏览…） ==================== */

// 文档页：选中一个目录 → 立刻扫它
nextPicked = 'D:\\work\\picked-by-dialog'
const docsBrowse = clickable(tree, '浏览…')
check('文档页有「浏览…」按钮', docsBrowse !== undefined)
check('「浏览…」按钮带说明（悬停可读）', docsBrowse?.props.title === '打开系统文件夹选择框')
await docsBrowse.props.onClick()
tree = await settle(createElement(Panel, {}))
check('调用了 DSH 的目录选择服务', pickCalls.length === 1, `实际 ${pickCalls.length} 次`)
check('选中后直接扫描该目录', requests.some((url) => url.includes('/docs?dir=') && url.includes('picked-by-dialog')))

// 取消 → 什么都不做
nextPicked = null
const beforeCancel = requests.length
await clickable(tree, '浏览…').props.onClick()
tree = await settle(createElement(Panel, {}))
check('取消选择不发请求、不改目录', requests.length === beforeCancel)

// 原生选择器被宿主拒绝（本机就是 browse 组合）→ 自动改用应用内目录浏览器
nextPicked = 'THROW'
await clickable(tree, '浏览…').props.onClick()
tree = await settle(createElement(Panel, {}))
check('原生选择器不可用时改开应用内浏览器', allText(tree).includes('选一个文件夹'))
check('浏览器从宿主主目录开始', listCalls.length === 1 && listCalls[0] === undefined, `实际 ${JSON.stringify(listCalls)}`)
check('列出主目录里的子文件夹（含隐藏）', allText(tree).includes('work') && allText(tree).includes('.config'))

const workRow = findAll(tree, (node) => node.host === 'div' && node.props.title === 'C:\\Users\\me\\work')[0]
check('子文件夹行可点', workRow !== undefined)
workRow.props.onClick()
tree = await settle(createElement(Panel, {}))
check('进入子目录后列出下一层', allText(tree).includes('thesis'))
check('面包屑显示完整层级', allText(tree).includes('Users'))

clickable(tree, '选这个文件夹').props.onClick()
tree = await settle(createElement(Panel, {}))
check('采纳后按该目录扫描', requests.some((url) => url.includes('/docs?dir=') && url.includes('work')))
check('采纳后对话框关闭', !allText(tree).includes('选一个文件夹'))

// 迭代页同样有
clickable(tree, '迭代').props.onClick()
tree = await settle(createElement(Panel, {}))
nextPicked = 'D:\\work\\thesis-picked'
const iterBrowse = clickable(tree, '浏览…')
check('迭代页也有「浏览…」按钮', iterBrowse !== undefined)
await iterBrowse.props.onClick()
tree = await settle(createElement(Panel, {}))
check('迭代页浏览选中后读取该目录', requests.some((url) => url.includes('/history?dir=') && url.includes('thesis-picked')))

// 迭代页同样能降级到应用内浏览器，也能取消
nextPicked = 'THROW'
await clickable(tree, '浏览…').props.onClick()
tree = await settle(createElement(Panel, {}))
check('迭代页也能降级到应用内浏览器', allText(tree).includes('选一个文件夹'))
clickable(tree, '取消').props.onClick()
tree = await settle(createElement(Panel, {}))
check('取消后对话框关闭', !allText(tree).includes('选一个文件夹'))

/* ==================== 和上一版比：两版正文的差异 ==================== */

// 再造两轮，好让「毕业论文」这条产线多两版可以互相比
extraRounds.push({
	id: '20260913T1000-毕业论文-5',
	at: 1789200000000,
	day: '2026-09-12',
	line: '毕业论文',
	artifact: '论文全文.docx',
	snapshot: '.versions/20260913T1000-论文全文.docx',
	kind: 'docx',
	bytes: 39000,
	bytesText: '38.1 KB',
	tool: 'python thesis_docx.py',
	by: 'dsh',
	summary: '重跑一遍，内容没动',
	sources: [{ path: '03-第三章-物料衡算.md', note: '' }]
})
extraRounds.push({
	id: '20260914T1000-毕业论文-6',
	at: 1789300000000,
	day: '2026-09-13',
	line: '毕业论文',
	artifact: '论文全文.docx',
	snapshot: '.versions/打不开的.docx',
	kind: 'docx',
	bytes: 39000,
	bytesText: '38.1 KB',
	tool: 'python thesis_docx.py',
	by: 'dsh',
	summary: '这一版的快照读不出来',
	sources: [{ path: '03-第三章-物料衡算.md', note: '' }]
})

clickable(tree, '迭代').props.onClick()
tree = await settle(createElement(Panel, {}))
clickable(tree, '读取').props.onClick()
tree = await settle(createElement(Panel, {}))
check('新加的两轮进时间轴了', allText(tree).includes('重跑一遍，内容没动') && allText(tree).includes('这一版的快照读不出来'))

const textCalls = () => requests.filter((url) => url.includes('/text?'))
/** 时间轴上某一轮的行（按它的摘要认）。 */
const roundRow = (summary) => findAll(tree, (node) => node.host === 'div' && allText(node).includes(summary) && typeof node.props.onClick === 'function')[0]

// ① 最新一轮的「快照」读不出 → 如实说，不编
roundRow('这一版的快照读不出来').props.onClick()
tree = await settle(createElement(Panel, {}))
const diffButton = clickable(tree, '和上一版比')
check('选中一轮后有「和上一版比」', diffButton !== undefined)
check('按钮说明写清了它做什么', String(diffButton?.props.title).includes('一段一段标出来'))
check('有上一版可比（按钮不是灰的）', diffButton?.props.disabled === false)
diffButton.props.onClick()
tree = await settle(createElement(Panel, {}))
check('点了之后去读两版正文', textCalls().length === 2, JSON.stringify(textCalls()))
check('读的是这一轮和上一轮的快照', textCalls().some((url) => url.includes('%E6%89%93%E4%B8%8D%E5%BC%80%E7%9A%84')) && textCalls().some((url) => url.includes('20260913T1000')), JSON.stringify(textCalls()))
check('两版都带着产线名', textCalls().every((url) => url.includes('line=')))
check('时间轴让位给对比视图', !allText(tree).includes('补经济分析敏感性'))
check('读不出正文时把原因摆出来', allText(tree).includes('读不到这一版'), allText(tree).slice(0, 300))
check('读不出时不崩，还能退回时间轴', clickable(tree, '← 回到时间轴') !== undefined)
clickable(tree, '← 回到时间轴').props.onClick()
tree = await settle(createElement(Panel, {}))
check('退回时间轴', allText(tree).includes('载入演示') && allText(tree).includes('补经济分析敏感性'))

// ② 换成「重跑一遍」那一轮：和上一版（20260912T1600）比 → 真差异
roundRow('重跑一遍，内容没动').props.onClick()
tree = await settle(createElement(Panel, {}))
clickable(tree, '和上一版比').props.onClick()
tree = await settle(createElement(Panel, {}))
const baseline = findAll(tree, (node) => node.host === 'select')[0]
check('对比视图有基线选择器', baseline !== undefined)
check('基线候选就是同产线更早的轮次', baseline.props.children.length === 4, `实际 ${baseline.props.children.length} 项`)
check('默认基线是上一轮', baseline.props.value === '20260912T1600-毕业论文-5', String(baseline.props.value))
check('统计出新增与删掉的段数', allText(tree).includes('新增 2 段 · 删掉 2 段 · 相同 6 段'), allText(tree).slice(0, 400))
check('改过的段落出现在对比里', allText(tree).includes('乙苯转化率取 0.58，塔顶采出 1.2 t/h') && allText(tree).includes('乙苯转化率取 0.62，塔顶采出 1.2 t/h'))
check('整段换掉的也标出来了', allText(tree).includes('热量衡算表已重算') && allText(tree).includes('设备选型按老方案'))
check('连续未改动的段折成一行（不把屏幕撑满）', allText(tree).includes('中间 4 段没有变化'), allText(tree).slice(0, 400))
check('未改动的段不逐段罗列', !allText(tree).includes('未改动甲'))
check('对比视图标了两个文件的来去', allText(tree).includes('.versions/20260912T1600-论文全文.docx') && allText(tree).includes('.versions/20260913T1000-论文全文.docx'))

// 段内按词高亮：0.62 → 0.58 这种改动要自己跳出来
const highlighted = findAll(tree, (node) => node.host === 'span' && typeof node.props.style?.background === 'string' && node.props.style.background.includes('rgba'))
check('段内改动的词加了高亮底纹', highlighted.length > 0, `实际 ${highlighted.length} 处`)
check('高亮的是真正变了的那个数', highlighted.some((node) => node.children?.[0]?.text === '0.62') && highlighted.some((node) => node.children?.[0]?.text === '0.58'), JSON.stringify(highlighted.map((n) => n.children?.[0]?.text)))
check('没变的词不高亮', !highlighted.some((node) => node.children?.[0]?.text === '乙苯转化率取'))

// ③ 换基线到 20260911T2210（内容和这一版一字不差）→ 明说，不装作有变化
baseline.props.onChange({ target: { value: '20260911T2210-毕业论文-3' } })
tree = await settle(createElement(Panel, {}))
check('换基线后重新读两版', textCalls().some((url) => url.includes('20260911T2210')), JSON.stringify(textCalls().slice(-2)))
check('两版完全一致时明说', allText(tree).includes('两版正文完全一致'), allText(tree).slice(0, 400))
check('完全一致时提示「可能是没改就重新生成」', allText(tree).includes('没改就重新生成'))
check('统计徽章不带增删', allText(tree).includes('新增 0 段 · 删掉 0 段'))

// 收起
const beforeClose = textCalls().length
clickable(tree, '← 回到时间轴').props.onClick()
tree = await settle(createElement(Panel, {}))
check('收起后回到时间轴', allText(tree).includes('载入演示'))
check('收起后不再读正文', textCalls().length === beforeClose, `实际 ${textCalls().length} 次`)

// ④ 更旧的那一轮没有上一版 → 按钮是灰的，悬停说原因
roundRow('第二章重写').props.onClick()
tree = await settle(createElement(Panel, {}))
check('没有上一版时按钮置灰', clickable(tree, '和上一版比')?.props.disabled === true)
check('置灰原因写清楚了', String(clickable(tree, '和上一版比')?.props.title).includes('没有更早的轮次'), String(clickable(tree, '和上一版比')?.props.title))

/* ==================== 差异算法的边界（纯函数） ==================== */

const { lcsDiff, diffBlocks, diffWords, withAlpha } = client.__internals
const eqText = (x, y) => x.text === y.text
const opsOf = (a, b) => lcsDiff(a.map((text) => ({ kind: 'p', text })), b.map((text) => ({ kind: 'p', text })), eqText, 1500000)

check('两版一模一样 → 全是 same', opsOf(['a', 'b'], ['a', 'b']).every((op) => op.op === 'same'))
check('旧版为空 → 全是 add', opsOf([], ['a', 'b']).every((op) => op.op === 'add'))
check('新版为空 → 全是 del', opsOf(['a', 'b'], []).every((op) => op.op === 'del'))
check('中间插一段 → 只多一个 add', opsOf(['a', 'c'], ['a', 'b', 'c']).filter((op) => op.op === 'add').length === 1)
check('删掉一段 → 只多一个 del', opsOf(['a', 'b', 'c'], ['a', 'c']).filter((op) => op.op === 'del').length === 1)
check('两头都改了 → 前后各有增删', opsOf(['a', 'x'], ['b', 'y']).length === 4)
check('段尾空格不算差异', diffBlocks([{ kind: 'p', text: '同一段  ' }], [{ kind: 'p', text: '同一段' }]).every((op) => op.op === 'same'))
check('序列太大时不当真算（粗但不能卡死）', lcsDiff([1, 2, 3], [4, 5, 6], (x, y) => x === y, 1).length === 6)
check('词级差异认得数字', diffWords('转化率 0.62 完成', '转化率 0.58 完成').some((op) => op.op === 'del' && op.item === '0.62'))
check('中文按字切', diffWords('甲乙丙', '甲乙丁').filter((op) => op.op !== 'same').map((op) => op.item).join('') === '丙丁')
check('英文按词切（不拆散一个单词）', diffWords('the quick fox', 'the slow fox').filter((op) => op.op !== 'same').map((op) => op.item).join('') === 'quickslow')
check('一边是空串时不报错', diffWords('', 'abc').every((op) => op.op === 'add'))
check('颜色加透明度', withAlpha('#c92a2a', 0.2) === 'rgba(201, 42, 42, 0.2)', withAlpha('#c92a2a', 0.2))
check('三位十六进制也认', withAlpha('#abc', 0.5) === 'rgba(170, 187, 204, 0.5)')
check('认不出的颜色原样返回', withAlpha('var(--whatever)', 0.5) === 'var(--whatever)')

/* ==================== 表格也能比：xlsx 的单位是行 ==================== */

// 再造两轮「经济分析」：产物是 xlsx，两版之间只有一个格子变了
extraRounds.push({
	id: '20260915T1000-经济分析-1',
	at: 1789400000000,
	day: '2026-09-15',
	line: '经济分析',
	artifact: '经济分析表.xlsx',
	snapshot: '.versions/20260910T1400-衡算表.xlsx',
	kind: 'xlsx',
	bytes: 26000,
	bytesText: '25.4 KB',
	tool: 'python econ_table_xlsx.py',
	by: 'dsh',
	summary: '衡算表第一版',
	sources: [{ path: '05-第五章-经济分析.md', note: '' }]
})
extraRounds.push({
	id: '20260916T1000-经济分析-2',
	at: 1789500000000,
	day: '2026-09-16',
	line: '经济分析',
	artifact: '经济分析表.xlsx',
	snapshot: '.versions/20260911T2210-衡算表.xlsx',
	kind: 'xlsx',
	bytes: 26100,
	bytesText: '25.5 KB',
	tool: 'python econ_table_xlsx.py',
	by: 'dsh',
	summary: '衡算表改了一个数',
	sources: [{ path: '05-第五章-经济分析.md', note: '' }]
})
await tickOnce()
tree = await settle(createElement(Panel, {}))
clickable(tree, '现在刷新').props.onClick()
tree = await settle(createElement(Panel, {}))
check('新加的两版表格进时间轴了', allText(tree).includes('衡算表改了一个数'))

roundRow('衡算表改了一个数').props.onClick()
tree = await settle(createElement(Panel, {}))
check('xlsx 那一轮的【和上一版比】不是灰的', clickable(tree, '和上一版比')?.props.disabled === false, String(clickable(tree, '和上一版比')?.props.title))
clickable(tree, '和上一版比').props.onClick()
tree = await settle(createElement(Panel, {}))
check('表格也去读两版正文', textCalls().some((url) => url.includes('20260911T2210-%E8%A1%A1%E7%AE%97%E8%A1%A8')), JSON.stringify(textCalls().slice(-2)))
check('表格里连续没改的开头折成一行（不把屏幕撑满）', allText(tree).includes('中间 3 段没有变化'), allText(tree).slice(0, 500))
check('表格的工作表标记在改动附近看得见', allText(tree).includes('设备'), allText(tree).slice(0, 500))
check('表格一行一块、格子用竖线连起来', allText(tree).includes('项目 | 数值'), allText(tree).slice(0, 500))
check('表格只改的那个格子变红了/变绿了', allText(tree).includes('苯乙烯 | 0 | 0.58') && allText(tree).includes('苯乙烯 | 0 | 0.61'))
const cellMarks = findAll(tree, (node) => node.host === 'span' && typeof node.props.style?.background === 'string' && node.props.style.background.includes('rgba'))
check('变了的那个数自己跳出来（不是整行糊上去）', cellMarks.some((node) => node.children?.[0]?.text === '0.58') && cellMarks.some((node) => node.children?.[0]?.text === '0.61'), JSON.stringify(cellMarks.map((n) => n.children?.[0]?.text)))
check('没变的格子不高亮', !cellMarks.some((node) => node.children?.[0]?.text === '苯乙烯'))
check('表格的统计也按段数算', allText(tree).includes('新增 2 段 · 删掉 2 段 · 相同 5 段'), allText(tree).slice(0, 400))
clickable(tree, '← 回到时间轴').props.onClick()
tree = await settle(createElement(Panel, {}))

// 读不出来的表格：如实说
roundRow('这一版的快照读不出来').props.onClick()
tree = await settle(createElement(Panel, {}))

/* ==================== 主题探测 ==================== */

check('无 DOM 时主题探测回退为浅色', client.__internals.detectScheme() === 'light', client.__internals.detectScheme())
check('来源标签有中文名', client.__internals.sourceLabel('user-agents') === '用户 · .agents')
check('配对状态表齐全', ['stale', 'orphan', 'pending', 'ok'].every((key) => client.__internals.STATE_META[key] !== undefined))

/* ==================== 宿主半侧静态检查 ==================== */

const hostSource = readFileSync(HOST, 'utf8')
check('宿主半侧导出 name', /export const name = 'dsh-workbench'/.test(hostSource))
check('宿主半侧 inject 含 webServer', /export const inject = \['webServer'\]/.test(hostSource))
check('宿主半侧接受 GET/POST 两种方法', hostSource.includes('只支持 GET / POST'))
check('唯一的写操作是追加审批记录', /appendFile/.test(hostSource) && !/writeFile|mkdirSync|rmSync/.test(hostSource))
check('写路径做了越界检查', hostSource.includes('目标路径越界'))
const host = await import(`file://${HOST.replace(/\\/g, '/')}`)
check('宿主半侧可被 Node 直接加载', typeof host.apply === 'function')
check('主干名解析正确', host.__internals.stemOf('03_第三章.docx') === '03_第三章')
check('主干名会剥掉导出的两层尾巴', host.__internals.stemOf('报告.docx.pdf') === '报告', host.__internals.stemOf('报告.docx.pdf'))
check('主干名不会误吃正常文件名里的点', host.__internals.stemOf('2026.09.11-周报.docx') === '2026.09.11-周报', host.__internals.stemOf('2026.09.11-周报.docx'))
check('体积格式正确', host.__internals.humanBytes(2048) === '2.0 KB')

/* ==================== 汇总 ==================== */

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
	console.log(`失败项：\n  - ${failures.join('\n  - ')}`)
	process.exitCode = 1
}
