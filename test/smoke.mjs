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
 * 跑法：node D:\dsh-plugins\dsh-workbench\test\smoke.mjs
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

function historyBody() {
	const lines = new Map()
	for (const round of ROUND_DEFS) {
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
	const totals = { rounds: ROUND_DEFS.length, pending: 0, approved: 0, rejected: 0, lines: list.length }
	for (const line of list) for (const key of ['pending', 'approved', 'rejected']) totals[key] += line.counts[key]
	return { dir: DEMO_DIR, exists: true, truncated: false, totals, lines: list }
}

async function fakeFetch(url, options) {
	const method = options?.method ?? 'GET'
	requests.push(method === 'POST' ? `POST ${url} ${options.body}` : url)
	if (method === 'POST' && url.includes('/decide')) {
		const payload = JSON.parse(options.body)
		if (!['approved', 'rejected', 'pending'].includes(payload.state)) return { status: 400, async text() { return JSON.stringify({ error: 'bad state' }) } }
		decisions.set(payload.id, payload.state)
		return { status: 200, async text() { return JSON.stringify({ ok: true, id: payload.id, state: payload.state }) } }
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
const run = new Function('window', 'fetch', `${source}\n`)
run(fakeWindow, fakeFetch)

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
/** 桩 better-sidebar 的客户端服务：只实现 registerTab。 */
const fakeBetterSidebar = {
	registerTab(descriptor) {
		tabRegistrations.push(descriptor)
		return () => {}
	}
}
const fakeCtx = {
	slots: {
		inject(name, factory) {
			factory()
			return () => {}
		},
		register(definition, component) {
			registrations.push({ definition, component })
			return () => {}
		}
	},
	get(name) {
		return name === 'betterSidebar' ? fakeBetterSidebar : undefined
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

const iconTree = expand(createElement(panelEntry.component, { size: 18, active: true }), 'icon')
check('图标渲染出 svg', iconTree.host === 'svg', String(iconTree.host))
check('图标有中文 aria-label', iconTree.props['aria-label'] === '工作台')

/* ==================== 迭代页（默认打开） ==================== */

const Panel = mainEntry.component
let tree = await settle(createElement(Panel, {}))

check('默认打开迭代页', allText(tree).includes('载入演示'))
check('提示说明工作模式', allText(tree).includes('你审没审') || allText(tree).includes('AI 改 md'))

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
approve.props.onClick()
tree = await settle(createElement(Panel, {}))
check('发出了审批写请求', requests.some((r) => r.startsWith('POST') && r.includes('/decide') && r.includes('"state":"approved"')))
check('写完后重新拉取历史', requests.filter((url) => url.includes('/history?dir=')).length >= 2)
check('该轮变成「已通过」', allText(tree).includes('已通过'))

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
check('体积格式正确', host.__internals.humanBytes(2048) === '2.0 KB')

/* ==================== 汇总 ==================== */

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
	console.log(`失败项：\n  - ${failures.join('\n  - ')}`)
	process.exitCode = 1
}
