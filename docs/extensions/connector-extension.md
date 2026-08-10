# Connector Extension 作者指南：双宿主包与 Driver SPI

> 事实源：`docs/2026-08-06-通用-agent-接入-底层与扩展方案.md` §9.5（双宿主包）、§4（PWCP 事件契约）、§10（manifest）。引用均指该方案章节号。
> 参考实现：`extensions/connectors/codex`（本文所有示例取自该包，已真机验证）。

## 1. 双宿主包：一个包，两种激活路径

Connector 包是**同一份代码、两个宿主入口**的 npm 包：既是 `pi install` 可装的 pi extension，又是 PuddingTeams 的 Driver SPI 实现。两条激活路径互不相干：

| | 纯 pi | PuddingTeams |
| --- | --- | --- |
| 加载器 | pi resource-loader（找 `pi.extensions` 入口） | ExtensionRegistry（读 `puddingteams` manifest + `createDriver`） |
| 激活内容 | pi 内注册 `<id>_delegate` 工具，pi 自己当 manager | agent 进 roster，平台投影 `agent_<id>__delegate`，走房间体系 |
| 配置/密钥 | 包自管（环境变量） | connector binding API + secretRefs |
| 生命周期 | 跟随 pi 会话 | server 托管：取消传播、超时、多实例 |

边界铁律（写代码时随时对照）：

- **pi 门面只用 `ExtensionAPI`**：registerTool、事件回调；没有 spawn、server 持久化、审批路由能力。
- **Driver 只用 Driver SPI（`@puddingteams/pwcp`）**：不 import pi SDK，不 import PuddingTeams server 内部模块。
- **共享核心（`core/`）不依赖任何宿主**：协议翻译、事件归一化放这里，两个入口各自薄适配。
- pi 入口是包的**门面**，Driver SPI 才是 Connector 的**本体**；完整的房间能力（manager-worker 编排、HITL 审批闭环、workspace 交接）只有 PuddingTeams 提供。

## 2. 包结构

照 `extensions/connectors/codex`：

```text
connector-codex/
├── package.json            # 三要素：pi.extensions + puddingteams 折叠 manifest + exports（§3）
├── tsconfig.json
├── pi/
│   └── index.ts            # pi 门面：export default (pi: ExtensionAPI) => void，注册 codex_delegate 工具
├── driver/
│   └── index.ts            # Driver 本体：AgentDriver 实现 + createDriver(config) 工厂（manifest entry 指向这里）
├── core/
│   └── codex-normalize.ts  # 共享核心：上游 JSONL 事件 → PWCP 归一化（reducer + capabilities 常量），不依赖宿主
└── assets/
    └── codex.svg           # connector.avatar 引用的默认头像（Agent 未上传头像时平台回退展示）
```

- `pi/index.ts` 与 `driver/index.ts` 都可以 import `core/`，但彼此不 import 对方；
- `assets/` 里放 `connector.avatar` 引用的资源，路径必须是包内相对路径（png/jpg/webp/gif/svg）。

## 3. package.json 三要素

### 3.1 `pi.extensions`：pi 门面

```json
"pi": { "extensions": ["./pi/index.ts"] }
```

pi resource-loader 按此字段找入口，`pi install <source>` 后加载 `pi/index.ts` 的 default export。加上 `keywords: ["pi-package", ...]` 才能进入 pi gallery 被发现。

### 3.2 `puddingteams`：折叠 manifest

§10 的 manifest 折叠进 `package.json` 的 `puddingteams` 字段，一个包一份元数据（独立 `pudding-extension.json` 也接受，且优先级更高）：

| 字段 | 语义 |
| --- | --- |
| `id` / `publisher` / `displayName` / `version` | 包身份；`id` 与目录名一致 |
| `source` | `"builtin" | "trusted" | "external"`；第一方包用 `trusted`，第三方模板默认 `external` |
| `kind` | `"connector"`；与 `extensions/connectors/` 目录一致 |
| `engines.puddingteams` | 宿主版本的合法 semver range，如 `>=0.1 <1`；validate 检查语法，安装与每次启用强制匹配当前宿主版本 |
| `permissions` | 安装时向用户展示的能力申请：`spawn` / `network` / `workspace` / `secrets` |
| `entry` | Driver 入口（包内相对路径，指向 `driver/index.ts`）；与 `connector.declarative` 互斥 |
| `connector.id` / `displayName` / `apiVersion` | Connector contribution 身份；`apiVersion` 只支持 `"1"` |
| `connector.defaultTransport` / `supportedTransports` | `spawn` / `http` / `rpc` / `acp` / `sdk`；default 必须包含在 supported 中 |
| `connector.configSchema` | JSON Schema 子集，前端据此渲染配置表单（`format: "model"` 渲染为模型下拉）；用户只配 executable、transport 和安全设置，不手写命令模板 |
| `connector.secretSchema` | `[{key, label, required}]`；密钥写 CredentialsStore，只存 secretRefs |
| `connector.avatar` | 默认头像，包内相对资源路径（如 `assets/codex.svg`） |

### 3.3 `exports` 与依赖

```json
"exports": {
  ".": "./driver/index.ts",
  "./driver": "./driver/index.ts",
  "./core/codex-normalize": "./core/codex-normalize.ts",
  "./pi": "./pi/index.ts"
},
"files": ["pi", "driver", "core", "assets"],
"dependencies": { "@puddingteams/pwcp": "workspace:*", "typebox": "^1.3.7" },
"peerDependencies": { "@earendil-works/pi-coding-agent": "*" }
```

- **`@earendil-works/pi-coding-agent` 必须是 peerDependency 且版本 `*`**：pi 门面只用宿主注入的 `ExtensionAPI` 类型；若打成普通依赖，pi install 会装入第二份 pi 运行时，类型与事件总线都对不上。
- **`@puddingteams/pwcp` 提供共享核心**：`./types`（Driver SPI 类型）、`./spawn`（spawnWorker：超时/取消/stderr 收集）、`./jsonl-lines`（JsonlLineParser）、`./observe`（git 基线 + 增量产物收集）。TS 源码直出，两个宿主共用。
- **发布前把 `workspace:*` 改成 semver**：workspace 协议只在 monorepo 内有效，`npm publish` 前必须替换为具体版本范围（npm/pi 社区发布渠道本身仍是 TODO，见 §7）。
- `typebox` 用于 pi 工具的参数 schema（`pi.registerTool` 的 `parameters`）。

## 4. Driver SPI 契约要点

类型定义在 `@puddingteams/pwcp/types`（`AgentDriver` 接口）。五个操作：

| 操作 | 语义 |
| --- | --- |
| `run(input, ctx)` | 创建新 Session 并启动第一条 Run。yield `started` 后，**恰好 yield 一个边界事件** |
| `continue(input, ctx)` | 在已有 Session 中创建下一条 Run；`input.sessionHandle` 由 Driver 自己在上一条边界事件里产出、Runtime 透传回来 |
| `respond(input, ctx)` | 给仍在等待输入的同一条 Run 提交审批/回答（HITL）。不支持就在 capabilities 里不声明，实现里防御性 yield `interaction_unsupported` |
| `cancel(input, ctx)` | 可选。取消当前 Run，不删 Session；无上游取消命令时 no-op——运行时取消经 `ctx.signal` → SIGTERM→SIGKILL（spawnWorker 保证） |
| `probe(ctx)` | 探测 CLI 可执行性/版本/能力，不依赖用户配置；`issues` 给出可操作的修复提示 |

硬约束：

- **边界事件恰好一个**：每次 run/continue/respond 必须收束于 `completed` / `failed` / `input_required` 三者之一，不多不少。`failed` 要带 `errorCode`、`recoverable`（退出码 2 这类用法错误标 `false`，避免 Runtime 无谓重试）。
- **capabilities 诚实声明**：`operations` / `interactionKinds` / `progress` / `transport` 必须与实现一致；不支持就是空数组（如 `interactionKinds: []`）。Runtime 按声明路由，虚标会在运行期变成路由错误。
- **progress 外送规则**：流式进度经 `ctx.onUpdate?.(text, { streaming: true })` 实时外送；**终态 content 不走 progress**（避免与边界事件的 `result.content` 重复）。
- **sessionHandle/runHandle 不透明**：Driver 生成与消费（codex 用 `thread.started` 的 thread_id，resume 以 thread 为单位，runHandle 复用 thread_id）。
- **observe 收集**（§15.4）：任务前 `gitBaseline(cwd)` 取基线，completed 后 `observeGitArtifacts` 只收新增变更，防止脏工作区误报。

`InvocationContext` 提供：`cwd`（房间 workspace 绑定，Driver 不自己猜目录）、`env`（已注入凭证）、`signal`、`timeouts`（startupMs/activeMs）、`onUpdate`。

## 5. pi 门面要点

`pi/index.ts` 只做一件事：`export default function (pi: ExtensionAPI)` 里 `pi.registerTool` 注册 `<id>_delegate`。工具把任务描述透传给共享核心（spawn + 归一化），流式回报进度，返回终态文本。注意：

- description 里写清「独立会话，看不到当前对话，task 要给足上下文」；
- 参数 schema 用 typebox；`cwd` 默认取 `ctx.cwd`；
- 工具是**单次委托入口**，不实现会话续接、审批——那些在 PuddingTeams 半边。

## 6. 开发流程

```text
1. 生成骨架
   node apps/server/bin/puddingteams.mjs extension init --type connector --id <id> <dir>
   （--declarative 生成纯 manifest 声明式包，见 connector-declarative-schema.md）

2. 实现：core/ 事件归一 → driver/index.ts 五操作 → pi/index.ts 门面 → assets/ 头像

3. 校验（逐项 ✓/✗，exit 0/1）
   node apps/server/bin/puddingteams.mjs extension validate <dir>
   校验 manifest 全量 schema、entry 存在性、createDriver/driver 导出

4. PuddingTeams 本地安装
   先在 Web UI 扩展管理页开启“开发者模式”并确认代码执行风险，再从本地服务端路径安装；
   或先 PUT /api/extensions/developer-mode { enabled: true }，再 POST /api/extensions/install（body 带本地 path）。
   开发者模式关闭时，本地 Extension 不加载且安装/更新/卸载 API 拒绝操作；随产品审核的 bundled Connector 不受影响。

5. pi 无头试用
   pi -e <dir> 加载包后，无头调用 <id>_delegate 工具验证 pi 半边

6. 发布（渠道 TODO，见 §7）：workspace:* 改 semver → npm publish → pi install <pkg>
```

## 7. 参考实现与已知边界

`extensions/connectors/codex` 是完整跑通上述流程的真实样本：

- `run` → `codex exec --json --skip-git-repo-check -C <cwd> -s <sandbox> [-m model] <message>`；
- `continue` → `codex exec resume --json … <sessionHandle> <message>`；
- `cancel` no-op、`respond` 防御性失败（codex headless 无跨进程审批），`capabilities: operations [run, continue, cancel]`、`interactionKinds: []`、`progress: "stream"`、`transport: "spawn"`；
- 已真机验证：`pi -e` 无头调用 `codex_delegate` 成功；driver run/continue 会话记忆成功；server 启动时 `installOrUpdateFromDir` 按仓库路径预置（改动即时生效，不再是 builtin）。

明确延后（写包时不要假设存在）：

- **隔离 Extension Host**：代码型 Connector 目前只在显式开发者模式下跑在 server 进程内（§10.3 第 2 级的进程隔离 + 权限 Broker 未落地）；该项已记录为待办，产品功能与发行验收全部完成后才重新评估；
- **npm/pi 社区发布渠道**：发布前的 `workspace:*` → semver 改写与 registry 发布流程未产品化；
- puddingclaw / pi 两个内置 Connector 尚未迁移成本目录双宿主包；Capability 包模板与样例未交付。
