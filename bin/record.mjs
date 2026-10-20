#!/usr/bin/env node
/**
 * dsh-workbench 记录器：把一版产物记进时间轴（复制快照 + 追加 produced.jsonl）。
 *
 * 这是给「产出那一刻」用的命令行：AI 改完 md、跑完生成脚本后调一次，
 * 面板上就自己长出这一版。不需要 DSH 宿主跑着，也不需要面板开着；
 * 和面板里的【记一版】（宿主 `/adopt`）走的是同一套实现（`lib/record.js`）。
 *
 * 用法：
 *   node bin/record.mjs <产线目录> <产物文件名> [选项]
 *
 * 例：
 *   node bin/record.mjs "D:\论文\毕业论文" 论文全文.docx `
 *     --summary "第3章：修正乙苯转化率 0.62→0.58，重算全表" `
 *     --sources "03-第三章-物料衡算.md" `
 *     --tool "python thesis_docx.py"
 *
 * 选项：
 *   --summary <一句话>   这一版干了什么（显示在时间轴那一行）
 *   --note <备注>        额外说明（与 summary 分开存，面板都显示）
 *   --sources <列表>     改过哪些源，逗号分隔（中文逗号也认）
 *   --tool <命令>        生成这一版的命令
 *   --by <谁>            记录者，默认 dsh
 *   --json               输出一行 JSON（给程序/Agent 解析）
 *   -h, --help           显示这份说明
 *
 * 退出码：0 记录成功；1 失败（原因打在 stderr）。
 *
 * @module dsh-workbench/bin/record
 */

import { recordVersion } from '../lib/record.js'

const USAGE = `dsh-workbench 记录器

用法：
  node bin/record.mjs <产线目录> <产物文件名> [选项]

选项：
  --summary <一句话>   这一版干了什么（显示在时间轴那一行）
  --note <备注>        额外说明（与 summary 分开存，面板都显示）
  --sources <列表>     改过哪些源，逗号分隔
  --tool <命令>        生成这一版的命令
  --by <谁>            记录者，默认 dsh
  --json               输出一行 JSON（给程序/Agent 解析）
  -h, --help           显示这份说明

说明：
  产线目录 = 记录要落在哪个目录（记录写进它的 .versions/）。
  产物文件名必须直接放在这个目录里，不能带子路径。
  快照是「复制」而不是硬链接：下一版原地覆盖工作副本时，已记录的版本不会跟着变。
`

const KNOWN = new Set(['summary', 'note', 'sources', 'tool', 'by', 'json', 'help', 'h'])
const BOOLEAN = new Set(['json', 'help', 'h'])

/**
 * 解析参数：位置参数两个（产线目录、产物文件），其余是 `--名字 值` 或 `--名字=值`。
 * @param argv - `process.argv.slice(2)`。
 * @returns `{ positional, flags }`。
 */
function parseArgs(argv) {
	const positional = []
	const flags = {}
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index]
		// 单横线只认 -h（文档里写了）；其余 -x 报未知选项，别静默当成位置参数。
		if (token === '-h') {
			flags.help = true
			continue
		}
		if (token.startsWith('-') && !token.startsWith('--')) throw new Error(`不认识的选项：${token}（用 --help 看用法）`)
		if (!token.startsWith('--')) {
			positional.push(token)
			continue
		}
		const body = token.slice(2)
		const equal = body.indexOf('=')
		const name = equal >= 0 ? body.slice(0, equal) : body
		if (!KNOWN.has(name)) throw new Error(`不认识的选项：--${name}（用 --help 看用法）`)
		if (BOOLEAN.has(name)) {
			flags[name] = true
			continue
		}
		if (equal >= 0) {
			flags[name] = body.slice(equal + 1)
			continue
		}
		const next = argv[index + 1]
		if (next === undefined || next.startsWith('--')) {
			flags[name] = ''
			continue
		}
		flags[name] = next
		index += 1
	}
	return { positional, flags }
}

/** 本地时间显示（只用于人看的输出）。 */
function whenText(ms) {
	if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
	try {
		return new Date(ms).toLocaleString('zh-CN', { hour12: false })
	} catch {
		return ''
	}
}

async function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2))
	if (flags.help === true || flags.h === true) {
		process.stdout.write(USAGE)
		return
	}
	if (positional.length < 2) {
		process.stderr.write(`缺少参数。\n\n${USAGE}`)
		process.exitCode = 1
		return
	}
	if (positional.length > 2) throw new Error(`参数多了：${positional.slice(2).join(' ')}（产物文件名不能带路径）`)

	const [lineDir, file] = positional
	const result = await recordVersion({
		lineDir,
		file,
		summary: typeof flags.summary === 'string' ? flags.summary : '',
		note: typeof flags.note === 'string' ? flags.note : '',
		sources: typeof flags.sources === 'string' ? flags.sources.split(/[,，]/) : [],
		tool: typeof flags.tool === 'string' ? flags.tool : '',
		by: typeof flags.by === 'string' && flags.by !== '' ? flags.by : 'dsh',
		unique: true
	})

	if (flags.json === true) {
		process.stdout.write(`${JSON.stringify(result.record)}\n`)
		return
	}
	const lines = [`已记一版：${result.line} / ${result.artifact}`, `  记录  ${lineDir} 下的 .versions/produced.jsonl`, `  快照  ${result.snapshot}`, `  时间  ${whenText(result.at)}（产物 mtime）`]
	if (result.record.summary !== '') lines.push(`  摘要  ${result.record.summary}`)
	if (result.record.note !== '') lines.push(`  备注  ${result.record.note}`)
	process.stdout.write(`${lines.join('\n')}\n`)
}

main().catch((error) => {
	process.stderr.write(`记录失败：${error?.message ?? String(error)}\n`)
	process.exitCode = 1
})
