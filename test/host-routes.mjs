/**
 * dsh-workbench 宿主半侧路由自检：不起服务器，直接调 route handler。
 *
 * 覆写覆盖：
 *   - /skills      走 ctx.skills.snapshot（桩）→ 归一化后的技能列表
 *   - /skill       走 ctx.skills.get（桩）→ 全文
 *   - /workspaces  走 ctx.workspaceRegistry.list（桩）
 *   - /docs        走**真实文件系统**扫描（默认扫本仓库根目录，也可用参数指定）
 *   - 未知路由 404、非 GET 405、技能注册表缺席时不抛异常
 *
 * 跑法：node D:\dsh-plugins\dsh-workbench\test\host-routes.mjs [目录]
 */

import { Readable } from 'node:stream'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const HOST = `file://${join(here, '..', 'lib', 'index.js').replace(/\\/g, '/')}`

let passed = 0
let failed = 0
const failures = []
function check(label, condition, detail) {
	if (condition) {
		passed += 1
		console.log(`  ✓ ${label}`)
	} else {
		failed += 1
		failures.push(label)
		console.log(`  ✗ ${label}${detail === undefined ? '' : `  ← ${detail}`}`)
	}
}

/** 造一个假请求（POST 可带 JSON 体）。 */
function request(url, method = 'GET', body) {
	const req = new Readable({ read() {} })
	req.url = url
	req.method = method
	if (body !== undefined) req.push(JSON.stringify(body))
	req.push(null)
	return req
}

/** 造一个假响应，收下状态码与 JSON。 */
function response() {
	const captured = { status: 0, headers: null, text: '' }
	return {
		captured,
		res: {
			writeHead(status, headers) {
				captured.status = status
				captured.headers = headers
			},
			end(chunk) {
				captured.text += chunk ?? ''
			}
		}
	}
}

async function call(route, url, method = 'GET', body) {
	const { res, captured } = response()
	await route.handler(request(url, method, body), res)
	let parsed = null
	try {
		parsed = JSON.parse(captured.text)
	} catch {
		parsed = { parseError: captured.text.slice(0, 120) }
	}
	return { status: captured.status, body: parsed, headers: captured.headers }
}

/* ==================== 桩上下文 ==================== */

const SKILLS = [
	{ name: 'doc-iteration-control', description: '文档迭代的版本控制纪律', whenToUse: '改文档时', source: 'user-agents', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true }, resourceBase: { kind: 'directory', path: 'C:\\Users\\me\\.agents\\skills\\doc-iteration-control' } },
	{ name: 'book-to-skill', description: '把书变成技能', source: 'bundled', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true }, resourceBase: { kind: 'opaque', description: '内置' } }
]

const ctx = {
	registrations: [],
	webServer: {
		register(route) {
			ctx.registrations.push(route)
			return () => {}
		}
	},
	get(key) {
		if (key === 'skills')
			return {
				async snapshot() {
					return { complete: true, skills: SKILLS }
				},
				async get(name) {
					if (name !== 'doc-iteration-control') return undefined
					return { ...SKILLS[0], content: '# 文档迭代控制\n\nMarkdown 是唯一的源。' }
				}
			}
		if (key === 'workspaceRegistry')
			return {
				list: () => [
					{ id: 'w1', path: 'D:\\work\\my-project', title: 'my-project' },
					{ id: 'w2', path: 'D:\\work\\notes', title: 'notes' }
				]
			}
		return undefined
	}
}

const host = await import(HOST)
host.apply(ctx)
const route = ctx.registrations[0]

console.log('dsh-workbench 宿主路由自检\n')

check('注册了一条 prefix 路由', ctx.registrations.length === 1 && route.kind === 'prefix' && route.path === '/api/dsh-workbench')

/* ==================== /skills ==================== */

let result = await call(route, '/api/dsh-workbench/skills')
check('/skills 返回 200', result.status === 200, String(result.status))
check('/skills 走注册表快照（complete=true）', result.body.complete === true)
check('/skills 列出全部技能', result.body.skills?.length === 2)
check('/skills 只带叶子字段（无宿主对象）', result.body.skills.every((s) => typeof s.name === 'string' && typeof s.path === 'string' && s.invocation === undefined))
check('/skills 提取 resourceBase.path', result.body.skills[0].path.endsWith('doc-iteration-control'))
check('/skills 对 opaque 资源不留空串错误', result.body.skills[1].path === '内置')
check('响应是 JSON', String(result.headers['content-type']).includes('application/json'))

/* ==================== /skill ==================== */

result = await call(route, '/api/dsh-workbench/skill?name=doc-iteration-control')
check('/skill 返回全文', result.status === 200 && result.body.content.includes('Markdown 是唯一的源'))

result = await call(route, '/api/dsh-workbench/skill?name=nope')
check('/skill 找不到时 404', result.status === 404, String(result.status))

result = await call(route, '/api/dsh-workbench/skill')
check('/skill 缺参数时 400', result.status === 400, String(result.status))

/* ==================== /workspaces ==================== */

result = await call(route, '/api/dsh-workbench/workspaces')
check('/workspaces 列出登记表', result.body.workspaces?.length === 2)
check('/workspaces 过滤空路径', result.body.workspaces.every((w) => w.path !== ''))

/* ==================== /docs（真实文件系统） ==================== */

const sampleDir = process.argv[2] ?? join(here, '..')
result = await call(route, `/api/dsh-workbench/docs?dir=${encodeURIComponent(sampleDir)}`)
console.log(`\n  样本目录：${sampleDir}`)
if (result.body.exists === false) {
	console.log(`  （样本目录不存在，跳过真实扫描断言：${result.body.error}）`)
} else {
	const counts = result.body.counts
	console.log(`  扫描结果：文件 ${result.body.entries.length} 个｜配对 ${result.body.pairs.length} 组｜过期 ${counts.stale}｜无源产物 ${counts.orphan}｜未生成 ${counts.pending}｜已同步 ${counts.ok}`)
	check('/docs 真的扫到了文档', result.body.entries.length > 0)
	check('/docs 只返回关心的扩展名', result.body.entries.every((e) => ['.md', '.markdown', '.tex', '.qmd', '.txt', '.docx', '.doc', '.pdf', '.xlsx', '.pptx', '.html', '.csv', '.png', '.jpg'].includes(e.ext)))
	check('/docs 每个条目带体积与时间', result.body.entries.every((e) => e.bytesText !== '' && Number.isFinite(e.mtime) && e.mtime > 0))
	check('/docs 分类正确', result.body.entries.every((e) => e.kind === 'source' || e.kind === 'artifact' || e.kind === 'other'))
	check('/docs 计数与配对一致', counts.stale + counts.orphan + counts.pending + counts.ok === result.body.pairs.length)
	const order = { stale: 0, orphan: 1, pending: 2, ok: 3 }
	const sorted = result.body.pairs.every((pair, i, arr) => i === 0 || order[arr[i - 1].state] <= order[pair.state])
	check('/docs 按「该先处理」排序', sorted)
	const stalePairs = result.body.pairs.filter((p) => p.state === 'stale')
	check('「过期」确实满足 产物 mtime < 源 mtime', stalePairs.every((p) => p.artifact.mtime < p.source.mtime))
	const okPairs = result.body.pairs.filter((p) => p.state === 'ok')
	check('「已同步」确实满足 产物 mtime >= 源 mtime', okPairs.every((p) => p.artifact.mtime >= p.source.mtime))
	check('孤儿项真的没有源', result.body.pairs.filter((p) => p.state === 'orphan').every((p) => p.source === null && p.artifact !== null))
}

/* ==================== /demo 与 /history（真扫演示项目） ==================== */

result = await call(route, '/api/dsh-workbench/demo')
check('/demo 指向插件自带的演示项目', result.status === 200 && result.body.exists === true, result.body.dir)
const demoDir = result.body.dir

result = await call(route, `/api/dsh-workbench/history?dir=${encodeURIComponent(demoDir)}`)
const hist = result.body
check('/history 读到三条产线', hist.exists === true && hist.lines.length === 3, `实际 ${hist.lines?.length}`)
check('/history 总轮数为 27', hist.totals.rounds === 27, String(hist.totals.rounds))
check('/history 状态计数自洽', hist.totals.pending + hist.totals.approved + hist.totals.rejected === hist.totals.rounds)
check('/history 每轮都带摘要与来源', hist.lines.every((line) => line.rounds.every((r) => r.summary !== '' && Array.isArray(r.sources))))
check('/history 每轮都有快照路径', hist.lines.every((line) => line.rounds.every((r) => r.snapshot.startsWith('.versions/'))))
check('/history 按时间倒序', hist.lines.every((line) => line.rounds.every((r, i, arr) => i === 0 || arr[i - 1].at >= r.at)))
check('/history 按天归类', hist.lines.every((line) => line.rounds.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day))))
check('/history 识别多种产物类型', new Set(hist.lines.flatMap((l) => l.kinds)).size >= 2)
check('/history 审批默认待审', hist.totals.pending > 0)
check('/history 已有历史审批', hist.totals.approved > 0)

/* ==================== /decide（在临时目录里真写一次） ==================== */

const tempRoot = await mkdtemp(join(tmpdir(), 'dsh-workbench-test-'))
const tempLine = join(tempRoot, '产线A')
await mkdir(join(tempLine, '.versions'), { recursive: true })
await writeFile(
	join(tempLine, '.versions', 'produced.jsonl'),
	`${JSON.stringify({ id: 'r1', at: 1789000000000, line: '产线A', artifact: '报告.docx', snapshot: '.versions/a.docx', kind: 'docx', bytes: 100, summary: '第一版', sources: [{ path: 'a.md' }] })}\n`,
	'utf8'
)
await writeFile(join(tempLine, '.versions', 'decisions.jsonl'), '', 'utf8')

result = await call(route, `/api/dsh-workbench/history?dir=${encodeURIComponent(tempRoot)}`)
check('临时项目里那一轮是待审', result.body.totals.pending === 1 && result.body.totals.approved === 0)

result = await call(route, '/api/dsh-workbench/decide', 'POST', { dir: tempRoot, line: '产线A', id: 'r1', state: 'approved', note: '可以', by: 'tester' })
check('/decide 写入成功', result.status === 200 && result.body.ok === true, JSON.stringify(result.body))

result = await call(route, `/api/dsh-workbench/history?dir=${encodeURIComponent(tempRoot)}`)
check('/decide 之后历史里变成已通过', result.body.totals.approved === 1 && result.body.lines[0].rounds[0].approval.note === '可以')

const decisionsText = await readFile(join(tempLine, '.versions', 'decisions.jsonl'), 'utf8')
check('审批是追加式记录（一行一事件）', decisionsText.trim().split('\n').length === 1 && decisionsText.includes('"state":"approved"'))

result = await call(route, '/api/dsh-workbench/decide', 'POST', { dir: tempRoot, line: '..\\..\\evil', id: 'r1', state: 'approved' })
check('/decide 拒绝路径穿越', result.status === 400, String(result.status))

result = await call(route, '/api/dsh-workbench/decide', 'POST', { dir: tempRoot, line: '产线A', id: 'r1', state: '随便' })
check('/decide 拒绝非法状态', result.status === 400, String(result.status))

result = await call(route, '/api/dsh-workbench/decide', 'GET')
check('/decide 只接受 POST', result.status === 405, String(result.status))

await rm(tempRoot, { recursive: true, force: true })

/* ==================== 边界 ==================== */

result = await call(route, '/api/dsh-workbench/docs')
check('/docs 缺目录时 400', result.status === 400, String(result.status))

result = await call(route, '/api/dsh-workbench/docs?dir=Z%3A%5Cnope%5Cnope')
check('/docs 目录不存在时给可读原因而不是 500', result.status === 200 && result.body.exists === false && typeof result.body.error === 'string')

result = await call(route, '/api/dsh-workbench/nope')
check('未知路由 404', result.status === 404, String(result.status))

result = await call(route, '/api/dsh-workbench/skills', 'POST')
check('非 GET 405', result.status === 405, String(result.status))

// 技能注册表缺席时不抛异常
const bare = { registrations: [], webServer: { register(r) { bare.registrations.push(r); return () => {} } }, get: () => undefined }
const host2 = await import(`${HOST}?bare=1`)
host2.apply(bare)
const result2 = await call(bare.registrations[0], '/api/dsh-workbench/skills')
check('技能注册表缺席时返回可读错误而非崩溃', result2.status === 200 && typeof result2.body.error === 'string')
const result3 = await call(bare.registrations[0], '/api/dsh-workbench/workspaces')
check('工作区注册表缺席时返回空列表', result3.status === 200 && Array.isArray(result3.body.workspaces))

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
	console.log(`失败项：\n  - ${failures.join('\n  - ')}`)
	process.exitCode = 1
}
