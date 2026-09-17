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
	dir: 'D:\\obsidian-vault\\毕业设计\\化学法版',
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
async function fakeFetch(url) {
	requests.push(url)
	let body
	if (url.includes('/skills')) body = { complete: true, cwd: '', skills: SKILLS }
	else if (url.includes('/skill?')) body = { name: 'doc-iteration-control', content: '# 文档迭代控制\n\nMarkdown 是唯一的源。', path: 'C:\\Users\\me\\.agents\\skills\\doc-iteration-control\\SKILL.md' }
	else if (url.includes('/workspaces')) body = { workspaces: [{ id: 'w1', path: 'D:\\dsh-tui-lyd', title: 'dsh-tui-lyd' }] }
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
	}
}
client.apply(fakeCtx)

const panelEntry = registrations.find((r) => r.definition.name === 'sidebar.panellist')
const mainEntry = registrations.find((r) => r.definition.name === 'main')
check('注册了 sidebar.panellist 图标', panelEntry !== undefined)
check('注册了 main 面板', mainEntry !== undefined)
check('两处 id 对应（侧栏图标 ↔ 主面板）', panelEntry?.definition.id === 'workbench' && mainEntry?.definition.key === 'workbench')
check('图标标签可读', panelEntry?.definition.label() === '工作台')

const iconTree = expand(createElement(panelEntry.component, { size: 18, active: true }), 'icon')
check('图标渲染出 svg', iconTree.host === 'svg', String(iconTree.host))
check('图标有中文 aria-label', iconTree.props['aria-label'] === '工作台')

/* ==================== 技能库页 ==================== */

const Panel = mainEntry.component
let tree = await settle(createElement(Panel, {}))

check('技能页默认打开', allText(tree).includes('技能库'))
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
check('列出已登记工作区', allText(tree).includes('dsh-tui-lyd'))

const workspaceChip = findAll(tree, (node) => node.host === 'span' && allText(node).includes('dsh-tui-lyd') && typeof node.props.onClick === 'function')[0]
check('工作区徽章可点击', workspaceChip !== undefined)
workspaceChip.props.onClick()
tree = await settle(createElement(Panel, {}))

check('扫描请求带上目录', requests.some((url) => url.includes('/docs?dir=') && url.includes('dsh-tui-lyd')))
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
check('宿主半侧注册的是只读 GET 路由', hostSource.includes("req.method !== 'GET'") && hostSource.includes('只支持 GET'))
check('宿主半侧不写文件', !/writeFile|appendFile|mkdir|rm\(/.test(hostSource))
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
