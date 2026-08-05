# PuddingTeams 平台设计（pi 套壳 agent teams）

> 文档定位：PuddingTeams（基于 pi 二开的 agent teams 平台）的设计起点文档。
> 创建时间：2026-08-03。
> 项目关系：PuddingTeams 与 PuddingClaw 为两个隔离项目；PuddingClaw 仅作为首个 worker 经 CLI/MCP 契约被调用，无代码耦合。
> 关联文档（PuddingClaw 侧文档的参考拷贝，以 PuddingClaw 仓库为准）：`docs/reference/2026-08-03-headless-worker-api-cli-mcp-plan.md`（PuddingClaw headless 调用面方案）、`docs/reference/deerflow-harness-对比与借鉴分析.md`。原始位置：PuddingClaw 仓库 `/Users/pet/Code/AI/Agent/PuddingClaw/docs/`。
> 关联文档（本仓方案）：`docs/2026-08-05-房间即群聊-产品模型方案.md`（阶段二产品模型：solo/单聊/群聊、session 归属窗口、solo 派活路由；落地后 §3 房间描述以该文为准）。
> 参考源码：pi `/Users/pet/Code/AI/Agent/源码合集/pi`，AgentTeams `/Users/pet/Code/AI/Agent/源码合集/AgentTeams`。
> 核心原则：**极简，尽量用 pi 原生原语；重的部分（权限、验收、上下文）由各 worker agent 自己实现**。

## 1. 定位

Manager-Workers 架构：pi 实例做 manager，从 PuddingClaw 衍生的垂直 agent 做 workers。参考 AgentTeams（HiClaw）的语义设计（房间协作、人默认在场、产物走引用、worker 契约极简），**不抄其组件**（Matrix/K8s/网关/CRD 全是企业包袱）。

## 2. pi 原生映射

| AgentTeams 组件 | PuddingTeams（pi 原生） |
|---|---|
| Manager 容器 + Matrix 房间 | pi 实例本身；其 session JSONL 即"房间"（可见、可 fork、可审计） |
| @mention 派活 | 自定义工具 `team_task(worker, task, session?)`，spawn worker 子进程（pi 官方 subagent 示例的做法） |
| Worker CRD 注册表 | `teams.json`：`{name, description, invoke: {type: command \| mcp, ...}, env, enabled}` |
| MinIO 产物引用 | 共享工作目录约定 `workers/<name>/`，派活传路径不传内容 |
| groupAllowFrom 白名单 | 不需要；能否被调由 `teams.json` 决定 |
| Higress 凭证隔离 | worker 自己管（PuddingClaw headless token 走其 env），平台不碰 |
| readiness/心跳 | 子进程退出码（PuddingClaw CLI 已定义 exit 1=未完成 / 2=不可达） |
| Worker 横向直聊（peerMentions） | 刻意不做；等价于 manager 中转两轮，审计性更好 |

平台代码核心 = **一个 teams extension**（约 200–300 行 TS）：启动读 `teams.json`、注册 `team_task` 工具、spawn worker CLI、`--session` 透传实现同一 worker 多轮连续；可选 `/team` 命令与 `team_broadcast`（并行派活）。参考 `pi/packages/coding-agent/examples/extensions/subagent/`（spawn 子进程模板）与 `docs/extensions.md`。

**模型 provider/凭证同样归 pi 原生**：`ModelRuntime`（authPath/modelsPath、`setRuntimeApiKey`、OAuth，示例 `examples/sdk/09`）+ `SettingsManager`（示例 `10`）。平台只做命名空间隔离（authPath/modelsPath 指向 PuddingTeams 数据目录，与系统 pi 互不干扰，Electron 打包必需）；web 设置页是对这两个 Manager 的薄代理（可放阶段二+），模型列表用 pi-ai 自带目录（40+ provider，含 contextWindow/cost），选择器组件可抄 deer-flow `ai-elements/model-selector`。Worker 的 provider 各管各，平台不碰。

## 3. Web 界面：两个面

TUI 场景无需 room server（pi 自己就是界面）；**web 化必须有一个 thin backend**（托管 pi 会话、推事件给浏览器、读写 teams.json）。保持薄：状态只有 pi session 文件 + teams.json，不做自己的消息存储与路由。

**pi 接入方式：优先 SDK 进程内嵌入**（`createAgentSession()`，`pi/packages/coding-agent/src/core/sdk.ts`，`prompt()/steer()/subscribe()` 函数回调 + `SessionManager` 文件/内存可选）。backend 本就是 Node，SDK 省去子进程监督/重连/stdio 解析，pi 版本由 npm 依赖锁定。`--mode rpc`（JSONL stdio）保留为非 Node 消费者的互操路径；`-p`/`--mode json` 一次性模式是 worker 式调用形态（PuddingClaw CLI 对标此）。

```
浏览器(Next.js SPA) ⇄ thin web backend (Node)
                          ├─ pi SDK createAgentSession（进程内，每房间一个 manager 会话）
                          ├─ teams.json（agents 注册表 CRUD）
                          └─ spawn: puddingclaw run ...（经 pi 的 team_task）
```

- **房间（协作面）**：房间 = pi manager session + 房间配置 `{id, name, agents: [勾选的 worker]}`；消息流渲染 `team_task` 工具调用（派活可见），worker 回复为 tool result；创建房间时从 enabled agents 勾选成员，勾选决定 `team_task` 描述注入哪些 worker。
- **Agents 管理（资源面）**：`teams.json` 可视化 CRUD：列表 / 添加（name、description、invoke 配置、env）/ **勾选启用** / 健康探测按钮（调 `puddingclaw health`，退出码转状态灯）。无心跳、无实时状态——worker 按需 spawn，管理只是维护注册表。
- **invoke 字段从第一天就支持两种形态**（`command` CLI spawn / `mcp` MCP server 连接）：PuddingClaw 两种都会交付，后续垂直 agent 大概率只给一种，schema 先留好。
- **UI 结构（参照 deer-flow 侧栏模式）**：左侧导航三入口——**对话**（协作面，阶段一即聊天主界面，阶段二升级为房间）、**智能体**（资源面，agents 管理的页面载体：teams.json 列表 / 添加 / 勾选启用 / 健康探测）、底部"**设置和更多**"弹层入口。管理面与协作面分离，导航即边界。
- **设置弹层**（modal + 左侧 tab，参照 deer-flow 设置对话框，非独立路由）：tab 按内容分期——**外观**（系统/浅色/深色主题卡片；纯前端 localStorage，无后端依赖）、**模型 / Provider**（ModelRuntime 凭证的薄代理：provider 目录 + API key 增删，见 §3.1 表；两者均已于阶段一落地）、**关于**（版本与 pi 信息，顺手做）。**明确不开的 tab**：账号（本地自用无鉴权）、通知/记忆/工具/技能（无对应能力，有真实内容再加，不摆空壳）。

### 3.1 分层与 pi 能力的前端呈现

**前端永远不直接碰 pi SDK**（SDK 只在 server 进程内），链路为 `web 组件 → server 自有端点（HTTP/WS）→ pi-bridge → pi SDK`。server 端点用**平台自己的契约命名**（`/sessions`、`/chat`），不照搬 pi 概念名——将来换 agent 内核 web 端零改动。

pi 能力到前端的映射与分期：

| pi SDK 能力 | server 端点 | web 呈现 | 阶段 |
|---|---|---|---|
| session 事件流（message/tool/reasoning） | WS/SSE 事件推送 | 聊天时间线（ai-elements: message/conversation/reasoning/task） | 一 |
| SessionManager（列表/恢复/删除） | `GET/DELETE /sessions` | 对话列表侧栏 | 一 |
| ModelRuntime 模型目录 | `GET /models` | 模型选择器（ai-elements `model-selector`） | 一 |
| prompt/steer/abort | `POST /chat` + 中断端点 | 输入框 + 停止按钮 | 一 |
| ModelRuntime 凭证（setRuntimeApiKey/OAuth） | `GET /providers`、`POST/DELETE /providers/:name/key` | 设置弹层 provider 管理 | 一（已提前落地；OAuth 仍二） |
| SettingsManager | `GET/PATCH /settings` | 设置弹层高级项 | 二 |
| compaction/retry 等设置项 | 同 settings | 设置弹层高级项 | 二+ |
| teams extension（team_task 事件） | 并入事件流 | 房间时间线派活渲染 | 二 |
| session fork/tree 分支 | 按需 | 会话分支 UI | 四（备忘） |

原则：**只呈现产品需要的，不追求 SDK 全覆盖**——阶段一仅上表前四行（对话列表 + 聊天时间线 + 输入框 + 模型选择器）。

## 4. 健康检测策略（套壳 pi）

要检测，但只做**便宜的、事件驱动的**，不做心跳轮询：

1. **pi 本体**：SDK 进程内嵌入后版本由 npm 依赖锁定，无需运行时探活；backend 启动时做一次 `createAgentSession()` 冒烟（建临时内存会话即销毁），失败则 fail-fast 给出明确报错；
2. **会话可靠性**：SDK 模式下无子进程监督问题；会话状态在 pi 的 JSONL 文件里，backend 自身重启后按 session 文件重建 `AgentSession` 即可恢复；
3. **Workers**：无常驻健康检查，两个来源足够——每次调用的退出码/超时；agents 管理页的手动"健康探测"按钮（`puddingclaw health` 等）；
4. **明确不做**：定时心跳循环、worker 状态常驻监控——worker 是按需 spawn 的，没有可监控的常驻对象。

## 5. 前端栈与参考对象

- **栈**：Next.js（与 PuddingClaw 前端同体系，路径均指 PuddingClaw 仓库 `/Users/pet/Code/AI/Agent/PuddingClaw`）。
- **可复用（代码拷贝后独立维护，不建立跨仓库依赖）**：
  - SSE 解析：PuddingClaw `frontend/src/lib/api.ts` 的 `parseSSEFrame` 自写解析器；
  - 聊天消息渲染组件（PuddingClaw 前端）；
  - Agents 管理页模式：PuddingClaw Settings 页的 subagents 声明式 spec + 四 Tab UI（`frontend/src/app/settings/page.tsx`）。
- **参考对象**：
  - 房间消息流中工具调用/运行状态的渲染 → **deer-flow 前端**（`/Users/pet/Code/AI/Agent/源码合集/deer-flow`，MIT 许可，可抄组件保留 license 头）：重点抄 `frontend/src/components/ai-elements/`（Vercel AI Elements 组件集——message/conversation/reasoning/task/artifact/prompt-input，依赖仅本地 shadcn `ui/` + streamdown + shiki，纯浏览器 JS 零原生模块）与 `components/ui/`；不抄 `canvas/node/edge`（带 `@xyflow/react` 依赖）、不抄整 app 骨架（其状态层绑 DeerFlow gateway SSE 契约，我们的事件源是 pi SDK 事件流，数据流自己接）；注意其版本为 Next 16 / React 19 / Tailwind 4。其**设置弹层**（modal + tab、主题卡片）与**侧栏导航**（对话/智能体双入口）作为 UI 模式参照（§3），结构可抄、状态层自接；
  - UX 模式参考 AgentTeams：房间即全部界面、人默认在场（消息流即审计）、管理面与协作面分离；
  - **不参考** Element Web（完整 IM 应用、非组件库，且意味着养 Matrix，违背极简）。
- **桌面打包（mac/Windows）**：全栈 Node 生态（Next.js 前端 + thin backend + pi CLI 均为 npm 分发、无原生模块），无 ABI 重编译问题；模式复用 PuddingClaw 现有 Electron 管线（Electron spawn 后端 + `loadURL`，`scripts/build-electron-app.sh` 为 mac 参考，补 electron-builder Windows 配置）；pi 以 npm 依赖（`@earendil-works/pi-coding-agent`）打包进 app，启动时按 §4 探活。

## 6. PuddingClaw 侧依赖（已批方案，独立开发）

PuddingClaw 交付 headless API + CLI + MCP 三调用面（v0 = auto 执行，HITL v1/v2 进阶），是 PuddingTeams 的第一个 worker，也是 `team_task` 的第一个消费者。两者解耦：PuddingTeams 只依赖其 CLI/MCP 契约，不依赖其实现进度之外的任何东西。

## 7. 实施阶段

### 阶段一：pi 接入 + 全套 Chat（Web 部署）

目标：**先不做 agents/房间、不碰 Electron，把"套壳 pi 的单 agent 聊天 Web 应用"做完整**——验证 pi SDK 桥与事件流两件事，浏览器直接访问。

- thin web backend：经 pi SDK（`createAgentSession`）托管会话（此时一个会话即一个"对话"，无房间概念），subscribe 事件 → WebSocket/SSE 推给浏览器；§4 健康检测（启动冒烟、会话重建恢复）在此阶段落地；
- 前端：对话列表 + 聊天时间线 + 输入框（复用 deer-flow `ai-elements` 的 message/conversation/reasoning/task/prompt-input），事件层接 pi SDK 事件；设置弹层（侧栏底部入口）随本阶段落地两个 tab——"外观"（纯前端主题三态卡片）与"模型 / Provider"（provider 目录 + API key 增删，§3.1）；
- 部署形态：web（backend 起服务、浏览器访问），本地自用即可，暂不做多用户/鉴权；
- **明确不做**：Electron、teams.json、team_task、agents 管理页、房间配置、worker 相关一切。
- 完成判据：浏览器里和 pi manager 完成多轮对话（含工具调用渲染、思考块、流式输出），会话重启后可恢复（pi session JSONL）。

### 阶段二：Agents 管理 + 房间（仍 Web）

- teams extension（`team_task` + `teams.json`，§2）；
- Web 两个面：agents 管理页（侧栏"智能体"入口，注册表 CRUD + 勾选启用 + 健康探测）、房间（房间配置勾选成员、派活渲染，§3）；设置弹层按需补 OAuth 登录与高级项（SettingsManager，§3.1）；
- 接入首个 worker：PuddingClaw（依赖其 headless CLI/MCP 交付，§6）；
- 共享工作目录约定 `workers/<name>/`（产物走引用）；
- 完成判据：浏览器里勾选 PuddingClaw 进房间，manager 经 `team_task` 派活并拿到带验收的结果，全程可见。

### 阶段三：Electron 桌面打包（mac/Windows）

- 全部流程在 web 形态跑通后再做分发：Electron 壳 spawn backend + pi（pi 以 npm 依赖打包进 app），`loadURL` 加载前端；
- 复用 PuddingClaw 现有 Electron 管线模式（§5 打包条目），mac 先行、补 Windows electron-builder 配置；
- 功能与前序阶段完全一致，只是分发形态变化；
- 完成判据：mac/Windows 安装包内复现全部功能判据；pi 缺失/版本不兼容时 fail-fast 明确报错。

### 阶段四（远期，仅备忘）

多 manager/多房间并行、worker 产物预览（deer-flow `web-preview`/`artifact` 面板）、`team_broadcast` 并行派活、web 端多人协作（此时才重新评估是否需要真正的 room server）。

## 8. 项目目录结构建议

pnpm workspace 单仓，按阶段增量出现（标注 ☐ 的阶段一到位即建，◻ 后续阶段再建）：

```
PuddingTeams/
├── docs/                          # ☐ 已有（本文档 + reference/）
├── apps/
│   ├── web/                       # ☐ Next.js 前端：对话列表 + 聊天时间线 + 输入框
│   │   ├── src/components/chat/   #    deer-flow ai-elements 抄改组件落这
│   │   └── src/lib/               #   事件流客户端（WS/SSE → pi 事件映射）
│   └── server/                    # ☐ thin backend（Node + Fastify/Express 均可）
│       ├── src/pi-bridge/         #   pi SDK 封装：会话生命周期、事件订阅转发
│       ├── src/routes/            #   HTTP/WS 端点（chat、sessions）
│       └── src/store/             #   ◻ teams.json / 房间配置读写（阶段二）
├── packages/
│   └── teams-extension/           # ◻ pi extension（team_task 等，阶段二）
│       └── teams.json             #   agents 注册表（阶段二）
├── electron/                      # ◻ 阶段三：壳 + 打包配置（mac/win）
├── workers/                       # ◻ 运行时生成的共享工作目录（gitignore，阶段二）
└── docs/reference/                # ☐ PuddingClaw 侧文档参考拷贝（已有）
```

原则：

- **只有两个常驻 app**（web/server）+ 按需出现的包；pi 是 npm 依赖不是源码 fork，不建 `vendor/pi` 之类目录；
- pi 相关的全部复杂度收敛在 `server/src/pi-bridge/` 一个目录，web 只面对平台自己的事件契约——将来换 agent 内核只动这一层；
- `teams-extension` 独立成包是因为它要能被 pi 的扩展加载路径直接引用（开发期 `pi -e` 指向它，分发时随 backend 一起装）；
- `workers/` 是运行时产物目录，入 gitignore，结构 `workers/<name>/` 由 platform 按需创建。
- **纯 TypeScript 项目**：web（Next.js）/ server（Node）/ teams-extension（pi 经 jiti 原生加载 TS，无需编译）/ electron 壳全部 TS；pi 本体也是 TS npm 依赖。无其他语言运行时（workers 如 PuddingClaw 是独立项目，经 CLI/MCP 契约调用，不在本仓）。
- **分发形态**：开发态前后端分离（两进程），分发态合体——主分发物为一个 npm CLI 包（server + web 构建产物内嵌，`npx puddingteams` 一条命令起服务）；`teams-extension` 可单独发包走 pi 的 `npm:` 扩展通道；Electron 安装包（阶段三）是同一套 server+web 的并列分发物，不改架构。server 从阶段一就需支持「开发期代理 Next dev server / 生产期 serve 构建产物」一套代码两种形态。
