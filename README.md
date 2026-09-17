# dsh-workbench

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 端加一个「工作台」面板：
> **技能库**（看机器上所有技能、读全文）+ **文档迭代看板**（md 源与 docx/pdf 产物配对，把「产物比源旧」挑到最前面）。

DSH Web 插件 · 零依赖 · 纯只读 · 左栏一个图标，主区域一个面板。

---

## 它解决什么

**一、技能散在好几个地方，看不见也搜不到。**
一个 DSH 技能可能来自项目层（`.agents/skills`）、用户层（`~/.agents/skills`）、内置层……想知道
「我到底装了哪些技能、那个技能到底写了什么」，得挨个目录翻。

**二、用 AI 改文档时，源和产物会脱节。**
Markdown 是源，docx/pdf 是产物。改完 md 忘了重新生成 → 交出去的 Word 里是旧内容。
这种事肉眼不看文件名和修改时间根本发现不了。

这个插件把这两件事放进同一个面板。

## 界面

点左栏的「工作台」图标，主区域出现面板，两个页签：

### 技能库

- 列出**模型实际会加载的那份技能目录**（走核心 `ctx.skills` 注册表，不另建索引，不会漂移）
- 按技能名 / 描述 / 触发词搜索，按来源过滤（用户 · `.agents`、内置、项目层…）
- 点任意一条，右侧显示它的 `SKILL.md` 全文与来源路径

### 文档

- 填一个目录（或用下拉里的已登记工作区），扫描
- 按主干名把 md/tex/qmd 等**源**与 docx/pdf/xlsx 等**产物**配对
- 状态从「该先处理」往下排：

| 徽章 | 含义 |
|---|---|
| 🔴 产物过期 | 产物比源旧 —— 改过 md 却没重新生成 |
| 🟠 无源产物 | 只有产物没有同名源（历史遗留） |
| ⚪ 未生成产物 | 源还没有对应产物 |
| 🟢 已同步 | 产物不比源旧 |

和文档迭代纪律（Markdown 是唯一源、Word/PDF 是产物）是同一条规矩的两半：
那边是操作纪律（本机以技能 `doc-iteration-control` 的形式装在两处技能目录里），
这边是「一眼看出哪里违规」的仪表盘。

## 安装

```sh
# 从本仓库源码安装（link: 方式，改源码只需重启宿主）
dsh plugin --profile web add link:/绝对路径/dsh-workbench

# 或从 GitHub 源码入口安装
dsh plugin --profile web add github:liiydong/dsh-workbench
```

装完**必须重启 `dsh web`**：客户端 bundle 在组合阶段被快照进内存，刷新页面不够。

```sh
# 重启后左栏出现「工作台」图标
```

卸载：

```sh
dsh plugin --profile web remove dsh-workbench
```

## 它怎么拿到数据

宿主半侧只有 4 条**只读** JSON 路由，全部在 `/api/dsh-workbench/` 下：

| 路由 | 数据来源 |
|---|---|
| `GET /skills?cwd=` | `ctx.skills.snapshot()` —— 核心技能注册表 |
| `GET /skill?name=&cwd=` | `ctx.skills.get()` —— 单个技能全文 |
| `GET /docs?dir=` | `node:fs/promises` 扫目录 + 源产物配对 |
| `GET /workspaces` | `ctx.workspaceRegistry.list()` |

**不写任何文件，不发任何模型调用，不采集遥测。** 浏览器半侧只负责画。

## 开发

```
dsh-workbench/
├── package.json          # dsh.bundle.patch + dsh.client.platform
├── cordis.patch.yml      # 把宿主行插进 profile 名册
├── lib/
│   ├── index.js          # 宿主半侧：4 条只读路由（ESM，零依赖）
│   └── client.js         # 浏览器半侧：侧栏图标 + 面板（手写 __ModuleLoader__ bundle，无构建步骤）
└── test/
    ├── smoke.mjs         # 组件树自检：桩掉 __ModuleLoader__ + 迷你 React，42 项
    └── host-routes.mjs   # 路由自检：假 req/res + 真实文件系统扫描，28 项
```

```sh
node test/smoke.mjs
node test/host-routes.mjs          # 可选参数：要扫描的目录
```

两套自检都**不需要浏览器**：客户端 bundle 的 `factory` 与组件都是普通函数，在 Node 里可直接跑
（迷你 React 运行时按组件实例分配 hook 槽、按「组件类型 + hook 序号」去重 effect、在渲染循环里展开整棵树）。
抓得到崩溃与状态流转错误，抓不到布局观感。

## 已知限制

- 界面观感只过了组件树自检，**未做人工视觉验证**；浅色/深色都做了适配但与真实主题的贴合度可能还要调。
- 「产物过期」按**文件修改时间**判定，不看内容。生成脚本若先 touch 产物再写内容，判定会偏乐观。
- 只读：面板不能帮你重新生成产物、也不能提交 git。看到了过期，动作还得自己（或让 agent）做。
- 目录扫描不递归，只扫一层。

## License

MIT
