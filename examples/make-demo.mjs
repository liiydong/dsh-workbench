/**
 * 造一份「演示项目」：假内容，真结构。
 *
 * 目的不是内容，是让人一眼看到工作模式长什么样：
 *   AI 改 md  →  生成 Word/PDF/Excel  →  人审 Word  →  反馈  →  再改 md
 *
 * 造出来的结构（examples/thesis-workbench/）：
 *   毕业论文/
 *     *.md                        ← 源（AI 改的就是这些）
 *     论文全文.docx                ← 当前产物（工作副本，名字永远不变）
 *     .versions/
 *       produced.jsonl            ← 每次产出追加一行（时间线、摘要、来源都在这）
 *       decisions.jsonl           ← 人的审批（通过 / 要改）
 *       2026-09-08T1432-论文全文.docx  ← 每次产出的快照（这才叫「版本存在」）
 *
 * 跑法：node examples/make-demo.mjs
 */

import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, 'thesis-workbench')

/* ---------- 造一个**真的** docx ---------- */

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
 * 造一个 zip：中央目录 + 若干条目（真 deflate 压缩）。
 *
 * @param entries - `{ name, text }` 数组。
 * @returns zip 的 Buffer。
 */
function makeZip(entries) {
	const locals = []
	const centrals = []
	let localOffset = 0
	for (const entry of entries) {
		const name = Buffer.from(entry.name, 'utf8')
		const body = Buffer.from(entry.text, 'utf8')
		const payload = deflateRawSync(body)
		const local = Buffer.alloc(30)
		local.writeUInt32LE(0x04034b50, 0)
		local.writeUInt16LE(20, 4)
		local.writeUInt16LE(8, 8)
		local.writeUInt32LE(crc32(body), 14)
		local.writeUInt32LE(payload.length, 18)
		local.writeUInt32LE(body.length, 22)
		local.writeUInt16LE(name.length, 26)
		const localBlock = Buffer.concat([local, name, payload])
		locals.push(localBlock)
		const central = Buffer.alloc(46)
		central.writeUInt32LE(0x02014b50, 0)
		central.writeUInt16LE(20, 4)
		central.writeUInt16LE(20, 6)
		central.writeUInt16LE(8, 10)
		central.writeUInt32LE(crc32(body), 16)
		central.writeUInt32LE(payload.length, 20)
		central.writeUInt32LE(body.length, 24)
		central.writeUInt16LE(name.length, 28)
		central.writeUInt32LE(localOffset, 42)
		centrals.push(Buffer.concat([central, name]))
		localOffset += localBlock.length
	}
	const centralBlock = Buffer.concat(centrals)
	const eocd = Buffer.alloc(22)
	eocd.writeUInt32LE(0x06054b50, 0)
	eocd.writeUInt16LE(entries.length, 8)
	eocd.writeUInt16LE(entries.length, 10)
	eocd.writeUInt32LE(centralBlock.length, 12)
	eocd.writeUInt32LE(Buffer.concat(locals).length, 16)
	return Buffer.concat([...locals, centralBlock, eocd])
}

/** XML 里必须躲开的两个字符。 */
const xmlSafe = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;')

/**
 * 把若干段落打成一个真正的 docx（zip + word/document.xml）。
 *
 * 演示数据必须是**真 Word**：插件的「和上一版比」要去解 docx 正文，
 * 假文本文件点进去只会得到一句「读不出」，演示就白放了。
 *
 * @param blocks - `{ kind, text }` 数组（kind: h1/h2/p/li/table/row）。
 * @returns docx 的 Buffer。
 */
function makeDocx(blocks) {
	const xml = ['<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="x"><w:body>']
	for (const block of blocks) {
		const style = block.kind === 'h1' ? '<w:pStyle w:val="Heading 1"/>' : block.kind === 'h2' ? '<w:pStyle w:val="Heading 2"/>' : ''
		const list = block.kind === 'li' ? '<w:numPr><w:ilvl w:val="0"/></w:numPr>' : ''
		const props = style === '' && list === '' ? '' : `<w:pPr>${style}${list}</w:pPr>`
		xml.push(`<w:p>${props}<w:r><w:t>${xmlSafe(block.text)}</w:t></w:r></w:p>`)
	}
	xml.push('</w:body></w:document>')
	return makeZip([{ name: 'word/document.xml', text: xml.join('') }])
}

/**
 * 把若干行打成一个真正的 xlsx（zip + workbook + rels + 一张表）。
 *
 * 表格的单位是**行**，所以演示里每一轮都让某几行变一变、某一行整行换掉，
 * 相邻两版之间才既有改动、又有没动的地方。
 *
 * @param rows - 二维数组；数字走数字单元格，别的走内联字符串。
 * @returns xlsx 的 Buffer。
 */
function makeXlsx(rows) {
	const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="x">${rows
		.map(
			(cells, r) =>
				`<row r="${r + 1}">${cells
					.map((value, c) => {
						const ref = `${String.fromCharCode(65 + c)}${r + 1}`
						return typeof value === 'number' ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${xmlSafe(value)}</t></is></c>`
					})
					.join('')}</row>`
		)
		.join('')}</worksheet>`
	return makeZip([
		{ name: '[Content_Types].xml', text: '<?xml version="1.0"?><Types/>' },
		{ name: 'xl/workbook.xml', text: '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns:r="rel"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>' },
		{ name: 'xl/_rels/workbook.xml.rels', text: '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>' },
		{ name: 'xl/worksheets/sheet1.xml', text: sheet }
	])
}

/* 时间从 9/8 铺到 9/17，最后几轮留在「待审」。 */
const T0 = new Date(2026, 8, 8, 9, 0, 0).getTime()
const HOUR = 3600 * 1000
const stamp = (ms) => {
	const d = new Date(ms)
	const p = (n) => String(n).padStart(2, '0')
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}`
}

/** 三条产线：源 md、产物、以及每一轮的「这版干了什么」。 */
const LINES = [
	{
		name: '毕业论文',
		sources: {
			'00-封面与摘要.md': '# 封面与摘要\n\n题目：乙苯苯乙烯分离工艺设计\n',
			'01-第一章-绪论.md': '# 第一章 绪论\n\n## 1.1 研究背景\n\n乙苯……\n',
			'02-第二章-文献综述.md': '# 第二章 文献综述\n\n## 2.1 分离方法比较\n',
			'03-第三章-物料衡算.md': '# 第三章 物料衡算\n\n| 组分 | 进料 | 出料 |\n|---|---|---|\n',
			'04-第四章-设备选型.md': '# 第四章 设备选型\n\n## 4.1 塔设备\n',
			'05-第五章-经济分析.md': '# 第五章 经济分析\n'
		},
		artifacts: [{ file: '论文全文.docx', kind: 'docx', tool: 'python thesis_docx.py', base: 38000 }],
		rounds: [
			['00-封面与摘要.md,01-第一章-绪论.md', '初稿：封面、摘要、第一章骨架'],
			['01-第一章-绪论.md', '第一章补研究背景与意义，加了 3 段'],
			['02-第二章-文献综述.md', '第二章重写：按「精馏 / 萃取 / 吸附」三类重新组织文献'],
			['03-第三章-物料衡算.md', '第三章：第一次物料衡算，塔顶塔底流量算出来了'],
			['03-第三章-物料衡算.md', '第三章：修正乙苯转化率 0.62→0.58，重算全表'],
			['03-第三章-物料衡算.md', '第三章：补了热量衡算小节，与物料衡算对账'],
			['04-第四章-设备选型.md', '第四章：塔径塔高初算，选了规整填料'],
			['04-第四章-设备选型.md', '第四章：按新流量重算塔径，D 由 1.2m 改到 1.4m'],
			['05-第五章-经济分析.md', '第五章：设备投资估算（系数法）+ 年均总成本'],
			['02-第二章-文献综述.md', '第二章：删掉两篇无法溯源的引用，补 DOI'],
			['03-第三章-物料衡算.md', '第三章：把衡算表改成三线表格式，数字对齐'],
			['05-第五章-经济分析.md', '第五章：敏感性分析加了蒸汽价格 ±20% 两档'],
			['00-封面与摘要.md', '摘要重写：把结论数字同步成最新衡算结果'],
			['04-第四章-设备选型.md', '第四章：补塔内件选型依据与压降校核']
		]
	},
	{
		name: 'Aspen流程模拟',
		sources: {
			'流程说明.md': '# 流程说明\n\n两塔流程：T-0401 粗分、T-0402 精制\n',
			'物性方法.md': '# 物性方法\n\n选用 RK-SOAVE……\n',
			'收敛记录.md': '# 收敛记录\n'
		},
		artifacts: [
			{ file: '流程模拟报告.docx', kind: 'docx', tool: 'python aspen_report_docx.py', base: 26000 },
			{ file: '工艺流程图.pdf', kind: 'pdf', tool: 'python export_pfd.py', base: 180000 },
			{ file: '物性数据表.xlsx', kind: 'xlsx', tool: 'python dump_props.py', base: 14000 }
		],
		rounds: [
			['流程说明.md', '建立两塔流程，RADFRAC 初设 30 块板'],
			['物性方法.md', '物性方法由 IDEAL 改为 RK-SOAVE，回流比降 0.3'],
			['收敛记录.md', 'T-0402 不收敛：改阻尼因子 0.3→0.1，收敛'],
			['流程说明.md', '补流程图导出脚本，PFD 自动出图'],
			['物性方法.md', '补二元交互参数来源说明'],
			['流程说明.md', '重算：进料位置由第 12 块改到第 16 块，分离度提升'],
			['收敛记录.md', '整理三次失败尝试，写成「踩坑记录」一节'],
			['物性方法.md', '物性数据表导出为 xlsx，含 12 组二元参数']
		]
	},
	{
		name: '经济分析',
		sources: {
			'成本估算.md': '# 成本估算\n\n设备投资 + 操作费用 + 折旧\n',
			'价格依据.md': '# 价格依据\n'
		},
		artifacts: [{ file: '经济分析表.xlsx', kind: 'xlsx', tool: 'python cost_sheet.py', base: 9000 }],
		rounds: [
			['成本估算.md', '第一版：设备投资用 0.6 次方法估算'],
			['价格依据.md', '补齐原料与公用工程价格来源（2026 年 8 月）'],
			['成本估算.md', '折旧年限 10 年改 15 年，年均成本降 8%'],
			['成本估算.md', '加敏感性分析：原料价格 ±15%'],
			['价格依据.md', '按最新报价更新蒸汽与电价格']
		]
	}
]

/* 人的审批：早几轮过了，中间一轮打回，最后几轮待审。 */
const DECISIONS = {
	'毕业论文': [
		[1, 'approved', '第一章可以，往下写'],
		[3, 'approved', '衡算表没问题'],
		[5, 'rejected', '热量衡算和物料衡算对不上，回去核'],
		[7, 'approved', '塔径改得对'],
		[11, 'approved', '敏感性分析够了']
	],
	Aspen流程模拟: [
		[2, 'approved', '收敛记录留好'],
		[5, 'approved', '进料位置这样合理']
	],
	经济分析: [[2, 'approved', '折旧年限按学校要求改对了']]
}

/* ---------- 开造 ---------- */

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })

let totalRounds = 0
const indexLines = []

for (const [lineIdx, line] of LINES.entries()) {
	const dir = join(ROOT, line.name)
	const versions = join(dir, '.versions')
	mkdirSync(versions, { recursive: true })

	for (const [name, body] of Object.entries(line.sources)) writeFileSync(join(dir, name), body, 'utf8')

	const produced = []
	const decisions = []
	let cursor = T0 + lineIdx * 6 * HOUR

	for (const [roundIdx, [sourceList, summary]] of line.rounds.entries()) {
		cursor += (2 + (roundIdx % 3)) * 6 * HOUR
		const artifact = line.artifacts[roundIdx % line.artifacts.length]
		const sources = sourceList.split(',')
		const id = `${stamp(cursor)}-${line.name}-${roundIdx + 1}`
		const snapName = `${stamp(cursor)}-${artifact.file}`
		const snapRel = `.versions/${snapName}`
		// docx / xlsx 产物写成**真容器**：里面放这一轮改了什么，好让「和上一版比」真有得比。
		// 每一轮都带着几行固定内容，于是相邻两版之间既有改动、也有没动的部分。
		const body =
			artifact.kind === 'docx'
				? makeDocx([
						{ kind: 'h1', text: `${artifact.file.replace('.docx', '')}　第 ${roundIdx + 1} 版` },
						{ kind: 'p', text: `摘要：${summary}` },
						{ kind: 'p', text: `改动来源：${sources.join(' + ')}` },
						{ kind: 'h2', text: '一、设计依据' },
						{ kind: 'p', text: '本设计以乙苯脱氢制苯乙烯为主线，年处理量 12 万吨。' },
						{ kind: 'p', text: '分离工段采用两塔流程：乙苯/苯乙烯分离塔与苯乙烯精制塔。' },
						{ kind: 'li', text: `第 ${roundIdx + 1} 轮的改动落在：${summary}` },
						{ kind: 'h2', text: '二、主要结果' },
						{ kind: 'p', text: `本轮结果：乙苯转化率 ${(0.62 - roundIdx * 0.01).toFixed(2)}，苯乙烯选择性 0.9${roundIdx % 10}。` }
					])
				: artifact.kind === 'xlsx'
					? makeXlsx([
							['项目', '数值', '单位', '备注'],
							['乙苯转化率', Number((0.62 - roundIdx * 0.01).toFixed(2)), '-', `第 ${roundIdx + 1} 轮`],
							['苯乙烯选择性', 0.9 + (roundIdx % 10) / 100, '-', ''],
							['塔顶压力', 38.5, 'kPa', '历轮不变'],
							['塔径', 1.2 + roundIdx * 0.05, 'm', roundIdx >= 3 ? '换过塔径' : '初版'],
							['本轮改动', summary, '', '']
						])
					: Buffer.from(
							[
								`[演示文件] ${artifact.file}`,
								`轮次 ${roundIdx + 1} / ${line.rounds.length}`,
								`时间 ${new Date(cursor).toLocaleString('zh-CN', { hour12: false })}`,
								`摘要 ${summary}`,
								`来源 ${sources.join(' + ')}`,
								'',
								'（这是假数据，内容无意义；真实场景下这里是一份真正的 Word/PDF/Excel）'
							].join('\n'),
							'utf8'
						)
		writeFileSync(join(versions, snapName), body)
		// 工作副本：名字永远不变，每次覆盖 —— 「最终版_真的最终版」就是这么消失的
		writeFileSync(join(dir, artifact.file), body)
		// 把两份文件的时间也拨回「记录里那一刻」：否则它们全是「刚写出来的」，
		// 「还没进记录」那一块会把整个演示项目都报成漏记的（真实产线也一样对不上）。
		const seconds = cursor / 1000
		utimesSync(join(versions, snapName), seconds, seconds)
		utimesSync(join(dir, artifact.file), seconds, seconds)

		produced.push({
			id,
			at: cursor,
			line: line.name,
			artifact: artifact.file,
			snapshot: snapRel,
			kind: artifact.kind,
			bytes: body.length,
			tool: artifact.tool,
			by: 'dsh',
			sources: sources.map((s) => ({ path: s })),
			summary
		})
		totalRounds++

		const decision = (DECISIONS[line.name] ?? []).find((d) => d[0] === roundIdx + 1)
		if (decision !== undefined) {
			decisions.push({
				id,
				at: cursor + 2 * HOUR,
				state: decision[1],
				by: 'human',
				note: decision[2]
			})
		}
	}

	writeFileSync(
		join(versions, 'produced.jsonl'),
		`${produced.map((p) => JSON.stringify(p)).join('\n')}\n`,
		'utf8'
	)
	writeFileSync(
		join(versions, 'decisions.jsonl'),
		decisions.length === 0 ? '' : `${decisions.map((d) => JSON.stringify(d)).join('\n')}\n`,
		'utf8'
	)
	indexLines.push(`| ${line.name} | ${line.rounds.length} 轮 | ${line.artifacts.map((a) => a.file).join('、')} |`)
}

writeFileSync(
	join(ROOT, 'README.md'),
	`# 演示项目（假数据）

这是 dsh-workbench「迭代」页的演示数据：结构是真的，内容全是假的。

| 产线 | 轮次 | 产物 |
|---|---|---|
${indexLines.join('\n')}

## 结构

每个产线目录里：

- \`*.md\` —— **源**，AI 改的就是这些；
- \`论文全文.docx\` 之类 —— **产物**，工作副本，名字永远不变（每次覆盖）；
- \`.versions/\` —— 记录 + 快照：
  - \`produced.jsonl\` 每次产出追加一行：时间、摘要、来源 md、工具、快照路径；
  - \`decisions.jsonl\` 人的审批：通过 / 要改 + 批注；
  - \`<时间>-<文件名>\` 每次产出的快照 —— **这才叫版本存在**。

## 工作模式

\`\`\`
AI 改 .md  →  跑脚本生成 docx/pdf/xlsx  →  写入 produced.jsonl + 快照
   ↑                                                    ↓
   └──────── 你给反馈 ←── 你在插件里审 Word ←───────────┘
\`\`\`

重新生成这份数据：\`node examples/make-demo.mjs\`
`,
	'utf8'
)

console.log(`演示数据已生成：${ROOT}`)
console.log(`  ${LINES.length} 条产线，共 ${totalRounds} 轮`)
for (const line of LINES) console.log(`    ${line.name}：${line.rounds.length} 轮 · ${line.artifacts.length} 种产物`)
