/**
 * bin/record.mjs（记录器 CLI）自检：真起子进程、真写临时目录。
 *
 * 为什么单独一套：记录器是「AI 每产出一版就该调一次」的那条写入路径，
 * 它的输出必须和面板（宿主 `/adopt`）**完全同构**——同一个 record.js、
 * 同一套快照命名与字段。所以这里除了测 CLI 自己，还会用宿主的 `/history`
 * 读同一份目录，验证「CLI 写进去的、面板读得出来」。
 *
 * 跑法：node test/record-cli.mjs
 */

import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BIN = join(here, '..', 'bin', 'record.mjs')
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

/**
 * 跑一次记录器。
 * @param args - 传给 CLI 的参数数组。
 * @param cwd - 子进程工作目录。
 * @returns `{ status, stdout, stderr }`。
 */
function run(args, cwd) {
	const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' })
	return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** 读 produced.jsonl 的全部行。 */
async function recordsOf(lineDir) {
	try {
		const text = await readFile(join(lineDir, '.versions', 'produced.jsonl'), 'utf8')
		return text
			.split('\n')
			.filter((line) => line.trim() !== '')
			.map((line) => JSON.parse(line))
	} catch {
		return []
	}
}

// 用宿主的 /history 读同一份目录：CLI 写的东西面板必须读得出来
const host = await import(HOST)
const capture = () => {
	const captured = { status: 0, text: '' }
	return {
		captured,
		res: {
			writeHead(status) {
				captured.status = status
			},
			end(chunk) {
				captured.text += chunk ?? ''
			}
		}
	}
}
async function historyOf(dir) {
	const { res, captured } = capture()
	await host.__internals.routeHistory(new URL(`http://localhost/api/dsh-workbench/history?dir=${encodeURIComponent(dir)}`), res)
	return { status: captured.status, body: JSON.parse(captured.text) }
}

console.log('dsh-workbench 记录器自检\n')

const ROOT = await mkdtemp(join(tmpdir(), 'dsh-workbench-record-'))
const LINE = join(ROOT, '毕业论文')
const MTIME = 1790000000000
await mkdir(LINE, { recursive: true })
await writeFile(join(LINE, '论文全文.docx'), 'docx-内容', 'utf8')
const stamp = new Date(MTIME)
await utimes(join(LINE, '论文全文.docx'), stamp, stamp)
const FILE_BYTES = Buffer.byteLength('docx-内容', 'utf8')
/** mtime 对应的快照时间戳前缀（YYYYMMDD，本地时区）。 */
const mtimeDate = new Date(MTIME)
const pad = (value) => String(value).padStart(2, '0')
const stampText = `${mtimeDate.getFullYear()}${pad(mtimeDate.getMonth() + 1)}${pad(mtimeDate.getDate())}`

/* ---------- 正常记一版 ---------- */

let result = run([LINE, '论文全文.docx', '--summary', '第3章：修正转化率', '--note', '这一版按 0.58 定稿', '--sources', '03-第三章.md,04-第四章.md', '--tool', 'python build.py', '--by', 'dsh'])
check('记录器退出码 0', result.status === 0, result.stderr)
check('人话输出里写了记的是哪一版', result.stdout.includes('已记一版') && result.stdout.includes('论文全文.docx'), result.stdout)
check('人话输出里给了快照路径', result.stdout.includes('.versions/'))

let rows = await recordsOf(LINE)
check('追加了一行 produced.jsonl', rows.length === 1, `实际 ${rows.length}`)
const row = rows[0] ?? {}
check('record.line 是产线目录名', row.line === basename(LINE), String(row.line))
check('record.at 是产物的 mtime（不是记录时刻）', row.at === MTIME, `${row.at} vs ${MTIME}`)
check('record.artifact / kind / bytes 正确', row.artifact === '论文全文.docx' && row.kind === 'docx' && row.bytes === FILE_BYTES, JSON.stringify({ artifact: row.artifact, kind: row.kind, bytes: row.bytes }))
check('record.summary 与 note 分开存', row.summary === '第3章：修正转化率' && row.note === '这一版按 0.58 定稿', JSON.stringify({ summary: row.summary, note: row.note }))
check('record.sources 两条都收', Array.isArray(row.sources) && row.sources.map((s) => s.path).join('|') === '03-第三章.md|04-第四章.md', JSON.stringify(row.sources))
check('record.tool / by 正确', row.tool === 'python build.py' && row.by === 'dsh', JSON.stringify({ tool: row.tool, by: row.by }))
check('record.id 存在且带产物时间前缀', typeof row.id === 'string' && row.id.startsWith(stampText), String(row.id))
check('record.adopted 是 false（不是面板补收编的）', row.adopted === false, String(row.adopted))

const firstSnapshot = join(LINE, String(row.snapshot).replace('.versions/', '.versions\\'))
check('快照文件真的写了', (await readFile(firstSnapshot, 'utf8')) === 'docx-内容')
const snap = await stat(firstSnapshot)
check('快照字节数等于原文件', snap.size === FILE_BYTES, `${snap.size} vs ${FILE_BYTES}`)
check('快照时间戳用产线名 + 产物名', String(row.snapshot).includes(basename(LINE)) && String(row.snapshot).endsWith('论文全文.docx'), String(row.snapshot))

/* ---------- 同一版重复记：拒绝，不产生重复轮次 ---------- */

result = run([LINE, '论文全文.docx', '--summary', '重复记同一版'])
check('同一版重复记被拒（不产生重复轮次）', result.status !== 0 && result.stderr.includes('已经记过'), result.stderr)
rows = await recordsOf(LINE)
check('被拒后记录还是一行', rows.length === 1, `实际 ${rows.length}`)

/* ---------- 同一分钟里又生成了一版：自动让号，不覆盖前一份 ---------- */

await utimes(join(LINE, '论文全文.docx'), new Date(MTIME + 30000), new Date(MTIME + 30000))
result = run([LINE, '论文全文.docx', '--summary', '第二版：补设备选型表'])
check('同一分钟的另一版可以记（自动让号）', result.status === 0, result.stderr)
rows = await recordsOf(LINE)
check('produced.jsonl 变成两行', rows.length === 2, `实际 ${rows.length}`)
check('两行快照路径不同', rows[0].snapshot !== rows[1].snapshot, `${rows[0].snapshot} / ${rows[1].snapshot}`)
check('第一版快照没被覆盖', (await readFile(firstSnapshot, 'utf8')) === 'docx-内容')
check('第二版 at 是新的 mtime', rows[1].at === MTIME + 30000, `${rows[1].at} vs ${MTIME + 30000}`)

/* ---------- --json：给 Agent 解析的输出 ---------- */

await writeFile(join(LINE, '报告.pdf'), 'pdf-内容', 'utf8')
await utimes(join(LINE, '报告.pdf'), new Date(MTIME + 60000), new Date(MTIME + 60000))
result = run([LINE, '报告.pdf', '--summary', '导出 PDF', '--json'])
check('--json 退出码 0', result.status === 0, result.stderr)
let parsed = null
try {
	parsed = JSON.parse(result.stdout.trim())
} catch {
	parsed = null
}
check('--json 输出是一行合法 JSON', parsed !== null, result.stdout.slice(0, 120))
check('--json 里有 id / snapshot / at / line', parsed !== null && typeof parsed.id === 'string' && String(parsed.snapshot).startsWith('.versions/') && parsed.at === MTIME + 60000 && parsed.line === basename(LINE), JSON.stringify(parsed))
check('--json 也只有一行（没有多余人话）', result.stdout.trim().split('\n').length === 1, String(result.stdout.trim().split('\n').length))

/* ---------- 中文逗号也认 ---------- */

await writeFile(join(LINE, '附表.xlsx'), 'xlsx-内容', 'utf8')
await utimes(join(LINE, '附表.xlsx'), new Date(MTIME + 90000), new Date(MTIME + 90000))
result = run([LINE, '附表.xlsx', '--summary', '第三版：补附表', '--sources', 'a.md，b.md'])
check('中文逗号那一次记成功', result.status === 0, result.stderr)
rows = await recordsOf(LINE)
const thirdRow = rows[rows.length - 1] ?? {}
check('中文逗号分隔的来源也认', thirdRow.sources?.length === 2 && thirdRow.sources[1].path === 'b.md', JSON.stringify(thirdRow.sources))

/* ---------- 宿主读得出来（两条写入路径同一套规则） ---------- */

const history = await historyOf(ROOT)
const lineOut = history.body.lines?.find((line) => line.name === basename(LINE))
check('宿主的 /history 读到 CLI 写的产线', history.status === 200 && lineOut !== undefined, JSON.stringify(history.body.lines?.map((line) => line.name)))
check('/history 里 CLI 记的版本都在', lineOut?.rounds?.length === 4, String(lineOut?.rounds?.length))
check('/history 读得到 CLI 写的 note（时间轴显示的那句）', lineOut?.rounds?.some((round) => round.note === '这一版按 0.58 定稿'), JSON.stringify(lineOut?.rounds?.map((r) => r.note)))
check('/history 读得到 CLI 写的 summary', lineOut?.rounds?.some((round) => round.summary === '第3章：修正转化率'))
check('/history 报出 4 个快照', lineOut?.snapshots?.count === 4, JSON.stringify(lineOut?.snapshots))
check('/history 没把 CLI 的记录算成坏行', lineOut?.bad?.produced === 0 && lineOut?.bad?.incomplete === 0, JSON.stringify(lineOut?.bad))

/* ---------- 拒绝：写错了要明说，不能静默 ---------- */

result = run([LINE, '没有这个.docx'])
check('文件不在时退出码非 0', result.status !== 0)
check('文件不在时说明原因', result.stderr.includes('文件不在原处'), result.stderr)

result = run([LINE, 'evil.exe'])
check('白名单外的类型被拒', result.status !== 0 && result.stderr.includes('不算产物'), result.stderr)

await writeFile(join(ROOT, '外面.docx'), 'x', 'utf8')
result = run([LINE, '..\\外面.docx'])
check('带路径的产物名被拒', result.status !== 0 && result.stderr.includes('不要带路径'), result.stderr)

result = run([LINE, '论文全文.docx', '--nope', 'x'])
check('不认识的选项被拒', result.status !== 0 && result.stderr.includes('不认识的选项'), result.stderr)

result = run([LINE, '论文全文.docx', '-x'])
check('单横线的未知选项也被拒（不当位置参数）', result.status !== 0 && result.stderr.includes('不认识的选项'), result.stderr)

result = run([LINE])
check('少参数时给用法', result.status !== 0 && (result.stdout + result.stderr).includes('用法'), (result.stdout + result.stderr).slice(0, 120))

result = run(['--help'])
check('--help 退出码 0 且给用法', result.status === 0 && result.stdout.includes('用法'), result.stdout.slice(0, 80))

result = run(['-h'])
check('-h 也能看用法（文档写了就得能用）', result.status === 0 && result.stdout.includes('用法'), (result.stdout + result.stderr).slice(0, 80))

const after = await recordsOf(LINE)
check('被拒的调用一条记录都没写', after.length === 4, `实际 ${after.length}`)

await rm(ROOT, { recursive: true, force: true })

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
	console.log(`失败项：\n  - ${failures.join('\n  - ')}`)
	process.exitCode = 1
}
