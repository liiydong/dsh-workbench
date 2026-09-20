/**
 * dsh-workbench 宿主半侧路由自检：不起服务器，直接调 route handler。
 *
 * 覆写覆盖：
 *   - /skills      走 ctx.skills.snapshot（桩）→ 归一化后的技能列表
 *   - /skill       走 ctx.skills.get（桩）→ 全文
 *   - /workspaces  走 ctx.workspaceRegistry.list（桩）
 *   - /docs        走**真实文件系统**扫描（默认扫本仓库根目录，也可用参数指定）
 *   - /decide      在系统临时目录里**真写**一次审批记录
 *   - /reveal      启动器被换成收集器（测试里绝不弹资源管理器窗口）
 *   - /scan        真扫临时目录 + 桩会话服务（含「soffice 的读入方不算生成」「删除不算生成」等反例）
 *   - /adopt       在临时目录里**真写**一份快照 + 追加一行 produced.jsonl
 *   - 未知路由 404、非 GET 405、技能注册表缺席时不抛异常
 *
 * 跑法：node test\host-routes.mjs [目录]
 */

import { Readable } from 'node:stream'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

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

/* ==================== /reveal（打开文件 / 在文件夹里定位） ==================== */

// 把「真的启动外部程序」那一步换掉——测试里绝不能弹出资源管理器窗口
const launches = []
host.__internals.setLauncher((command, args) => {
	launches.push({ command, args })
})

await writeFile(join(tempLine, '论文全文.docx'), 'docx', 'utf8')
await writeFile(join(tempLine, '.versions', '20260911T2210-论文全文.docx'), 'snapshot', 'utf8')
await writeFile(join(tempLine, 'evil.exe'), 'MZ', 'utf8')
await mkdir(join(tempLine, '子目录'), { recursive: true })

result = await call(route, '/api/dsh-workbench/reveal', 'POST', { dir: tempRoot, line: '产线A', file: '论文全文.docx', mode: 'open' })
check('/reveal 打开文件返回 200', result.status === 200 && result.body.ok === true, JSON.stringify(result.body))
check('/reveal 真的调了启动器', launches.length === 1, `实际 ${launches.length}`)
check('/reveal 传的是绝对路径', launches[0]?.args?.some((a) => a.endsWith('论文全文.docx')) === true, JSON.stringify(launches[0]))
check('/reveal 路径落在项目目录内', launches[0]?.args?.some((a) => a.startsWith(tempRoot)) === true)

result = await call(route, '/api/dsh-workbench/reveal', 'POST', { dir: tempRoot, line: '产线A', file: '.versions/20260911T2210-论文全文.docx', mode: 'reveal' })
check('/reveal 能定位 .versions 里的快照', result.status === 200, JSON.stringify(result.body))
check('reveal 模式带「定位并选中」参数', String(launches[1]?.args?.[0] ?? '').startsWith('/select,'), JSON.stringify(launches[1]))

result = await call(route, '/api/dsh-workbench/reveal', 'POST', { dir: tempRoot, line: '产线A', file: 'evil.exe', mode: 'open' })
check('/reveal 拒绝白名单外的类型（否则等于任意程序执行）', result.status === 400 && launches.length === 2, `状态 ${result.status}｜launches ${launches.length}`)

result = await call(route, '/api/dsh-workbench/reveal', 'POST', { dir: tempRoot, line: '产线A', file: '..\\..\\外面的.docx', mode: 'open' })
check('/reveal 拒绝路径穿越', result.status === 400 && launches.length === 2, `状态 ${result.status}`)

result = await call(route, '/api/dsh-workbench/reveal', 'POST', { dir: tempRoot, line: '..', file: 'x.docx', mode: 'open' })
check('/reveal 拒绝非法的产线名', result.status === 400, String(result.status))

result = await call(route, '/api/dsh-workbench/reveal', 'POST', { dir: tempRoot, line: '产线A', file: '没有这个.docx', mode: 'open' })
check('/reveal 文件不在原处时 404', result.status === 404, String(result.status))

result = await call(route, '/api/dsh-workbench/reveal', 'POST', { dir: tempRoot, line: '产线A', file: '子目录', mode: 'open' })
check('/reveal 目标是目录时 400', result.status === 400, String(result.status))

result = await call(route, '/api/dsh-workbench/reveal', 'POST', { file: 'x.docx' })
check('/reveal 缺 dir 时 400', result.status === 400, String(result.status))

result = await call(route, '/api/dsh-workbench/reveal', 'GET')
check('/reveal 只接受 POST', result.status === 405, String(result.status))
check('被拒的请求一次都没启动过程序', launches.length === 2, `实际 ${launches.length}`)

/* ==================== /scan：找「还没进记录」的产物 ==================== */

// 会话查询服务（桩）：一次真实扫描要不要去翻会话日志，全看这个服务在不在。
// 这里故意混进一个「别的项目」的会话，验证按 cwd 过滤。
const now = Date.now()
const mdPath = join(tempLine, '03-第三章.md')
const docxPath = join(tempLine, '论文全文.docx')
ctx.get = ((original) => (key) => {
	if (key !== 'sessionQuery') return original(key)
	return {
		async listSessions() {
			return [
				{ header: { id: 's-here', cwd: tempRoot, createdAt: now - 3600000 } },
				{ header: { id: 's-elsewhere', cwd: join(tmpdir(), '别的项目'), createdAt: now - 3600000 } }
			]
		},
		async readSession(id) {
			// 会话服务是按 id 读的；别的项目的会话不该被读进来（cwd 过滤就该拦掉）。
			if (id !== 's-here') return { events: [] }
			return {
				events: [
					{ type: 'tool/call', time: now - 300000, data: { name: 'write', arguments: JSON.stringify({ file_path: mdPath, content: '# 第三章' }) } },
					{ type: 'tool/call', time: now - 240000, data: { name: 'pwsh', arguments: JSON.stringify({ command: `python thesis_docx.py --out "${docxPath}"` }) } },
					// 反例：这一条里 docx 是读入的一方，不能被当成生成命令
					{ type: 'tool/call', time: now - 180000, data: { name: 'pwsh', arguments: JSON.stringify({ command: `soffice --convert-to pdf "${docxPath}" --outdir "${tempLine}"` }) } },
					// 反例：删除命令
					{ type: 'tool/call', time: now - 120000, data: { name: 'pwsh', arguments: JSON.stringify({ command: `Remove-Item "${docxPath}"` }) } }
				].filter((event) => event.time < now - 60000)
			}
		}
	}
})(ctx.get)
await writeFile(mdPath, '# 第三章\n', 'utf8')
await writeFile(docxPath, 'docx-新版', 'utf8')
await writeFile(join(tempLine, '论文全文.pdf'), 'pdf', 'utf8')

result = await call(route, '/api/dsh-workbench/scan', 'POST', { dir: tempRoot })
check('/scan 返回 200', result.status === 200, JSON.stringify(result.body).slice(0, 200))
check('/scan 认出没进记录的产物', result.body.totals.products === 2, JSON.stringify(result.body.totals))
check('/scan 找到了会话里的生成命令', result.body.lines[0].products.some((p) => p.tool.includes('thesis_docx.py')), JSON.stringify(result.body.lines[0].products.map((p) => p.tool)))
check('/scan 不把 soffice 的读入当成生成', result.body.lines[0].products.every((p) => !p.tool.includes('soffice')), JSON.stringify(result.body.lines[0].products.map((p) => p.tool)))
check('/scan 不把删除命令当成生成', result.body.lines[0].products.every((p) => !p.tool.includes('Remove-Item')))
check('/scan 带上改动过的源', result.body.lines[0].products.find((p) => p.name === '论文全文.docx')?.sources.includes('03-第三章.md') === true)
check('/scan 报告会话可查（provenance.available）', result.body.provenance.available === true)
check('/scan 只翻本项目 cwd 的会话', result.body.provenance.sessions === 1, `实际 ${result.body.provenance.sessions}`)

// 同一份文件被真记过一次之后，就不该再出现在「没进记录」里
result = await call(route, '/api/dsh-workbench/adopt', 'POST', { dir: tempRoot, line: '产线A', file: '论文全文.docx', note: '第一次收编' })
check('/adopt 返回 200', result.status === 200 && result.body.ok === true, JSON.stringify(result.body))
check('/adopt 给出快照相对路径', String(result.body.snapshot).startsWith('.versions/') && String(result.body.snapshot).endsWith('论文全文.docx'), String(result.body.snapshot))
const adoptedText = await readFile(join(tempLine, '.versions', 'produced.jsonl'), 'utf8')
check('/adopt 往 produced.jsonl 追加了一行', adoptedText.trim().split('\n').length === 2)
check('/adopt 记录里带 note 与 adopted 标记', adoptedText.includes('"note":"第一次收编"') && adoptedText.includes('"adopted":true'))
const snapshotFile = join(tempLine, String(result.body.snapshot).replace('.versions/', '.versions\\'))
check('/adopt 真的写了快照文件', (await readFile(snapshotFile, 'utf8')) === 'docx-新版')

result = await call(route, '/api/dsh-workbench/scan', 'POST', { dir: tempRoot })
check('/adopt 之后它不再出现在「没进记录」里', result.body.lines[0].products.every((p) => p.name !== '论文全文.docx'), JSON.stringify(result.body.lines[0].products.map((p) => p.name)))
check('没记过的那份还在列表里', result.body.lines[0].products.some((p) => p.name === '论文全文.pdf'))

result = await call(route, '/api/dsh-workbench/adopt', 'POST', { dir: tempRoot, line: '产线A', file: '论文全文.docx' })
check('/adopt 同一分钟重复收编时报 409（不覆盖快照）', result.status === 409, String(result.status))

result = await call(route, '/api/dsh-workbench/adopt', 'POST', { dir: tempRoot, line: '产线A', file: 'evil.exe' })
check('/adopt 拒绝白名单外的类型', result.status === 400, String(result.status))

result = await call(route, '/api/dsh-workbench/adopt', 'POST', { dir: tempRoot, line: '产线A', file: '..\\..\\外面的.docx' })
check('/adopt 拒绝路径穿越', result.status === 400, String(result.status))

result = await call(route, '/api/dsh-workbench/adopt', 'POST', { dir: tempRoot, line: '..', file: 'x.docx' })
check('/adopt 拒绝非法的产线名', result.status === 400, String(result.status))

result = await call(route, '/api/dsh-workbench/adopt', 'POST', { dir: tempRoot, line: '产线A', file: '没有这个.docx' })
check('/adopt 文件不在原处时 404', result.status === 404, String(result.status))

result = await call(route, '/api/dsh-workbench/adopt', 'GET')
check('/adopt 只接受 POST', result.status === 405, String(result.status))

result = await call(route, '/api/dsh-workbench/scan', 'GET')
check('/scan 只接受 POST', result.status === 405, String(result.status))

result = await call(route, '/api/dsh-workbench/scan', 'POST', {})
check('/scan 缺 dir 时 400', result.status === 400, String(result.status))

result = await call(route, '/api/dsh-workbench/scan', 'POST', { dir: join(tmpdir(), 'dsh-workbench-没有这个目录') })
check('/scan 目录不存在时给可读原因而不是 500', result.status === 200 && result.body.exists === false && typeof result.body.error === 'string')

await rm(tempRoot, { recursive: true, force: true })

/* ==================== 归因判据的单元样例（不出错比多给更重要） ==================== */

const { looksLikeOutput, recordOf, pathTokensOf } = host.__internals
const docxTarget = 'C:\\proj\\毕业论文\\论文全文.docx'
const verdict = (command) => looksLikeOutput(command, docxTarget)

check('认得出 --out 的产物', verdict(`python build.py --out "${docxTarget}"`) === true)
check('认得出 -o 的产物', verdict(`pandoc a.md -o "${docxTarget}"`) === true)
check('认得出重定向的产物', verdict(`python build.py > "${docxTarget}"`) === true)
check('认得出「构建脚本 + 目标文件名」', verdict(`node build.mjs "${docxTarget}"`) === true)
check('不把 soffice 的读入方当产物', verdict(`soffice --convert-to pdf "${docxTarget}" --outdir "C:\\proj\\毕业论文"`) === false)
check('不把只读命令当产物', verdict(`Get-Content "${docxTarget}"`) === false)
check('别的项目里的同名文件不算', verdict('python build.py --out "C:\\other\\论文全文.docx"') === false)
check('命令里没这个文件就不算', verdict(`python build.py --out "C:\\proj\\毕业论文\\别的.docx"`) === false)

const nameOnly = pathTokensOf({ command: `python x.py --out "${docxTarget}"` })
check('从命令里取出绝对路径', nameOnly.includes(docxTarget), JSON.stringify(nameOnly))
check('不把 content 里的反斜杠片段当路径', pathTokensOf({ file_path: 'D:\\a\\b.md', content: 'x = "C:\\\\tmp\\\\y"' })[0] === 'D:\\a\\b.md')

const base = 1700000000000
check('记录时间早于文件 → 算「还没进记录」', recordOf([{ id: 'a', at: base - 60000, artifact: '论文全文.docx' }], '论文全文.docx', base) === undefined)
check('记录时间晚于文件 → 算已进记录', recordOf([{ id: 'a', at: base + 10, artifact: '论文全文.docx' }], '论文全文.docx', base)?.id === 'a')
check('产物名不同不算同一条', recordOf([{ id: 'a', at: base + 10, artifact: '别的.docx' }], '论文全文.docx', base) === undefined)
check('3 秒内的时钟差算同一条', recordOf([{ id: 'a', at: base - 2000, artifact: '论文全文.docx' }], '论文全文.docx', base)?.id === 'a')

/* ==================== /docs 的「导出两层尾巴」配对 ==================== */

const pairRoot = await mkdtemp(join(tmpdir(), 'dsh-workbench-pair-'))
await writeFile(join(pairRoot, '报告.md'), '# 报告\n', 'utf8')
await writeFile(join(pairRoot, '报告.docx'), 'docx', 'utf8') // 比 md 新
await writeFile(join(pairRoot, '报告.docx.pdf'), 'pdf', 'utf8') // 从 docx 打印出来的，带两层尾巴

result = await call(route, `/api/dsh-workbench/docs?dir=${encodeURIComponent(pairRoot)}`)
check('三层同名文件归到同一个主干', result.body.pairs.length === 1, `实际 ${result.body.pairs.length} 组`)
check('带两层尾巴的产物不算「无源产物」', result.body.counts.orphan === 0, JSON.stringify(result.body.counts))
check('源与产物都识别到了', result.body.pairs[0]?.source !== null && result.body.pairs[0]?.artifact !== null)
await rm(pairRoot, { recursive: true, force: true })

/* ==================== /text：读一版正文（两版对比的地基） ==================== */

/** CRC32（zip 的中央目录要带）。 */
function crc32(buffer) {
	let crc = ~0
	for (let i = 0; i < buffer.length; i += 1) {
		crc ^= buffer[i]
		for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
	}
	return ~crc >>> 0
}

/**
 * 造一个**真的** docx：中央目录 + 一个压缩过的 word/document.xml。
 * 用真 deflate 而不是假数据，否则测的就不是自己那条解压路。
 */
function makeDocx(xml, { stored = false } = {}) {
	const name = Buffer.from('word/document.xml', 'utf8')
	const body = Buffer.from(xml, 'utf8')
	const payload = stored ? body : deflateRawSync(body)
	const method = stored ? 0 : 8
	const local = Buffer.alloc(30)
	local.writeUInt32LE(0x04034b50, 0)
	local.writeUInt16LE(20, 4)
	local.writeUInt16LE(method, 8)
	local.writeUInt32LE(crc32(body), 14)
	local.writeUInt32LE(payload.length, 18)
	local.writeUInt32LE(body.length, 22)
	local.writeUInt16LE(name.length, 26)
	const localBlock = Buffer.concat([local, name, payload])
	const central = Buffer.alloc(46)
	central.writeUInt32LE(0x02014b50, 0)
	central.writeUInt16LE(20, 4)
	central.writeUInt16LE(20, 6)
	central.writeUInt16LE(method, 10)
	central.writeUInt32LE(crc32(body), 16)
	central.writeUInt32LE(payload.length, 20)
	central.writeUInt32LE(body.length, 24)
	central.writeUInt16LE(name.length, 28)
	central.writeUInt32LE(0, 42)
	const centralBlock = Buffer.concat([central, name])
	const eocd = Buffer.alloc(22)
	eocd.writeUInt32LE(0x06054b50, 0)
	eocd.writeUInt16LE(1, 8)
	eocd.writeUInt16LE(1, 10)
	eocd.writeUInt32LE(centralBlock.length, 12)
	eocd.writeUInt32LE(localBlock.length, 16)
	return Buffer.concat([localBlock, centralBlock, eocd])
}

const { unzipEntry, docxBlocks, blocksFromText, decodeEntities, headingLevel } = host.__internals

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="x"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading 1"/></w:pPr><w:r><w:t>第三章 物料衡算</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">乙苯转化率取 </w:t></w:r><w:r><w:t>0.62</w:t></w:r><w:r><w:t>，塔顶采出 </w:t></w:r><w:r><w:t>1.2 t/h</w:t></w:r><w:t>   </w:t></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>第一条</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数值</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>转化率</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>0.62</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:pPr><w:pStyle w:val="标题 2"/></w:pPr><w:r><w:t>中文样式也是标题</w:t></w:r></w:p>
<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>大纲级别也是标题</w:t></w:r></w:p>
<w:p><w:r><w:t>符号 &amp; 尖括号 &lt;tag&gt; 破折号 &#x2014;</w:t></w:r></w:p>
<w:p><w:r><w:instrText>PAGE  \\* MERGEFORMAT</w:instrText><w:t>看得见的正文</w:t></w:r></w:p>
</w:body></w:document>`

check('zip 能解出 deflate 压缩的条目', String(unzipEntry(makeDocx(SAMPLE_XML), 'word/document.xml')).includes('物料衡算'))
check('zip 也能解出不压缩（stored）的条目', String(unzipEntry(makeDocx(SAMPLE_XML, { stored: true }), 'word/document.xml')).includes('物料衡算'))
check('zip 里没有的条目返回 null', unzipEntry(makeDocx(SAMPLE_XML), 'word/nope.xml') === null)
check('不是 zip 的 docx 返回 null（不当成崩溃）', unzipEntry(Buffer.from('这不是 zip', 'utf8'), 'word/document.xml') === null)

const sample = docxBlocks(unzipEntry(makeDocx(SAMPLE_XML), 'word/document.xml').toString('utf8'))
check('docx 段落按文档顺序解出来', sample.map((b) => b.text)[0] === '第三章 物料衡算')
check('跨多个 run 的文字拼成一段', sample.some((b) => b.text === '乙苯转化率取 0.62，塔顶采出 1.2 t/h'), JSON.stringify(sample[1]))
check('段尾空白被去掉（不当成改动）', sample.every((b) => b.text === b.text.replace(/\s+$/, '')))
check('Heading 1 认成一级标题', sample[0].kind === 'h1')
check('中文「标题 2」也认成标题', sample.some((b) => b.kind === 'h2' && b.text === '中文样式也是标题'))
check('大纲级别也能当标题', sample.some((b) => b.kind === 'h1' && b.text === '大纲级别也是标题'))
check('列表项标成 li', sample.some((b) => b.kind === 'li' && b.text === '第一条'))
check('表格行用竖线把单元格连起来', sample.some((b) => b.kind === 'row' && b.text === '项目 | 数值'))
check('表格开头有一个标记块', sample.some((b) => b.kind === 'table'))
check('XML 实体被解码', sample.some((b) => b.text === '符号 & 尖括号 <tag> 破折号 —'), JSON.stringify(sample.at(-2)))
check('域代码（页码那种）不当正文', !sample.some((b) => b.text.includes('MERGEFORMAT')))
check('标题层级工具函数', headingLevel('Heading 3') === 3 && headingLevel('标题 1') === 1 && headingLevel('正文') === 0 && headingLevel('') === 0)
check('实体解码工具函数', decodeEntities('a&amp;b&#x2014;c&#65;') === 'a&b—cA')
check('坏实体原样留着（不猜）', decodeEntities('&notanentity;') === '&notanentity;')

const mdBlocks = blocksFromText('# 标题\n\n正文一行\n- 列表项\n| a | b |\n', '.md')
check('md 的标题/列表/表格行都认', mdBlocks[0].kind === 'h1' && mdBlocks.some((b) => b.kind === 'li') && mdBlocks.some((b) => b.kind === 'row'))
check('md 的空行不占一段', blocksFromText('a\n\n\n\nb\n', '.md').length === 2)

const textRoot = await mkdtemp(join(tmpdir(), 'dsh-workbench-text-'))
const textLine = join(textRoot, '毕业论文')
await mkdir(join(textLine, '.versions'), { recursive: true })
await writeFile(join(textLine, '.versions', '20260911T2210-论文全文.docx'), makeDocx(SAMPLE_XML))
await writeFile(join(textLine, '.versions', '20260910T1400-论文全文.docx'), makeDocx(SAMPLE_XML.replace('0.62', '0.58').replace('塔顶采出 ', '')))
await writeFile(join(textLine, '03-第三章-物料衡算.md'), '# 第三章\n\n转化率 0.62\n', 'utf8')
await writeFile(join(textLine, '04-第四章-设备选型.md'), '# 第四章\n\n精馏塔塔径 1.2 m\n', 'utf8')
await writeFile(join(textLine, '图片.png'), Buffer.from('not-a-doc'))

const textOf = (file, line = '毕业论文') =>
	call(route, `/api/dsh-workbench/text?dir=${encodeURIComponent(textRoot)}&line=${encodeURIComponent(line)}&file=${encodeURIComponent(file)}`)

result = await textOf('.versions/20260911T2210-论文全文.docx')
check('/text 读 docx 返回块', result.status === 200 && result.body.ok === true && Array.isArray(result.body.blocks) && result.body.blocks.length > 5, JSON.stringify(result.body).slice(0, 160))
check('/text 报出读的是哪个文件', result.body.file === '.versions/20260911T2210-论文全文.docx' && result.body.kind === 'docx')
check('/text 没截断时 truncated 为 false', result.body.truncated === false)

result = await textOf('03-第三章-物料衡算.md')
check('/text 读 md 也能返回块', result.status === 200 && result.body.ok === true && result.body.blocks[0].text === '第三章')
check('/text 读 md 时 kind 是 md', result.body.kind === 'md')

result = await textOf('没有这个.docx')
check('/text 文件不在原处时 404 且是人话', result.status === 404 && typeof result.body.error === 'string', String(result.status))

result = await textOf('..\\..\\外面的.docx')
check('/text 拒绝路径穿越', result.status === 400 && String(result.body.error).includes('相对路径'), String(result.status))

result = await call(route, `/api/dsh-workbench/text?dir=${encodeURIComponent(textRoot)}&line=..&file=a.docx`)
check('/text 拒绝非法的产线名', result.status === 400 && String(result.body.error).includes('产线'), String(result.status))

result = await call(route, `/api/dsh-workbench/text?dir=${encodeURIComponent(textRoot)}&line=毕业论文&file=${encodeURIComponent('C:\\windows\\win.ini')}`)
check('/text 拒绝绝对路径', result.status === 400, String(result.status))

result = await call(route, `/api/dsh-workbench/text?dir=${encodeURIComponent(textRoot)}&line=毕业论文&file=${encodeURIComponent('../毕业论文/03-第三章-物料衡算.md')}`)
check('/text 拒绝用 .. 绕回项目内', result.status === 400, String(result.status))

result = await textOf('图片.png')
check('/text 拒绝白名单外的类型并说明支持什么', result.status === 400 && String(result.body.error).includes('纯文本'), String(result.status))

result = await call(route, `/api/dsh-workbench/text?dir=${encodeURIComponent(textRoot)}&line=${encodeURIComponent('毕业论文')}&file=${encodeURIComponent('.versions\\20260911T2210-论文全文.docx')}`)
check('/text 快照在 .versions/ 子目录里也读得到', result.status === 200 && result.body.ok === true, String(result.status))

result = await call(route, '/api/dsh-workbench/text')
check('/text 缺参数时 400', result.status === 400, String(result.status))

result = await call(route, '/api/dsh-workbench/text?dir=' + encodeURIComponent(textRoot))
check('/text 缺 file 时 400', result.status === 400, String(result.status))

result = await call(route, `/api/dsh-workbench/text?dir=${encodeURIComponent(textRoot)}&line=毕业论文&file=x.docx`, 'POST')
check('/text 只接受 GET', result.status === 405, String(result.status))

// 假 docx：扩展名对，内容不是 zip
await writeFile(join(textLine, '假的.docx'), '这只是一个文本文件，不是 zip', 'utf8')
result = await textOf('假的.docx')
check('不是 zip 的 docx 如实说读不出，不当 500', result.status === 200 && result.body.ok === false && String(result.body.error).includes('document.xml'), JSON.stringify(result.body).slice(0, 160))

// 超长文档：截断要说出来，不能把整个 JSON 撑爆
const huge = makeDocx(`<w:document xmlns:w="x"><w:body>${'<w:p><w:r><w:t>段落内容</w:t></w:r></w:p>'.repeat(6000)}</w:body></w:document>`)
await writeFile(join(textLine, '超长.docx'), huge)
result = await textOf('超长.docx')
check('超长文档被截断且如实标记', result.body.truncated === true && result.body.blocks.length === 4000, `实际 ${result.body.blocks.length} 段`)

// 单产线项目：line 传 '.' 也认（跟 /reveal 一致）
await writeFile(join(textRoot, '论文全文.docx'), makeDocx(SAMPLE_XML))
result = await call(route, `/api/dsh-workbench/text?dir=${encodeURIComponent(textRoot)}&line=.&file=${encodeURIComponent('论文全文.docx')}`)
check('/text 支持 line=.（单产线项目放根目录）', result.status === 200 && result.body.ok === true, String(result.status))

await rm(textRoot, { recursive: true, force: true })

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
