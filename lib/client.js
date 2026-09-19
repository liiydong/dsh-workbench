/**
 * dsh-workbench 浏览器半侧。
 *
 * 在左侧栏的「全局面板图标」座位（sidebar.panellist）注册一个图标，
 * 并在主区域座位（main）注册同 id 的面板体 —— 侧栏的图标点下去，
 * 中间就换成这个面板（这两个座位是成对的：id 一一对应）。
 *
 * 面板三页：
 *   「迭代」  读宿主 /api/dsh-workbench/history：按产线 × 按天的版本时间轴，
 *             悬停看这一版干了什么，点开写审批（.versions/decisions.jsonl）。
 *   「技能库」读宿主 /api/dsh-workbench/skills：本机所有技能（项目层 / 用户层
 *             ~/.agents/skills / 内置层），可搜索、可按来源过滤、点开读全文。
 *   「文档」  读 /api/dsh-workbench/docs：一个目录里的 md 源与 docx/pdf 产物配对，
 *             把「产物比源旧」的挑到最前面——这正是文档迭代纪律要盯的那件事。
 *
 * 目录不用手打：迭代页与文档页的「浏览…」调 DSH 自己的目录选择服务
 * （ctx.get('uiWorkspace').pickDirectory()）——本地部署弹操作系统原生的选文件夹框，
 * 远程或进程内部署换成它的应用内浏览流程；两种组合都只把选中的绝对路径交回来。
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

		/** 发一个 JSON（本插件唯一的写操作走这里：记审批）。 */
		async function postJson(url, payload) {
			try {
				const response = await fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload)
				})
				const text = await response.text()
				try {
					return JSON.parse(text)
				} catch {
					return { error: `返回的不是 JSON（HTTP ${response.status}）` }
				}
			} catch (error) {
				return { error: error?.message ?? String(error) }
			}
		}

		/* ==================== 宿主能力（目录选择） ==================== */

		/**
		 * 客户端根上下文。apply 时记下来，之后面板要调宿主服务时用。
		 *
		 * 为什么留着 ctx 现取服务、而不是在 apply 里把服务存成变量：
		 * `uiWorkspace` 可能晚于本插件激活（客户端插件树按需装载），而 ctx.get 是
		 * **调用那一刻**才解析服务——插件先挂上、服务后到的顺序也不会拿到 undefined。
		 * 服务缺失时降级成「手动填路径」，而不是让面板报错。
		 */
		let rootContext = null

		/** 取一个客户端服务；没装、没启用、或取不到都返回 undefined。 */
		function serviceOf(name) {
			try {
				if (rootContext === null || typeof rootContext.get !== 'function') return undefined
				return rootContext.get(name) ?? undefined
			} catch {
				return undefined
			}
		}

		/**
		 * 打开宿主的系统目录选择框。
		 *
		 * 走 DSH 自己的目录选择服务：本地部署弹**操作系统原生**的选文件夹对话框
		 * （Windows/macOS），远程或进程内部署下 DSH 会换成它的应用内浏览流程——
		 * 两种组合都会把用户选中的**绝对路径**交回来：插件不自己画目录树，
		 * 也不需要任何文件系统权限。
		 *
		 * @returns 选中 → `{ path }`；用户取消 → `{ path: null }`；不可用或失败 → `{ error }`。
		 */
		async function pickDirectory() {
			const service = serviceOf('uiWorkspace')
			if (service === undefined || typeof service.pickDirectory !== 'function') {
				return { path: null, error: '这台机器上没有可用的目录选择器，请手动粘贴路径。' }
			}
			try {
				const path = await service.pickDirectory()
				return { path: typeof path === 'string' && path !== '' ? path : null, error: '' }
			} catch (error) {
				return { path: null, error: `打不开系统目录选择框：${error?.message ?? String(error)}` }
			}
		}

		/** 宿主有没有「列目录」这条能力（browse 组合有，原生组合没有）。 */
		function canListDirectory() {
			const service = serviceOf('uiWorkspace')
			return service !== undefined && typeof service.listDirectory === 'function'
		}

		/**
		 * 列一层目录。数据全部来自宿主：插件**不碰文件系统、也不拼路径**，
		 * 拿到的每条都是宿主给的绝对路径。
		 * @param target - 绝对路径；空串表示宿主的主目录。
		 */
		async function listDirectory(target) {
			const service = serviceOf('uiWorkspace')
			if (service === undefined || typeof service.listDirectory !== 'function') {
				throw new Error('这台机器上没有可用的目录服务')
			}
			return await service.listDirectory(target === '' ? undefined : target)
		}

		/**
		 * 「浏览…」的决策：先问宿主的原生选择框，不行再退回应用内浏览器。
		 *
		 * 为什么要有这条降级：DSH 的目录选择是**按部署自己挑后端**的——绑定在
		 * 127.0.0.1 的本地部署挂原生选择器，其它情况（监听局域网、SSH 启动、
		 * 远程浏览器）挂 browse 后端，那种组合里 `pick()` 会被宿主**明确拒绝**
		 * （"pick needs the native capability; the composed picker serves browse"），
		 * 但它同时提供 `listDirectory`——官方自己的「添加工作区」在那种组合下
		 * 用的就是应用内浏览对话框，这里做的是同一件事。
		 *
		 * @returns 选中 `{ path }`；用户取消 `{}`；要用应用内浏览器 `{ open: true }`；
		 *   两条路都走不通 `{ error }`。
		 */
		async function chooseDirectory() {
			const picked = await pickDirectory()
			if (picked.path !== null) return { path: picked.path }
			if (picked.error === '') return {}
			if (!canListDirectory()) return { error: picked.error }
			return { open: true }
		}

		/**
		 * 回当前会话：主区域从全局面板切回会话界面。
		 *
		 * 用布局服务的 `selectPanel(null)`——它的契约就是「null 显示当前会话」，
		 * 且**不改变当前会话**（只是把中央区域换回去）。这也正是左栏里
		 * 再点一次同一枚面板图标会发生的事，所以不会产生第三种状态。
		 *
		 * @returns 真的切了 true；宿主没有布局服务、或切换被拒 false。
		 */
		function backToConversation() {
			const service = serviceOf('layout')
			if (service === undefined || typeof service.selectPanel !== 'function') return false
			try {
				service.selectPanel(null)
				return true
			} catch {
				// selectPanel 对没注册的 key 会抛错；传 null 不该抛，抛了就当作切不动。
				return false
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
		function Button({ palette, label, onClick, disabled, tone, title }) {
			const color = tone === 'accent' ? palette.accent : palette.text
			return h(
				'button',
				{
					type: 'button',
					onClick,
					disabled: disabled === true,
					title: typeof title === 'string' ? title : undefined,
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

		/* ==================== 应用内目录浏览器 ==================== */

		/**
		 * 「选一个文件夹」对话框：宿主组合的是 browse 后端（没有操作系统原生选择框）时用它。
		 *
		 * 只做三件事：列当前层、进子目录、采纳当前目录。每一层的路径都来自宿主的
		 * `listDirectory`，插件不自己拼路径、也不读文件系统——所以它和官方那套
		 * 目录选择器拿到的是同一份事实。
		 *
		 * @param props.palette - 当前主题色板。
		 * @param props.onCancel - 用户放弃选择。
		 * @param props.onPick - 用户采纳了某个绝对路径。
		 */
		function DirectoryDialog({ palette, onCancel, onPick }) {
			const [listing, setListing] = useState(null)
			const [status, setStatus] = useState('loading')
			const [error, setError] = useState('')
			const [draft, setDraft] = useState('')

			/** 读一层。target 为空串 = 宿主主目录。 */
			const open = useCallback(async (target) => {
				setStatus('loading')
				setError('')
				try {
					const next = await listDirectory(target ?? '')
					setListing(next)
					setDraft(typeof next?.path === 'string' ? next.path : '')
					setStatus('ready')
				} catch (err) {
					setListing(null)
					setStatus('error')
					setError(`读不到这个目录：${err?.message ?? String(err)}`)
				}
			}, [])

			useEffect(() => {
				open('')
			}, [open])

			const entries = Array.isArray(listing?.entries) ? listing.entries : []
			const crumbs = Array.isArray(listing?.crumbs) ? listing.crumbs : []
			const parent = crumbs.length >= 2 ? crumbs[crumbs.length - 2].path : ''
			const current = listing !== null && typeof listing.path === 'string' ? listing.path : ''

			/** 采纳当前目录。 */
			const confirm = () => {
				if (current !== '') onPick(current)
			}

			return h(
				'div',
				{
					style: {
						position: 'fixed',
						top: 0,
						left: 0,
						right: 0,
						bottom: 0,
						zIndex: 500,
						background: 'rgba(0, 0, 0, 0.35)',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						padding: '24px'
					},
					onClick: onCancel
				},
				h(
					'div',
					{
						onClick: (event) => event?.stopPropagation?.(),
						style: {
							width: '560px',
							maxWidth: '100%',
							maxHeight: '78vh',
							display: 'flex',
							flexDirection: 'column',
							background: palette.raised,
							color: palette.text,
							border: `1px solid ${palette.border}`,
							borderRadius: palette.radius,
							boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
							overflow: 'hidden'
						}
					},
					// 标题 + 当前路径
					h(
						'div',
						{ style: { padding: '12px 14px', borderBottom: `1px solid ${palette.border}` } },
						h('div', { style: { fontSize: '13px', fontWeight: 600 } }, '选一个文件夹'),
						h(
							'div',
							{ style: { fontSize: '11px', color: palette.dim, marginTop: '3px', wordBreak: 'break-all' } },
							listing === null ? '正在读宿主的主目录…' : current
						)
					),
					// 手输路径 + 上一层 + 回主目录
					h(
						'div',
						{ style: { padding: '10px 14px', display: 'flex', gap: '8px', alignItems: 'center', borderBottom: `1px solid ${palette.border}` } },
						h(Input, { palette, value: draft, onChange: setDraft, onEnter: () => open(draft), placeholder: '绝对路径，回车跳转', style: { flex: 1 } }),
						h(Button, { palette, label: '上一层', onClick: () => open(parent), disabled: parent === '' }),
						h(Button, { palette, label: '主目录', onClick: () => open(listing?.home ?? ''), disabled: listing === null })
					),
					// 面包屑
					crumbs.length > 0
						? h(
								'div',
								{ style: { padding: '8px 14px 0', display: 'flex', flexWrap: 'wrap', gap: '4px' } },
								...crumbs.map((crumb, index) =>
									h(
										'span',
										{
											key: `${crumb.path}#${index}`,
											onClick: () => open(crumb.path),
											title: crumb.path,
											style: { fontSize: '11px', color: palette.accent, cursor: 'pointer' }
										},
										index === crumbs.length - 1 ? crumb.name : `${crumb.name} / `
									)
								)
							)
						: null,
					// 子目录列表
					h(
						'div',
						{ style: { overflow: 'auto', flex: 1, padding: '10px 14px' } },
						status === 'loading' ? h('div', { style: { fontSize: '12px', color: palette.dim } }, '读取中…') : null,
						status === 'error' ? h('div', { style: { fontSize: '12px', color: palette.danger } }, error) : null,
						...entries.map((entry) =>
							h(
								'div',
								{
									key: entry.path,
									onClick: () => open(entry.path),
									title: entry.path,
									style: {
										padding: '6px 8px',
										marginBottom: '4px',
										borderRadius: palette.radius,
										border: `1px solid ${palette.border}`,
										background: palette.card,
										cursor: 'pointer',
										fontSize: '12px',
										opacity: entry.hidden === true ? 0.6 : 1
									}
								},
								`📁 ${entry.name}`
							)
						),
						status === 'ready' && entries.length === 0
							? h('div', { style: { fontSize: '12px', color: palette.dim } }, '这个文件夹里没有子文件夹——点下面「选这个文件夹」就是选它。')
							: null,
						listing?.truncated === true
							? h('div', { style: { fontSize: '11px', color: palette.warn, marginTop: '4px' } }, '子文件夹太多，宿主只列出了前一部分')
							: null
					),
					// 动作
					h(
						'div',
						{ style: { padding: '10px 14px', borderTop: `1px solid ${palette.border}`, display: 'flex', gap: '8px', alignItems: 'center' } },
						h('span', { style: { fontSize: '11px', color: palette.dim, flex: 1 } }, '选中即读取该文件夹'),
						h(Button, { palette, label: '取消', onClick: onCancel }),
						h(Button, { palette, label: '选这个文件夹', onClick: confirm, disabled: current === '', tone: 'accent' })
					)
				)
			)
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

		function SkillsTab({ palette, view, patch }) {
			const [status, setStatus] = useState('loading')
			const [skills, setSkills] = useState([])
			const [complete, setComplete] = useState(false)
			const [error, setError] = useState('')
			/** 搜索词留在本地：连续打字不该一步一条历史记录。 */
			const [query, setQuery] = useState('')
			/** 全文的加载结果；「打开了哪个技能」本身在 view.open 里（那是导航状态）。 */
			const [detail, setDetail] = useState(null)
			const open = view.open
			const source = view.source

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

			/** 打开一个技能：这里只记一步，全文交给下面的 effect 去读。 */
			const openSkill = useCallback((name) => patch({ open: name }), [patch])

			// 「打开了哪个技能」是导航状态：首次进来、以及后退/前进回来时，都按 view.open 重新读全文。
			useEffect(() => {
				if (open === '') {
					setDetail(null)
					return undefined
				}
				let alive = true
				setDetail({ status: 'loading', content: '', error: '', path: '' })
				getJson(`${PREFIX}/skill?name=${encodeURIComponent(open)}`).then((body) => {
					if (!alive) return
					if (typeof body.error === 'string' && typeof body.content !== 'string') {
						setDetail({ status: 'error', content: '', error: body.error, path: '' })
						return
					}
					setDetail({ status: 'ready', content: typeof body.content === 'string' ? body.content : '', error: '', path: body.path ?? '' })
				})
				return () => {
					alive = false
				}
			}, [open])

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
				{ style: { display: 'flex', flexWrap: 'wrap', minHeight: 0, flex: 1 } },
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
										onClick: () => patch({ source: source === key ? '' : key }),
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
										border: `1px solid ${open === skill.name ? palette.accent : palette.border}`,
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
					{ style: { flex: 1, minWidth: '260px', display: 'flex', flexDirection: 'column', minHeight: 0 } },
					open === ''
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
									h('div', { style: { fontSize: '13px', color: palette.text, fontWeight: 600 } }, open),
									detail?.path
										? h('div', { style: { fontSize: '11px', color: palette.dim, marginTop: '3px', wordBreak: 'break-all' } }, detail.path)
										: null
								),
								h(
									'div',
									{ style: { overflow: 'auto', flex: 1, padding: '12px' } },
									detail === null || detail.status === 'loading' ? h('div', { style: { color: palette.dim, fontSize: '12px' } }, '读取中…') : null,
									detail?.status === 'error' ? h('div', { style: { color: palette.danger, fontSize: '12px' } }, detail.error) : null,
									detail?.status === 'ready'
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
												detail.content
											)
										: null
								)
							)
				)
			)
		}

		/* ==================== 文档页 ==================== */

		/**
		 * 一份「配对状态有没有变」的摘要：指纹 + 主干名集合。
		 * 文档页要盯的是「产物过期」这种判定，所以两边的 mtime 也要进指纹。
		 */
		function docsWatchOf(body) {
			const ids = new Set()
			const parts = []
			for (const pair of body?.pairs ?? []) {
				ids.add(pair.stem)
				parts.push(`${pair.stem}|${pair.state}|${pair.source?.mtime ?? 0}|${pair.artifact?.mtime ?? 0}`)
			}
			parts.sort()
			return { key: parts.join('\n'), ids }
		}

		/** 配对状态的样子。 */
		const STATE_META = {
			stale: { label: '产物过期', tone: 'danger', hint: '产物比源旧：改过 md 却没重新生成' },
			orphan: { label: '无源产物', tone: 'warn', hint: '只有产物没有同名源' },
			pending: { label: '未生成产物', tone: undefined, hint: '源还没有对应产物' },
			ok: { label: '已同步', tone: 'ok', hint: '产物不比源旧' }
		}

		function DocsTab({ palette, view, patch }) {
			const [workspaces, setWorkspaces] = useState([])
			const [data, setData] = useState(null)
			const [error, setError] = useState('')
			const [busy, setBusy] = useState(false)
			/** 应用内目录浏览器开着没有（宿主没有原生选择框时走它）。 */
			const [picking, setPicking] = useState(false)
			/** 目录是导航状态（进历史栈）；输入框里正在编辑的文本留在本地，打字不入栈。 */
			const dir = view.dir
			const [draft, setDraft] = useState(dir)

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

			// 目录一变（后退/前进、浏览选中、点工作区徽章）就重扫；首次进来若记得上次的目录也扫。
			const lastDir = useRef(null)
			useEffect(() => {
				if (lastDir.current === dir) return
				lastDir.current = dir
				setDraft(dir)
				if (dir.trim() !== '') scan(dir)
			}, [dir, scan])

			/** 去一个目录：同一个目录当刷新，新目录记一步（由上面的 effect 去扫）。 */
			const goTo = useCallback(
				(path) => {
					const wanted = (path ?? '').trim()
					if (wanted === '') return
					if (wanted === dir) scan(wanted)
					else patch({ dir: wanted })
				},
				[dir, patch, scan]
			)

			/** 「浏览…」：先试系统选择框，宿主不给就用应用内目录浏览器。 */
			const browse = useCallback(async () => {
				const choice = await chooseDirectory()
				if (choice.error !== undefined) {
					setError(choice.error)
					return
				}
				if (choice.open === true) {
					setPicking(true)
					return
				}
				if (choice.path === undefined) return
				goTo(choice.path)
			}, [goTo])

			/** 应用内浏览器选定了目录。 */
			const adopt = useCallback(
				(path) => {
					setPicking(false)
					goTo(path)
				},
				[goTo]
			)

			/** 当前这一屏的指纹；自动检测拿它当「已知状态」的基准。 */
			const snapshot = useMemo(() => (data === null ? null : docsWatchOf(data)), [data])
			/** 探一次：重新扫一遍目录，只算指纹，不动屏幕上的东西。 */
			const probe = useCallback(async () => {
				if (dir === '') return null
				const body = await getJson(`${PREFIX}/docs?dir=${encodeURIComponent(dir)}`)
				if (body.exists === false || !Array.isArray(body.pairs)) return null
				return docsWatchOf(body)
			}, [dir])
			const reload = useCallback(() => scan(dir), [dir, scan])
			const fresh = useFreshWatch({ dir, snapshot, probe, reload })

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
						h(Input, { palette, value: draft, onChange: setDraft, placeholder: '要看的目录，例如 D:\\项目\\毕业论文', onEnter: () => goTo(draft), style: { flex: 1 } }),
						h(Button, { palette, label: '浏览…', onClick: browse, disabled: busy, title: '打开系统文件夹选择框' }),
						h(Button, { palette, label: busy ? '扫描中…' : '扫描', onClick: () => goTo(draft), disabled: busy, tone: 'accent' }),
						h(Button, { palette, label: autoLabel(fresh.every), onClick: fresh.cycleEvery, title: '点一下换一档：10 秒 / 30 秒 / 1 分钟 / 关' })
					),
					workspaces.length > 0
						? h(
								'div',
								{ style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
								...workspaces.map((workspace) =>
									h(
										'span',
										{ key: workspace.id || workspace.path, onClick: () => goTo(workspace.path), style: { cursor: 'pointer' }, title: workspace.path },
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
					error !== '' ? h('div', { style: { fontSize: '12px', color: palette.danger } }, error) : null,
					h(FreshBar, { palette, fresh, unit: '份文档' })
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
												pair.source === null
													? `源 —　→　产物 ${pair.artifact.name}（${ago(pair.artifact.mtime)}）`
													: pair.artifact === null
														? `源 ${pair.source.name}（${ago(pair.source.mtime)}）　→　产物 —`
														: `源 ${pair.source.name}（${ago(pair.source.mtime)}）　→　产物 ${pair.artifact.name}（${ago(pair.artifact.mtime)}）`
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
				),
				// 应用内目录浏览器（宿主没有原生选择框时的降级）
				picking
					? h(DirectoryDialog, {
							palette,
							onCancel: () => setPicking(false),
							onPick: adopt
						})
					: null
			)
		}

		/* ==================== 迭代页（md 源 ↔ Word 产物 ↔ 你的审批） ==================== */

		/**
		 * 一份「迭代记录有没有变」的摘要：指纹字符串 + 轮次 id 集合。
		 *
		 * 只取 id / 审批状态 / 体积 / 快照路径——它们动了才说明记录真的变了。
		 * 用指纹而不是整份数据去比，是因为轮询只回答一个问题：变没变。
		 */
		function watchOf(body) {
			const ids = new Set()
			const parts = []
			for (const line of body?.lines ?? []) {
				for (const round of line.rounds ?? []) {
					ids.add(round.id)
					parts.push(`${round.id}|${round.approval?.state ?? ''}|${round.bytes ?? 0}|${round.snapshot ?? ''}`)
				}
			}
			parts.sort()
			return { key: parts.join('\n'), ids }
		}

		/** 产物类型的样子。 */
		const KIND_META = {
			docx: { label: 'Word', color: '#2f6fdb' },
			pdf: { label: 'PDF', color: '#c0392b' },
			xlsx: { label: 'Excel', color: '#2b8a3e' },
			pptx: { label: 'PPT', color: '#c2410c' },
			md: { label: 'MD', color: '#6a737d' }
		}
		const kindMeta = (kind) => KIND_META[kind] ?? { label: kind === '' ? '文件' : kind.toUpperCase(), color: '#6a737d' }

		/** 审批状态。 */
		const APPROVAL_META = {
			pending: { label: '待我审', tone: 'warn', hint: '还没看你这一版' },
			approved: { label: '已通过', tone: 'ok', hint: '你放行了这一版' },
			rejected: { label: '要改', tone: 'danger', hint: '你打回了这一版' }
		}
		const approvalMeta = (state) => APPROVAL_META[state] ?? APPROVAL_META.pending

		/** 时间戳 → HH:MM。 */
		function clockOf(ms) {
			if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
			try {
				return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
			} catch {
				return ''
			}
		}

		function IterationTab({ palette, view, patch }) {
			const [status, setStatus] = useState('idle')
			const [data, setData] = useState(null)
			const [error, setError] = useState('')
			const [hover, setHover] = useState(null)
			const [busy, setBusy] = useState(false)
			/** 应用内目录浏览器开着没有（宿主没有原生选择框时走它）。 */
			const [picking, setPicking] = useState(false)
			/**
			 * 目录、选中的轮次、筛选是**导航状态**（进历史栈）；
			 * 列表数据、加载中、悬停卡是结果，不进。输入框里正在编辑的文本也不进。
			 */
			const dir = view.dir
			const filter = view.filter
			const pickedId = view.pickedId
			const [draft, setDraft] = useState(dir)

			const load = useCallback(async (target) => {
				const wanted = (target ?? '').trim()
				if (wanted === '') {
					setError('先填一个项目目录，或点「载入演示」')
					return
				}
				setStatus('loading')
				setError('')
				try {
					localStorage.setItem('dsh-workbench.iterDir', wanted)
				} catch {
					/* 隐私模式写不了，无所谓 */
				}
				const body = await getJson(`${PREFIX}/history?dir=${encodeURIComponent(wanted)}`)
				if (body.exists === false || (typeof body.error === 'string' && !Array.isArray(body.lines))) {
					setData(null)
					setStatus('idle')
					setError(body.error ?? '读不到这个目录')
					return
				}
				setData(body)
				setStatus('ready')
			}, [])

			// 目录一变（后退/前进、浏览选中、载入演示）就重读；首次进来若记得上次的目录也读。
			const lastDir = useRef(null)
			useEffect(() => {
				if (lastDir.current === dir) return
				lastDir.current = dir
				setDraft(dir)
				if (dir.trim() !== '') load(dir)
			}, [dir, load])

			/** 去一个目录：同一个目录当刷新，新目录记一步（由上面的 effect 去读）。 */
			const goTo = useCallback(
				(path) => {
					const wanted = (path ?? '').trim()
					if (wanted === '') return
					if (wanted === dir) load(wanted)
					else patch({ dir: wanted })
				},
				[dir, patch, load]
			)

			const loadDemo = useCallback(async () => {
				const body = await getJson(`${PREFIX}/demo`)
				if (typeof body.dir === 'string' && body.dir !== '') goTo(body.dir)
				else setError('取不到演示目录')
			}, [goTo])

			/** 「浏览…」：先试系统选择框，宿主不给就用应用内目录浏览器。 */
			const browse = useCallback(async () => {
				const choice = await chooseDirectory()
				if (choice.error !== undefined) {
					setError(choice.error)
					return
				}
				if (choice.open === true) {
					setPicking(true)
					return
				}
				if (choice.path === undefined) return
				goTo(choice.path)
			}, [goTo])

			/** 应用内浏览器选定了目录。 */
			const adopt = useCallback(
				(path) => {
					setPicking(false)
					goTo(path)
				},
				[goTo]
			)

			/** 记一次审批，然后重新拉一遍（记录是追加式的，以文件为准）。 */
			const decide = useCallback(
				async (round, nextState) => {
					const line = round?.line ?? ''
					if (line === '' || data === null) return
					setBusy(true)
					const body = await postJson(`${PREFIX}/decide`, {
						dir: data.dir,
						line,
						id: round.id,
						state: nextState,
						note: round.approval?.note ?? '',
						by: 'human'
					})
					setBusy(false)
					if (typeof body.error === 'string') {
						setError(body.error)
						return
					}
					patch({ pickedId: '' })
					await load(data.dir)
				},
				[data, load, patch]
			)

			const lines = data !== null && Array.isArray(data.lines) ? data.lines : []
			const totals = data?.totals ?? { rounds: 0, pending: 0, approved: 0, rejected: 0, lines: 0 }

			const shown = useMemo(() => {
				return lines
					.filter((line) => filter.line === '' || line.name === filter.line)
					.map((line) => ({
						...line,
						rounds: line.rounds.filter((round) => {
							if (filter.state !== '' && round.approval.state !== filter.state) return false
							if (filter.kind !== '' && round.kind !== filter.kind) return false
							return true
						})
					}))
					.filter((line) => line.rounds.length > 0)
			}, [lines, filter])

			/** 选中的那一轮按 id 从当前数据里找回来——后退/前进回来时数据可能已经重读过。 */
			const picked = useMemo(() => {
				if (pickedId === '' || data === null || !Array.isArray(data.lines)) return null
				for (const line of data.lines) {
					for (const round of line.rounds ?? []) if (round.id === pickedId) return round
				}
				return null
			}, [pickedId, data])

			const toggle = (key, value) => patch({ filter: { ...filter, [key]: filter[key] === value ? '' : value } })

			/** 当前这一屏的指纹；自动检测拿它当「已知状态」的基准。 */
			const snapshot = useMemo(() => (data === null ? null : watchOf(data)), [data])
			/** 探一次：重新读一遍记录，只算指纹，不动屏幕上的东西。 */
			const probe = useCallback(async () => {
				if (dir === '') return null
				const body = await getJson(`${PREFIX}/history?dir=${encodeURIComponent(dir)}`)
				if (body.exists === false || !Array.isArray(body.lines)) return null
				return watchOf(body)
			}, [dir])
			const reload = useCallback(() => load(dir), [dir, load])
			const fresh = useFreshWatch({ dir, snapshot, probe, reload })

			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
				// 顶栏：目录 + 筛选
				h(
					'div',
					{ style: { padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', borderBottom: `1px solid ${palette.border}` } },
					h(
						'div',
						{ style: rowStyle(palette) },
						h(Input, { palette, value: draft, onChange: setDraft, placeholder: '项目目录（里面每个子目录是一条产线）', onEnter: () => goTo(draft), style: { flex: 1 } }),
						h(Button, { palette, label: '浏览…', onClick: browse, disabled: status === 'loading', title: '打开系统文件夹选择框' }),
						h(Button, { palette, label: status === 'loading' ? '读取中…' : '读取', onClick: () => goTo(draft), disabled: status === 'loading', tone: 'accent' }),
						h(Button, { palette, label: '载入演示', onClick: loadDemo }),
						h(Button, { palette, label: autoLabel(fresh.every), onClick: fresh.cycleEvery, title: '点一下换一档：10 秒 / 30 秒 / 1 分钟 / 关' })
					),
					data !== null
						? h(
								'div',
								{ style: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' } },
								h(
									'span',
									{ onClick: () => patch({ filter: { ...EMPTY_FILTER } }), style: { cursor: 'pointer' }, title: '清除筛选' },
									h(Badge, { palette, text: `全部 ${totals.rounds} 轮`, tone: filter.state === '' && filter.kind === '' && filter.line === '' ? 'accent' : undefined })
								),
								...['pending', 'approved', 'rejected'].map((state) =>
									h(
										'span',
										{ key: state, onClick: () => toggle('state', state), style: { cursor: 'pointer' }, title: approvalMeta(state).hint },
										h(Badge, { palette, text: `${approvalMeta(state).label} ${totals[state]}`, tone: filter.state === state ? 'accent' : approvalMeta(state).tone })
									)
								),
								h('span', { style: { width: '10px' } }),
								...lines.map((line) =>
									h(
										'span',
										{ key: line.name, onClick: () => toggle('line', line.name), style: { cursor: 'pointer' }, title: line.artifacts.join('、') },
										h(Badge, { palette, text: `${line.name} ${line.rounds.length}`, tone: filter.line === line.name ? 'accent' : undefined })
									)
								),
								h('span', { style: { width: '10px' } }),
								...[...new Set(lines.flatMap((line) => line.kinds))].map((kind) =>
									h(
										'span',
										{ key: kind, onClick: () => toggle('kind', kind), style: { cursor: 'pointer' } },
										h(Badge, { palette, text: `${kindMeta(kind).label}`, tone: filter.kind === kind ? 'accent' : undefined })
									)
								)
							)
						: null,
					error !== '' ? h('div', { style: { fontSize: '12px', color: palette.danger } }, error) : null,
					h(FreshBar, { palette, fresh, unit: '轮' })
				),
				// 主体：归类树 + 时间轴
				h(
					'div',
					{ style: { overflow: 'auto', flex: 1, padding: '10px' }, onMouseLeave: () => setHover(null) },
					data === null
						? h(
								'div',
								{ style: { color: palette.dim, fontSize: '12px', lineHeight: '1.8' } },
								'这里显示「谁改了什么 → 生成了哪一版 → 你审没审」。',
								h('br'),
								'点右上角「载入演示」可以直接看一份假数据的效果。',
								h('br'),
								h('br'),
								'记录的格式：每个产线目录下的 ',
								h('code', { style: { color: palette.text } }, '.versions/produced.jsonl'),
								'（产出）与 ',
								h('code', { style: { color: palette.text } }, '.versions/decisions.jsonl'),
								'（审批）。'
							)
						: h(
								'div',
								{ style: { display: 'flex', flexDirection: 'column', gap: '14px' } },
								...shown.map((line) =>
									h(
										'div',
										{ key: line.name },
										// 产线头
										h(
											'div',
											{ style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' } },
											h('span', { style: { fontSize: '13px', fontWeight: 600, color: palette.text } }, line.name),
											h(Badge, { palette, text: `${line.rounds.length} 轮` }),
											...line.kinds.map((kind) => h(Badge, { key: kind, palette, text: kindMeta(kind).label })),
											h('span', { style: { fontSize: '11px', color: palette.dim } }, line.artifacts.join('、'))
										),
										// 时间轴：按天分小节
										...[...new Set(line.rounds.map((round) => round.day))].map((day) =>
											h(
												'div',
												{ key: day, style: { marginLeft: '6px', borderLeft: `2px solid ${palette.border}`, paddingLeft: '12px', marginBottom: '10px' } },
												h('div', { style: { fontSize: '11px', color: palette.dim, marginBottom: '5px' } }, day),
												...line.rounds
													.filter((round) => round.day === day)
													.map((round) => {
														const meta = approvalMeta(round.approval.state)
														const kind = kindMeta(round.kind)
														const isPicked = pickedId !== '' && pickedId === round.id
														return h(
															'div',
															{
																key: round.id,
																onClick: () => patch({ pickedId: isPicked ? '' : round.id }),
																onMouseEnter: (event) => {
																	let rect = null
																	try {
																		rect = event?.currentTarget?.getBoundingClientRect?.() ?? null
																	} catch {
																		rect = null
																	}
																	setHover({ round, rect })
																},
																style: {
																	display: 'flex',
																	alignItems: 'center',
																	gap: '8px',
																	padding: '6px 9px',
																	marginBottom: '5px',
																	borderRadius: palette.radius,
																	border: `1px solid ${isPicked ? palette.accent : palette.border}`,
																	background: isPicked ? palette.raised : palette.card,
																	cursor: 'pointer'
																}
															},
															h('span', { style: { fontSize: '11px', color: palette.dim, width: '38px', whiteSpace: 'nowrap' } }, clockOf(round.at)),
															h('span', { style: { fontSize: '11px', color: kind.color, width: '42px' } }, kind.label),
															h(
																'span',
																{ style: { flex: 1, minWidth: 0, fontSize: '12px', color: palette.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
																round.summary === '' ? round.artifact : round.summary
															),
															round.sources.length > 0
																? h('span', { style: { fontSize: '11px', color: palette.dim, whiteSpace: 'nowrap' } }, `源 ${round.sources.length}`)
																: null,
															h(Badge, { palette, text: meta.label, tone: meta.tone })
														)
													})
											)
										)
									)
								),
								shown.length === 0 ? h('div', { style: { color: palette.dim, fontSize: '12px' } }, '没有匹配的轮次') : null
							)
				),
				// 悬停卡（follows the pointer row）
				hover !== null
					? h(
							'div',
							{
								style: {
									position: 'fixed',
									left: `${Math.max(12, Math.min((hover.rect?.right ?? 320) + 12, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 380))}px`,
									top: `${Math.max(12, (hover.rect?.top ?? 80) - 6)}px`,
									width: '340px',
									zIndex: 40,
									pointerEvents: 'none',
									background: palette.raised,
									border: `1px solid ${palette.accent}`,
									borderRadius: palette.radius,
									padding: '10px 12px',
									boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
									backdropFilter: 'blur(6px)'
								}
							},
							h('div', { style: { fontSize: '12px', fontWeight: 600, color: palette.text } }, hover.round.summary === '' ? hover.round.artifact : hover.round.summary),
							h(
								'div',
								{ style: { fontSize: '11px', color: palette.dim, marginTop: '5px', lineHeight: '1.7' } },
								`${hover.round.line} · ${hover.round.artifact}`,
								h('br'),
								`产出：${when(hover.round.at)}　${hover.round.bytesText}`,
								hover.round.tool !== '' ? h('br', null) : null,
								hover.round.tool !== '' ? `方式：${hover.round.tool}` : null,
								hover.round.sources.length > 0 ? h('br', null) : null,
								hover.round.sources.length > 0 ? `改动来源：${hover.round.sources.map((s) => s.path).join('、')}` : null,
								hover.round.snapshot !== '' ? h('br', null) : null,
								hover.round.snapshot !== '' ? `快照：${hover.round.snapshot}` : null,
								hover.round.approval.state !== 'pending' ? h('br', null) : null,
								hover.round.approval.state !== 'pending'
									? `你的意见：${approvalMeta(hover.round.approval.state).label}${hover.round.approval.note === '' ? '' : ` —— ${hover.round.approval.note}`}`
									: null
							)
						)
					: null,
				// 选中轮次：审批动作
				picked !== null
					? h(
							'div',
							{ style: { borderTop: `1px solid ${palette.border}`, padding: '10px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
							h('span', { style: { fontSize: '12px', color: palette.text, fontWeight: 600 } }, picked.artifact),
							h('span', { style: { fontSize: '11px', color: palette.dim } }, `${picked.line} · ${when(picked.at)}`),
							h(Badge, { palette, text: approvalMeta(picked.approval.state).label, tone: approvalMeta(picked.approval.state).tone }),
							h('span', { style: { flex: 1 } }),
							h(Button, { palette, label: busy ? '写入中…' : '通过', onClick: () => decide(picked, 'approved'), disabled: busy, tone: 'accent' }),
							h(Button, { palette, label: '要改', onClick: () => decide(picked, 'rejected'), disabled: busy }),
							h(Button, { palette, label: '重置为待审', onClick: () => decide(picked, 'pending'), disabled: busy })
						)
					: null,
				// 应用内目录浏览器（宿主没有原生选择框时的降级）
				picking
					? h(DirectoryDialog, {
							palette,
							onCancel: () => setPicking(false),
							onPick: adopt
						})
					: null
			)
		}

		/* ==================== 视图状态（上一步 / 下一步） ==================== */

		/**
		 * 面板的**导航状态**：只有「用户明确做的一步」才进历史栈——
		 * 切页签、换目录、打开一个技能、点开某一轮、改筛选。
		 *
		 * 列表数据、加载中、悬停卡这些是**结果**不是步骤，进来只会让后退变吵；
		 * 搜索框里的连续打字同理，不是一步（回车或刷新才算）。
		 */
		const EMPTY_FILTER = { state: '', kind: '', line: '' }

		/** 读上次用过的目录（隐私模式下读不到就是空串）。 */
		function remembered(key) {
			try {
				return localStorage.getItem(key) ?? ''
			} catch {
				return ''
			}
		}

		/** 面板的起始视图：页签从头开始，目录沿用上次的。 */
		const initialState = () => ({
			tab: 'iteration',
			iter: { dir: remembered('dsh-workbench.iterDir'), pickedId: '', filter: { ...EMPTY_FILTER } },
			docs: { dir: remembered('dsh-workbench.dir') },
			skills: { open: '', source: '' }
		})

		/** 两个视图状态是不是同一处——决定这一步要不要入栈。 */
		const sameState = (a, b) =>
			a.tab === b.tab &&
			a.iter.dir === b.iter.dir &&
			a.iter.pickedId === b.iter.pickedId &&
			a.iter.filter.state === b.iter.filter.state &&
			a.iter.filter.kind === b.iter.filter.kind &&
			a.iter.filter.line === b.iter.filter.line &&
			a.docs.dir === b.docs.dir &&
			a.skills.open === b.skills.open &&
			a.skills.source === b.skills.source

		/* ==================== 「这个目录有没有新东西」 ==================== */

		/**
		 * 自动检测的档位：10 秒 → 30 秒 → 1 分钟 → 关 → 回到 10 秒。
		 *
		 * 默认 10 秒：产线的记录是「跑完一个脚本追加一行」，等一分钟才看见太钝；
		 * 而探一次只是重新读一遍本地记录文件，对 127.0.0.1 来说可以忽略。
		 */
		const AUTO_STEPS = [10000, 30000, 60000, 0]

		const autoLabel = (ms) => (ms <= 0 ? '自动：关' : `自动：${ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.round(ms / 1000)} 秒`}`)

		/** 读上次选的档位；读不到、或值不认识，就回到默认。 */
		function rememberedEvery() {
			const raw = remembered('dsh-workbench.autoEvery')
			if (raw === '') return AUTO_STEPS[0]
			const value = Number(raw)
			return AUTO_STEPS.includes(value) ? value : AUTO_STEPS[0]
		}

		/**
		 * 「这个目录有没有新内容」的自动检测。
		 *
		 * 它只负责**发现**：每隔 `every` 毫秒探一次，内容变了就把一条提示放出来；
		 * 换不换屏幕上的东西由用户点「现在刷新」决定——你正看着一屏时间轴，
		 * 它自己跳走比不刷新更烦。探不到（目录被删之类）就当没变化，不打扰。
		 *
		 * @param dir - 正在看的目录；空串不探。
		 * @param snapshot - 当前这一屏的指纹与 id 集合；null = 还没有内容，没什么可更新的。
		 * @param probe - 异步探一次，返回 `{ key, ids }` 或 null。
		 * @param reload - 用户确认后重新加载这一屏。
		 * @returns `{ every, cycleEvery, pending, apply, dismiss }`。
		 */
		function useFreshWatch({ dir, snapshot, probe, reload }) {
			const [every, setEvery] = useState(rememberedEvery)
			const [pending, setPending] = useState(null)
			const known = useRef({ key: '', ids: new Set() })
			const dismissed = useRef('')
			const probeRef = useRef(probe)
			probeRef.current = probe

			const cycleEvery = useCallback(() => {
				const next = AUTO_STEPS[(AUTO_STEPS.indexOf(every) + 1) % AUTO_STEPS.length]
				try {
					localStorage.setItem('dsh-workbench.autoEvery', String(next))
				} catch {
					/* 隐私模式写不了，无所谓 */
				}
				setEvery(next)
			}, [every])

			// 屏幕上换了内容 → 它就成了新的「已知状态」，提示也该收了。
			useEffect(() => {
				if (snapshot === null) return
				known.current = snapshot
				dismissed.current = ''
				setPending(null)
			}, [snapshot])

			useEffect(() => {
				if (every <= 0 || dir === '' || snapshot === null) return undefined
				const tick = async () => {
					// 页面在后台就不探了：看不见的时候刷新没意义，还白白读盘。
					if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
					const seen = await probeRef.current()
					if (seen === null) return
					if (seen.key === known.current.key) {
						setPending(null)
						return
					}
					// 点过「稍后」的那一版就别再提了，等内容再变一次再说。
					if (seen.key === dismissed.current) return
					let added = 0
					for (const id of seen.ids) if (!known.current.ids.has(id)) added += 1
					setPending({ added, key: seen.key })
				}
				const timer = setInterval(tick, every)
				return () => clearInterval(timer)
			}, [every, dir, snapshot])

			const apply = useCallback(() => {
				setPending(null)
				reload()
			}, [reload])

			const dismiss = useCallback(() => {
				setPending((current) => {
					if (current !== null) dismissed.current = current.key
					return null
				})
			}, [])

			return { every, cycleEvery, pending, apply, dismiss }
		}

		/** 一条「有新内容」的提示条。两页长得一样，所以只写一份。 */
		function FreshBar({ palette, fresh, unit }) {
			if (fresh.pending === null) return null
			return h(
				'div',
				{
					style: {
						display: 'flex',
						alignItems: 'center',
						gap: '8px',
						padding: '6px 8px',
						borderRadius: palette.radius,
						border: `1px solid ${palette.accent}`,
						background: palette.card
					}
				},
				h(
					'span',
					{ style: { flex: 1, fontSize: '12px', color: palette.text } },
					fresh.pending.added > 0 ? `这个目录有新内容：多了 ${fresh.pending.added} ${unit}` : '这个目录有新内容（有的记录变了）'
				),
				h(Button, { palette, label: '现在刷新', onClick: fresh.apply, tone: 'accent' }),
				h(Button, { palette, label: '稍后', onClick: fresh.dismiss, title: '先不管它；等内容再变一次再提醒' })
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

		/**
		 * 上一步 / 下一步的箭头。
		 *
		 * 不用 `←` `→` 那两个字符：它们在正文里又细又小，放大还容易跟中文字形不搭。
		 * 画成 chevron（像浏览器那对），线宽和圆角自己说了算，颜色跟着 currentColor 走。
		 */
		function StepIcon({ direction, size }) {
			const edge = typeof size === 'number' && size > 0 ? size : 17
			const back = direction === 'back'
			return h(
				'svg',
				{
					width: edge,
					height: edge,
					viewBox: '0 0 24 24',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: 2.2,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					role: 'img',
					'aria-label': back ? '上一步' : '下一步'
				},
				h('path', { d: back ? 'M14.5 5.5 8 12l6.5 6.5' : 'M9.5 5.5 16 12l-6.5 6.5' })
			)
		}

		/**
		 * 面板主体：三个页签 + 上一步/下一步 + 返回对话。
		 *
		 * 历史栈：`state` 是当前视图，`past` 是走过的、`future` 是退回来的。
		 * 两个栈放 ref（它们不参与渲染），另用一个很小的 `steps` 只管两个按钮灰不灰。
		 */
		function WorkbenchPanel() {
			const palette = usePalette()
			const [state, setState] = useState(initialState)
			const past = useRef([])
			const future = useRef([])
			const latest = useRef(null)
			if (latest.current === null) latest.current = state
			const [steps, setSteps] = useState({ back: 0, forward: 0 })

			/** 落定一个新视图，并让两个步数按钮跟着变。 */
			const settle = useCallback((next) => {
				latest.current = next
				setState(next)
				setSteps({ back: past.current.length, forward: future.current.length })
			}, [])

			/** 记一步：视图真的变了才入栈，而且新的一步会清掉「下一步」那条线。 */
			const navigate = useCallback(
				(patch) => {
					const merged = { ...latest.current, ...patch }
					if (sameState(latest.current, merged)) return
					past.current = [...past.current, latest.current]
					future.current = []
					settle(merged)
				},
				[settle]
			)

			const back = useCallback(() => {
				if (past.current.length === 0) return
				const previous = past.current[past.current.length - 1]
				future.current = [latest.current, ...future.current]
				past.current = past.current.slice(0, -1)
				settle(previous)
			}, [settle])

			const forward = useCallback(() => {
				if (future.current.length === 0) return
				const next = future.current[0]
				past.current = [...past.current, latest.current]
				future.current = future.current.slice(1)
				settle(next)
			}, [settle])

			// 每页各拿一个「只改自己那格」的函数。latest 是 ref，所以这三个引用稳定。
			const patchIter = useCallback((p) => navigate({ iter: { ...latest.current.iter, ...p } }), [navigate])
			const patchDocs = useCallback((p) => navigate({ docs: { ...latest.current.docs, ...p } }), [navigate])
			const patchSkills = useCallback((p) => navigate({ skills: { ...latest.current.skills, ...p } }), [navigate])

			/**
			 * 有没有布局服务。客户端插件树按需装载，这个服务可能晚到——
			 * 所以每次渲染都现问一次，而不是在 apply 里定死。
			 */
			const canReturn = serviceOf('layout') !== undefined
			const tabButton = (key, label) =>
				h(
					'button',
					{
						type: 'button',
						onClick: () => navigate({ tab: key }),
						style: {
							font: 'inherit',
							fontSize: '12px',
							padding: '5px 12px',
							borderRadius: palette.radius,
							border: `1px solid ${state.tab === key ? palette.accent : palette.border}`,
							background: state.tab === key ? palette.raised : 'transparent',
							color: state.tab === key ? palette.accent : palette.dim,
							cursor: 'pointer'
						}
					},
					label
				)
			const [hoverStep, setHoverStep] = useState('')
			/** 方形图标按钮：28×28，够大够点，悬停有底色，退到底时半透明。 */
			const stepButton = (direction, title, onClick, disabled) => {
				const hovered = hoverStep === direction && disabled !== true
				return h(
					'button',
					{
						type: 'button',
						onClick,
						disabled: disabled === true,
						title,
						'aria-label': direction === 'back' ? '上一步' : '下一步',
						onMouseEnter: () => setHoverStep(direction),
						onMouseLeave: () => setHoverStep(''),
						style: {
							display: 'inline-flex',
							alignItems: 'center',
							justifyContent: 'center',
							width: '28px',
							height: '28px',
							padding: 0,
							flex: '0 0 auto',
							borderRadius: palette.radius,
							border: `1px solid ${hovered ? palette.accent : palette.border}`,
							background: disabled === true ? 'transparent' : hovered ? palette.raised : palette.card,
							color: disabled === true ? palette.dim : palette.text,
							opacity: disabled === true ? 0.45 : 1,
							cursor: disabled === true ? 'default' : 'pointer'
						}
					},
					h(StepIcon, { direction, size: 17 })
				)
			}
			return h(
				'div',
				{ style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'transparent', color: palette.text } },
				h(
					'div',
					{ style: { padding: '12px 12px 8px', display: 'flex', alignItems: 'center', gap: '10px' } },
					stepButton('back', `上一步（还能退 ${steps.back} 步）`, back, steps.back === 0),
					stepButton('forward', `下一步（还能进 ${steps.forward} 步）`, forward, steps.forward === 0),
					h('div', { style: { fontSize: '14px', fontWeight: 600 } }, '工作台'),
					h('div', { style: { display: 'flex', gap: '6px' } }, tabButton('iteration', '迭代'), tabButton('skills', '技能库'), tabButton('docs', '文档')),
					h(
						'div',
						{ style: { marginLeft: 'auto', fontSize: '11px', color: palette.dim } },
						state.tab === 'skills'
							? '模型实际会加载的那份技能目录'
							: state.tab === 'docs'
								? '源与产物的配对状态'
								: 'AI 改 md → 生成 Word → 你审这一版'
					),
					// 面板占了中央区域时，一键回当前会话；宿主没有布局服务就不放这个按钮
					canReturn
						? h(Button, { palette, label: '← 返回对话', onClick: backToConversation, title: '回到当前会话（工作台收起来，会话不变）' })
						: null
				),
				h('div', { style: { height: '1px', background: palette.border } }),
				state.tab === 'skills'
					? h(SkillsTab, { palette, view: state.skills, patch: patchSkills })
					: state.tab === 'docs'
						? h(DocsTab, { palette, view: state.docs, patch: patchDocs })
						: h(IterationTab, { palette, view: state.iter, patch: patchIter })
			)
		}

		/* ==================== 注册 ==================== */

		/** 需要客户端服务：插槽服务。 */
		const inject = ['slots']

		/**
		 * 两个座位成对注册：侧栏图标（sidebar.panellist）与主面板（main）用同一个 id，
		 * 侧栏点图标 → 主区域派发同名 key → 换成这个面板。
		 * 注册挂在插槽服务的 effect 上，插件卸载时一起消失。
		 *
		 * 另外：如果装了 `dsh-better-sidebar`，再往它的页签服务注册一份 —— 工作台于是也会
		 * 作为它的一个页签出现。两条路互不影响：没装时走官方座位，装了则两边都能进。
		 * 它是**可选**依赖，用 ctx.get 读，读不到就走开，绝不让插件挂起或报错。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			rootContext = ctx
			ctx.slots.inject('sidebar.panellist', () =>
				ctx.slots.register({ name: 'sidebar.panellist', id: 'workbench', order: 10, label: () => '工作台' }, WorkbenchIcon)
			)
			ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'workbench' }, WorkbenchPanel))

			const sidebar = typeof ctx.get === 'function' ? ctx.get('betterSidebar') : undefined
			if (sidebar !== undefined && sidebar !== null && typeof sidebar.registerTab === 'function') {
				ctx.effect(
					() =>
						sidebar.registerTab({
							id: 'dsh-workbench',
							title: () => '工作台',
							description: () => 'AI 改 md → 生成 Word → 你审这一版；另有技能库与文档配对',
							icon: (size) => h(WorkbenchIcon, { size: typeof size === 'number' ? size : 16 }),
							order: 30,
							single: true,
							component: WorkbenchPanel
						}),
					'dsh-workbench: better-sidebar tab'
				)
			}
		}

		exports.apply = apply
		exports.inject = inject
		exports.__internals = { WorkbenchIcon, WorkbenchPanel, SkillsTab, DocsTab, IterationTab, DirectoryDialog, detectScheme, sourceLabel, STATE_META, kindMeta, approvalMeta, pickDirectory, serviceOf, chooseDirectory, backToConversation }
		return module.exports
	}
})
