/**
 * dsh-workbench 浏览器半侧。
 *
 * 在左侧栏的「全局面板图标」座位（sidebar.panellist）注册一个图标，
 * 并在主区域座位（main）注册同 id 的面板体 —— 侧栏的图标点下去，
 * 中间就换成这个面板（这两个座位是成对的：id 一一对应）。
 *
 * 面板两页：
 *   「技能库」读宿主 /api/dsh-workbench/skills：本机所有技能（项目层 / 用户层
 *             ~/.agents/skills / 内置层），可搜索、可按来源过滤、点开读全文。
 *   「文档」  读 /api/dsh-workbench/docs：一个目录里的 md 源与 docx/pdf 产物配对，
 *             把「产物比源旧」的挑到最前面——这正是文档迭代纪律要盯的那件事。
 *
 * 没有构建步骤：手写 __ModuleLoader__ 包装，全部 react.createElement（不写 JSX）。
 * 零依赖：只用外壳提供的 react 与浏览器自带的 fetch。
 */

window.__ModuleLoader__.load({
	id: 'dsh-workbench',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
		const react = require('react')
		const h = react.createElement
		const { useState, useEffect, useMemo, useCallback, useRef } = react

		/** 宿主半侧的同一个前缀。 */
		const PREFIX = '/api/dsh-workbench'

		/* ==================== 主题 ==================== */

		/**
		 * 两套兜底色板。深色底用亮字、浅色底用深字——兜底值必须跟着主题换，
		 * 否则 DSH 万一没给 --dsw-alias-* 变量，浅色主题下会出现白底白字。
		 */
		const BASE_LIGHT = {
			text: '#1f2328',
			dim: '#6a737d',
			border: 'rgba(31, 35, 40, 0.15)',
			card: 'rgba(31, 35, 40, 0.035)',
			raised: 'rgba(31, 35, 40, 0.08)',
			accent: '#3b5bdb',
			ok: '#2b8a3e',
			warn: '#8a5a00',
			danger: '#c92a2a'
		}
		const BASE_DARK = {
			text: '#e9e9ec',
			dim: '#9b9ba4',
			border: 'rgba(233, 233, 236, 0.16)',
			card: 'rgba(233, 233, 236, 0.05)',
			raised: 'rgba(233, 233, 236, 0.11)',
			accent: '#4c6ef5',
			ok: '#3fb950',
			warn: '#d29922',
			danger: '#e5534b'
		}

		/** 优先用 DSH 的主题变量，取不到才用兜底——所以两种主题下都不会瞎。 */
		function paletteFor(base) {
			return {
				text: `var(--dsw-alias-label-primary, ${base.text})`,
				dim: `var(--dsw-alias-label-secondary, ${base.dim})`,
				border: `var(--dsw-alias-border-l2, ${base.border})`,
				card: `var(--dsw-alias-bg-layer-1, ${base.card})`,
				raised: `var(--dsw-alias-bg-layer-2, ${base.raised})`,
				accent: `var(--dsw-alias-state-business-primary, ${base.accent})`,
				radius: '8px',
				// 语义色是硬编码色，不随 CSS 变量走，所以深浅各一套。
				ok: base.ok,
				warn: base.warn,
				danger: base.danger
			}
		}
		const PALETTE_LIGHT = paletteFor(BASE_LIGHT)
		const PALETTE_DARK = paletteFor(BASE_DARK)

		/** 解析 `rgb()/rgba()` 文本。 */
		function parseColor(value) {
			const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(value || '')
			if (match === null) return null
			return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) }
		}
		/** 感知亮度，0 黑 1 白。 */
		const luminance = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255

		/**
		 * 探测当前主题。三层判据：
		 *   1. body / html 的**计算背景色**；
		 *   2. 背景透明时改看 --dsw-alias-label-primary 的亮度（**判据取反**：字亮=深色主题）；
		 *   3. prefers-color-scheme。
		 * 不假设宿主用什么类名或变量，取不到就往下退。
		 */
		function detectScheme() {
			try {
				if (typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
					for (const el of [document.body, document.documentElement]) {
						if (el === null || el === undefined) continue
						const c = parseColor(getComputedStyle(el).backgroundColor)
						if (c !== null && c.a > 0.1) return luminance(c) < 0.5 ? 'dark' : 'light'
					}
					const label = getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-label-primary')
					const lc = parseColor(label)
					if (lc !== null) return luminance(lc) > 0.5 ? 'dark' : 'light'
				}
			} catch {
				/* 探测失败不该让面板崩掉 */
			}
			try {
				if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
			} catch {
				/* 同上 */
			}
			return 'light'
		}

		/** 订阅主题变化：根元素属性 MutationObserver + matchMedia，两者都可缺省。 */
		function usePalette() {
			const [scheme, setScheme] = useState(detectScheme)
			useEffect(() => {
				const sync = () => setScheme(detectScheme())
				let observer = null
				try {
					if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
						observer = new MutationObserver(sync)
						observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
					}
				} catch {
					observer = null
				}
				let media = null
				try {
					if (typeof matchMedia === 'function') {
						media = matchMedia('(prefers-color-scheme: dark)')
						if (typeof media.addEventListener === 'function') media.addEventListener('change', sync)
						else if (typeof media.addListener === 'function') media.addListener(sync)
					}
				} catch {
					media = null
				}
				return () => {
					if (observer !== null) observer.disconnect()
					try {
						if (media !== null && typeof media.removeEventListener === 'function') media.removeEventListener('change', sync)
						else if (media !== null && typeof media.removeListener === 'function') media.removeListener(sync)
					} catch {
						/* 清理失败无所谓 */
					}
				}
			}, [])
			return scheme === 'dark' ? PALETTE_DARK : PALETTE_LIGHT
		}

		/* ==================== 取数据 ==================== */

		/** 统一取 JSON：任何失败都变成 { error } 而不是抛出去。 */
		async function getJson(url) {
			try {
				const response = await fetch(url, { headers: { accept: 'application/json' } })
				const text = await response.text()
				let body = null
				try {
					body = JSON.parse(text)
				} catch {
					return { error: `返回的不是 JSON（HTTP ${response.status}）` }
				}
				return body ?? { error: '空响应' }
			} catch (error) {
				return { error: error?.message ?? String(error) }
			}
		}

		/* ==================== 基本构件 ==================== */

		const rowStyle = (palette, extra) => ({
			display: 'flex',
			alignItems: 'center',
			gap: '8px',
			...extra
		})

		/** 小徽章。 */
		function Badge({ palette, text, tone }) {
			const color = tone === 'ok' ? palette.ok : tone === 'warn' ? palette.warn : tone === 'danger' ? palette.danger : palette.dim
			return h(
				'span',
				{
					style: {
						fontSize: '11px',
						lineHeight: '16px',
						padding: '0 6px',
						borderRadius: '999px',
						border: `1px solid ${color}`,
						color,
						whiteSpace: 'nowrap'
					}
				},
				text
			)
		}

		/** 文字按钮。 */
		function Button({ palette, label, onClick, disabled, tone }) {
			const color = tone === 'accent' ? palette.accent : palette.text
			return h(
				'button',
				{
					type: 'button',
					onClick,
					disabled: disabled === true,
					style: {
						font: 'inherit',
						fontSize: '12px',
						padding: '4px 10px',
						borderRadius: palette.radius,
						border: `1px solid ${palette.border}`,
						background: palette.card,
						color: disabled === true ? palette.dim : color,
						cursor: disabled === true ? 'default' : 'pointer'
					}
				},
				label
			)
		}

		/** 输入框。 */
		function Input({ palette, value, onChange, placeholder, onEnter, style }) {
			return h('input', {
				type: 'text',
				value,
				placeholder,
				onChange: (event) => onChange(event.target.value),
				onKeyDown: (event) => {
					if (event.key === 'Enter' && typeof onEnter === 'function') onEnter()
				},
				style: {
					font: 'inherit',
					fontSize: '12px',
					padding: '5px 8px',
					borderRadius: palette.radius,
					border: `1px solid ${palette.border}`,
					background: 'transparent',
					color: palette.text,
					outline: 'none',
					...style
				}
			})
		}

		/** 时间戳 → 本地短格式。 */
		function when(ms) {
			if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
			try {
				return new Date(ms).toLocaleString('zh-CN', { hour12: false })
			} catch {
				return ''
			}
		}

		/** 距今多久。 */
		function ago(ms) {
			if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
			const delta = Date.now() - ms
			if (delta < 60000) return '刚刚'
			if (delta < 3600000) return `${Math.floor(delta / 60000)} 分钟前`
			if (delta < 86400000) return `${Math.floor(delta / 3600000)} 小时前`
			return `${Math.floor(delta / 86400000)} 天前`
		}

		/* ==================== 技能库页 ==================== */

		/** 来源标签的中文名。 */
		const SOURCE_LABEL = {
			'user-agents': '用户 · .agents',
			'user-dsh': '用户 · .dsh',
			'project-agents': '项目 · .agents',
			'project-dsh': '项目 · .dsh',
			runtime: '运行时',
			bundled: '内置',
			custom: '自定义'
		}
		const sourceLabel = (source) => SOURCE_LABEL[source] ?? (source === '' ? '未知来源' : source)

		function SkillsTab({ palette }) {
			const [status, setStatus] = useState('loading')
			const [skills, setSkills] = useState([])
			const [complete, setComplete] = useState(false)
			const [error, setError] = useState('')
			const [query, setQuery] = useState('')
			const [source, setSource] = useState('')
			const [open, setOpen] = useState(null)

			const load = useCallback(async () => {
				setStatus('loading')
				setError('')
				const body = await getJson(`${PREFIX}/skills`)
				if (typeof body.error === 'string' && !Array.isArray(body.skills)) {
					setError(body.error)
					setStatus('error')
					return
				}
				setSkills(Array.isArray(body.skills) ? body.skills : [])
				setComplete(body.complete === true)
				setStatus('ready')
			}, [])

			useEffect(() => {
				load()
			}, [load])

			/** 打开一个技能读全文。 */
			const openSkill = useCallback(async (name) => {
				setOpen({ name, status: 'loading', content: '', error: '' })
				const body = await getJson(`${PREFIX}/skill?name=${encodeURIComponent(name)}`)
				if (typeof body.error === 'string' && typeof body.content !== 'string') {
					setOpen({ name, status: 'error', content: '', error: body.error })
					return
				}
				setOpen({ name, status: 'ready', content: typeof body.content === 'string' ? body.content : '', error: '', path: body.path ?? '' })
			}, [])

			const sources = useMemo(() => {
				const counts = new Map()
				for (const skill of skills) counts.set(skill.source, (counts.get(skill.source) ?? 0) + 1)
				return [...counts.entries()].sort((a, b) => b[1] - a[1])
			}, [skills])

			const shown = useMemo(() => {
				const needle = query.trim().toLowerCase()
				return skills.filter((skill) => {
					if (source !== '' && skill.source !== source) return false
					if (needle === '') return true
					return (
						String(skill.name).toLowerCase().includes(needle) ||
						String(skill.description).toLowerCase().includes(needle) ||
						String(skill.whenToUse ?? '').toLowerCase().includes(needle)
					)
				})
			}, [skills, query, source])

			return h(
				'div',
				{ style: { display: 'flex', minHeight: 0, flex: 1 } },
				// 左：目录
				h(
					'div',
					{ style: { width: '44%', minWidth: '240px', display: 'flex', flexDirection: 'column', minHeight: 0, borderRight: `1px solid ${palette.border}` } },
					h(
						'div',
						{ style: { padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px' } },
						h(
							'div',
							{ style: rowStyle(palette) },
							h(Input, { palette, value: query, onChange: setQuery, placeholder: '搜索技能名 / 描述 / 触发词', style: { flex: 1 } }),
							h(Button, { palette, label: '刷新', onClick: load, disabled: status === 'loading' })
						),
						h(
							'div',
							{ style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
							h(Badge, { palette, text: `全部 ${skills.length}`, tone: source === '' ? 'accent' : undefined }),
							...sources.map(([key, count]) =>
								h(
									'span',
									{
										key,
										onClick: () => setSource(source === key ? '' : key),
										style: { cursor: 'pointer' },
										title: `只看 ${sourceLabel(key)}`
									},
									h(Badge, { palette, text: `${sourceLabel(key)} ${count}`, tone: source === key ? 'accent' : undefined })
								)
							)
						),
						complete === false && status === 'ready'
							? h('div', { style: { fontSize: '11px', color: palette.warn } }, '注意：技能发现未完成，列表可能不全')
							: null
					),
					h(
						'div',
						{ style: { overflowY: 'auto', flex: 1, padding: '0 10px 10px' } },
						status === 'loading' ? h('div', { style: { color: palette.dim, fontSize: '12px' } }, '读取中…') : null,
						status === 'error' ? h('div', { style: { color: palette.danger, fontSize: '12px' } }, error) : null,
						...shown.map((skill) =>
							h(
								'div',
								{
									key: skill.name,
									onClick: () => openSkill(skill.name),
									style: {
										padding: '8px',
										marginBottom: '6px',
										borderRadius: palette.radius,
										border: `1px solid ${open !== null && open.name === skill.name ? palette.accent : palette.border}`,
										background: palette.card,
										cursor: 'pointer'
									}
								},
								h(
									'div',
									{ style: rowStyle(palette, { justifyContent: 'space-between' }) },
									h('span', { style: { fontSize: '13px', color: palette.text, fontWeight: 600 } }, skill.name),
									h(Badge, { palette, text: sourceLabel(skill.source) })
								),
								h(
									'div',
									{ style: { fontSize: '12px', color: palette.dim, marginTop: '4px', lineHeight: '1.5' } },
									String(skill.description).slice(0, 140)
								)
							)
						),
						status === 'ready' && shown.length === 0
							? h('div', { style: { color: palette.dim, fontSize: '12px' } }, '没有匹配的技能')
							: null
					)
				),
				// 右：全文
				h(
					'div',
					{ style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 } },
					open === null
						? h(
								'div',
								{ style: { padding: '16px', color: palette.dim, fontSize: '12px', lineHeight: '1.7' } },
								'左边点一个技能，这里显示它的 SKILL.md 全文。',
								h('br'),
								'技能目录来自 DSH 核心注册表 —— 也就是模型实际会加载的那一份。'
							)
						: h(
								'div',
								{ style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
								h(
									'div',
									{ style: { padding: '10px', borderBottom: `1px solid ${palette.border}` } },
									h('div', { style: { fontSize: '13px', color: palette.text, fontWeight: 600 } }, open.name),
									open.path
										? h('div', { style: { fontSize: '11px', color: palette.dim, marginTop: '3px', wordBreak: 'break-all' } }, open.path)
										: null
								),
								h(
									'div',
									{ style: { overflow: 'auto', flex: 1, padding: '12px' } },
									open.status === 'loading' ? h('div', { style: { color: palette.dim, fontSize: '12px' } }, '读取中…') : null,
									open.status === 'error' ? h('div', { style: { color: palette.danger, fontSize: '12px' } }, open.error) : null,
									open.status === 'ready'
										? h(
												'pre',
												{
													style: {
														margin: 0,
														fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
														fontSize: '12px',
														lineHeight: '1.65',
														color: palette.text,
														whiteSpace: 'pre-wrap',
														wordBreak: 'break-word'
													}
												},
												open.content
											)
										: null
								)
							)
				)
			)
		}

		/* ==================== 文档页 ==================== */

		/** 配对状态的样子。 */
		const STATE_META = {
			stale: { label: '产物过期', tone: 'danger', hint: '产物比源旧：改过 md 却没重新生成' },
			orphan: { label: '无源产物', tone: 'warn', hint: '只有产物没有同名源' },
			pending: { label: '未生成产物', tone: undefined, hint: '源还没有对应产物' },
			ok: { label: '已同步', tone: 'ok', hint: '产物不比源旧' }
		}

		function DocsTab({ palette }) {
			const [dir, setDir] = useState(() => {
				try {
					return localStorage.getItem('dsh-workbench.dir') ?? ''
				} catch {
					return ''
				}
			})
			const [workspaces, setWorkspaces] = useState([])
			const [data, setData] = useState(null)
			const [error, setError] = useState('')
			const [busy, setBusy] = useState(false)

			useEffect(() => {
				let alive = true
				getJson(`${PREFIX}/workspaces`).then((body) => {
					if (!alive) return
					setWorkspaces(Array.isArray(body.workspaces) ? body.workspaces : [])
				})
				return () => {
					alive = false
				}
			}, [])

			const scan = useCallback(async (target) => {
				const wanted = (target ?? '').trim()
				if (wanted === '') {
					setError('先填一个目录')
					return
				}
				setBusy(true)
				setError('')
				try {
					localStorage.setItem('dsh-workbench.dir', wanted)
				} catch {
					/* 隐私模式下写不了，无所谓 */
				}
				const body = await getJson(`${PREFIX}/docs?dir=${encodeURIComponent(wanted)}`)
				setBusy(false)
				if (typeof body.error === 'string' && body.exists === false) {
					setData(null)
					setError(body.error)
					return
				}
				if (typeof body.error === 'string' && !Array.isArray(body.pairs)) {
					setData(null)
					setError(body.error)
					return
				}
				setData(body)
			}, [])

			const pairs = data !== null && Array.isArray(data.pairs) ? data.pairs : []
			const counts = data?.counts ?? { stale: 0, orphan: 0, pending: 0, ok: 0 }

			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
				h(
					'div',
					{ style: { padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', borderBottom: `1px solid ${palette.border}` } },
					h(
						'div',
						{ style: rowStyle(palette) },
						h(Input, { palette, value: dir, onChange: setDir, placeholder: '要看的目录，例如 D:\\项目\\毕业论文', onEnter: () => scan(dir), style: { flex: 1 } }),
						h(Button, { palette, label: busy ? '扫描中…' : '扫描', onClick: () => scan(dir), disabled: busy, tone: 'accent' })
					),
					workspaces.length > 0
						? h(
								'div',
								{ style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
								...workspaces.map((workspace) =>
									h(
										'span',
										{ key: workspace.id || workspace.path, onClick: () => { setDir(workspace.path); scan(workspace.path) }, style: { cursor: 'pointer' }, title: workspace.path },
										h(Badge, { palette, text: workspace.title || workspace.path })
									)
								)
							)
						: null,
					data !== null
						? h(
								'div',
								{ style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
								h(Badge, { palette, text: `过期 ${counts.stale}`, tone: counts.stale > 0 ? 'danger' : 'ok' }),
								h(Badge, { palette, text: `无源产物 ${counts.orphan}`, tone: counts.orphan > 0 ? 'warn' : undefined }),
								h(Badge, { palette, text: `未生成 ${counts.pending}` }),
								h(Badge, { palette, text: `已同步 ${counts.ok}`, tone: 'ok' }),
								h('span', { style: { fontSize: '11px', color: palette.dim } }, `共 ${data.entries?.length ?? 0} 个文档相关文件`)
							)
						: null,
					error !== '' ? h('div', { style: { fontSize: '12px', color: palette.danger } }, error) : null
				),
				h(
					'div',
					{ style: { overflow: 'auto', flex: 1, padding: '10px' } },
					data === null
						? h(
								'div',
								{ style: { color: palette.dim, fontSize: '12px', lineHeight: '1.7' } },
								'填一个目录（或点上面已登记的工作区），扫描后这里按「该先处理」的顺序列出配对：',
								h('br'),
								'产物比源旧 → 红色「产物过期」；只有产物 → 黄色「无源产物」。'
							)
						: h(
								'div',
								{ style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
								...pairs.map((pair) => {
									const meta = STATE_META[pair.state] ?? STATE_META.ok
									return h(
										'div',
										{
											key: pair.stem,
											title: meta.hint,
											style: {
												display: 'flex',
												alignItems: 'center',
												gap: '10px',
												padding: '7px 9px',
												borderRadius: palette.radius,
												border: `1px solid ${palette.border}`,
												background: palette.card
											}
										},
										h(Badge, { palette, text: meta.label, tone: meta.tone }),
										h(
											'div',
											{ style: { flex: 1, minWidth: 0 } },
											h('div', { style: { fontSize: '12px', color: palette.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, pair.stem),
											h(
												'div',
												{ style: { fontSize: '11px', color: palette.dim, marginTop: '2px' } },
												`源 ${pair.source === null ? '—' : pair.source.name}（${pair.source === null ? '' : ago(pair.source.mtime)}）  →  产物 ${pair.artifact === null ? '—' : pair.artifact.name}（${pair.artifact === null ? '' : ago(pair.artifact.mtime)}）`
											)
										),
										pair.state === 'stale' && pair.lagMs > 0
											? h('span', { style: { fontSize: '11px', color: palette.danger, whiteSpace: 'nowrap' } }, `落后 ${ago(Date.now() - pair.lagMs)}`)
											: null
									)
								}),
								pairs.length === 0 ? h('div', { style: { color: palette.dim, fontSize: '12px' } }, '这个目录里没有 md/docx/pdf 之类的文档') : null,
								data.truncated === true
									? h('div', { style: { color: palette.warn, fontSize: '11px', marginTop: '6px' } }, '目录太大，只列出了前一部分文件')
									: null
							)
				)
			)
		}

		/* ==================== 面板与图标 ==================== */

		/** 侧栏图标（横幅 + 把手），用 currentColor 跟随侧栏配色。 */
		function WorkbenchIcon(props) {
			const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 18
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 1.7,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					role: 'img',
					'aria-label': '工作台'
				},
				h('rect', { x: 3, y: 7.5, width: 18, height: 12.5, rx: 2 }),
				h('path', { d: 'M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5' }),
				h('path', { d: 'M3 12.5h18' }),
				h('path', { d: 'M10 12.5v2h4v-2' })
			)
		}

		/** 面板主体：两个页签。 */
		function WorkbenchPanel() {
			const palette = usePalette()
			const [tab, setTab] = useState('skills')
			const tabButton = (key, label) =>
				h(
					'button',
					{
						type: 'button',
						onClick: () => setTab(key),
						style: {
							font: 'inherit',
							fontSize: '12px',
							padding: '5px 12px',
							borderRadius: palette.radius,
							border: `1px solid ${tab === key ? palette.accent : palette.border}`,
							background: tab === key ? palette.raised : 'transparent',
							color: tab === key ? palette.accent : palette.dim,
							cursor: 'pointer'
						}
					},
					label
				)
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'transparent', color: palette.text } },
				h(
					'div',
					{ style: { padding: '12px 12px 8px', display: 'flex', alignItems: 'center', gap: '10px' } },
					h('div', { style: { fontSize: '14px', fontWeight: 600 } }, '工作台'),
					h('div', { style: { display: 'flex', gap: '6px' } }, tabButton('skills', '技能库'), tabButton('docs', '文档')),
					h(
						'div',
						{ style: { marginLeft: 'auto', fontSize: '11px', color: palette.dim } },
						tab === 'skills' ? '模型实际会加载的那份技能目录' : '源与产物的配对状态'
					)
				),
				h('div', { style: { height: '1px', background: palette.border } }),
				tab === 'skills' ? h(SkillsTab, { palette }) : h(DocsTab, { palette })
			)
		}

		/* ==================== 注册 ==================== */

		/** 需要客户端服务：插槽服务。 */
		const inject = ['slots']

		/**
		 * 两个座位成对注册：侧栏图标（sidebar.panellist）与主面板（main）用同一个 id，
		 * 侧栏点图标 → 主区域派发同名 key → 换成这个面板。
		 * 注册挂在插槽服务的 effect 上，插件卸载时一起消失。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.slots.inject('sidebar.panellist', () =>
				ctx.slots.register({ name: 'sidebar.panellist', id: 'workbench', order: 10, label: () => '工作台' }, WorkbenchIcon)
			)
			ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'workbench' }, WorkbenchPanel))
		}

		exports.apply = apply
		exports.inject = inject
		exports.__internals = { WorkbenchIcon, WorkbenchPanel, SkillsTab, DocsTab, detectScheme, sourceLabel, STATE_META }
		return module.exports
	}
})
