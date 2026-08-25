# PuddingTeams 北向 Headless Gateway 方案

> 日期：2026-08-24  
> 状态：设计确认，待实现  
> 适用仓库：PuddingTeams  
> 目标：让外部 Manager、Agent、CLI 或自动化系统只提交一条 query，即可使用 PuddingTeams 的 Manager 编排、Worker 委派、房间、HITL、Workspace 与流式进度能力；调用方不需要知道 Teams 内部有哪些 Worker、使用什么 Connector、创建了什么房间。

## 0. 决策摘要

PuddingTeams 对外是一个完整的“团队 Agent”，不是一组需要调用方自行编排的 Worker API。

北向协议固定遵守以下规则：

1. **唯一必填业务输入是 `query`**。调用方不传 `target`、`workerId`、`roomId`、Connector 或 transport。
2. **Teams 自己完成路由**。Manager 可以自己回答，也可以选择一个 Worker、并行委派多个 Worker、创建或复用 direct/group 房间。
3. **HTTP 使用 REST 控制面 + SSE 事件流**。创建 Run、回复交互、取消 Run 使用普通 HTTP；进度、路由、委派、回答和终态使用 SSE。
4. **CLI 使用 stdin JSON + stdout JSONL**。CLI 是同一 Headless Gateway 的薄客户端，把 SSE 事件逐条转写为 JSONL，不创建第二套 Runtime。
5. **外部会话只持有不透明句柄**。`conversationId`、`runId`、`interactionId` 由 Teams 生成；调用方不需要理解其内部 Session、Window 或 Delegation 映射。
6. **内部决策可以被观察，但不能成为调用负担**。SSE 可以告诉调用方“正在规划”“已委派给某个角色”“正在等待审批”，但调用方不负责选择 Worker 或创建房间。
7. **终态必须可重新读取**。SSE 是实时通知通道，不是唯一事实源；断线后通过 `GET /runs/:runId` 仍可取得权威状态和最终结果。

最小调用应当成立：

```http
POST /api/headless/v1/runs
Content-Type: application/json

{"query":"分析这个项目并修复测试失败"}
```

任何要求调用方先列举 Worker、选择 Worker、创建房间或理解 PuddingTeams 内部拓扑的设计，均不符合本方案。

## 1. 为什么需要独立的北向 Gateway

### 1.1 南向 Connector 与北向 Gateway 是两个方向

现有 Connector/Driver SPI 解决的是 PuddingTeams **如何调用其他 Agent**：

```text
PuddingTeams Runtime
        ↓
Connector / Driver
        ↓
spawn / HTTP / RPC / ACP / SDK
        ↓
外部 Worker
```

Headless Gateway 解决的是其他系统 **如何调用 PuddingTeams**：

```text
外部 Manager / Agent / 自动化系统
        ↓
HTTP SSE 或 spawn CLI
        ↓
PuddingTeams Headless Gateway
        ↓
Manager + Room + Worker + HITL + Workspace
```

因此 Gateway 不属于 Connector Extension，也不能复用 Driver SPI 作为公开协议。Driver SPI 的输入目标已经是确定的 Agent；Gateway 的职责恰恰是在目标未知时让 Teams 理解 query、恢复上下文并完成内部路由。

本文统一采用方向术语：

| 方向 | 作用 | 稳定边界 |
| --- | --- | --- |
| 北向 Gateway | 外部系统调用 PuddingTeams | query、conversation、Run、SSE、respond、cancel |
| 南向 Connector | PuddingTeams 调用 Worker | Driver SPI、Session/Run handle、transport、归一化结果 |

### 1.2 现有 Web API 不是公开 Agent 协议

当前服务端已经具备房间、Session 消息和 WebSocket 路由，但它们是 PuddingTeams Web 前端的内部 API：

- 调用方必须先理解 Room 与 Session；
- `POST /api/sessions/:id/messages` 只返回 accepted，调用方还要自己关联后续消息；
- WebSocket 推送包含 UI/SDK 侧事件，不是稳定的北向 Agent 事件；
- 缺少统一的 Headless `run / respond / cancel / terminal result` 契约；
- 当前 CLI 只负责 init、start、stop、status、open 与 Extension 管理，不提供 Agent Run 命令。

Headless Gateway 可以复用这些内部能力，但不能把现有 Web 路由原样宣布为外部协议。

## 2. 第一性原理

### 2.1 外部调用的对象是 Teams，不是某个 Worker

调用方知道的唯一 Agent 是 PuddingTeams。Worker roster、责任边界、可用状态和 transport 是 Teams 的内部事实。

错误接口：

```json
{
  "target": "worker:puddingclaw-http",
  "query": "修复问题"
}
```

它把以下负担错误转移给调用方：

- 先发现 Worker；
- 理解 Worker 的职责和可用性；
- 决定是否应该经过 Manager；
- 了解 Worker 名称是否稳定；
- 处理 Worker 停用、替换或 Connector 变化。

正确接口：

```json
{
  "query": "修复问题"
}
```

Teams 内部 Manager 根据提示词、责任边界、房间上下文和运行状态决定：

- 自己处理；
- 委派给一个 Worker；
- 并行委派多个 Worker；
- 追问调用方；
- 因权限或策略进入 HITL；
- 无合适能力时诚实返回 blocked。

### 2.2 房间是内部执行上下文，不是调用前置条件

外部 conversation 与内部 Room/Session 的映射由 Gateway 保存：

```text
conversationId（外部不透明）
        ↓ GatewayConversationStore
manager Session + room context（内部）
        ↓ Manager 路由
direct/group room + worker binding（内部）
```

约束：

- 首次请求未传 `conversationId` 时，由 Gateway 创建并返回；
- 后续请求传同一 `conversationId` 时恢复 Manager 对话历史；
- Gateway 创建或恢复内部 Session 时不得切换用户 Web UI 当前打开的 `activeSession`；
- Manager 自动创建/复用的 direct 房间继续遵循现有 `(worker, workspace)` 去重和 Window 生命周期规则；
- 外部协议不返回可用于控制内部 Room/Session 的原始 id；如需审计，只在受权限保护的诊断投影中提供。

### 2.3 事件负责观察，控制必须显式提交

SSE 是服务端到调用方的单向流，适合进度和结果，不负责接收调用方动作。

- Teams 已完成的内部动作：通过 SSE 报告，例如规划、路由、委派、工具执行和房间上下文准备；
- Teams 需要调用方决定：发出 `interaction.required`；
- 调用方的回复：通过 `POST /runs/:runId/respond`；
- 调用方取消：通过 `POST /runs/:runId/cancel`。

不得把“请创建房间”“请选择 Worker”作为 SSE 指令交给调用方执行。只有无法由 Teams 自主决定、且确实需要人类语义或授权的事项，才能成为 `interaction.required`。

## 3. 总体架构

```text
                         ┌──────────────────────────┐
HTTP caller ── REST/SSE ─┤                          │
                         │ TeamsHeadlessGateway     │
spawn caller ── CLI ─────┤                          │
                         └────────────┬─────────────┘
                                      │
                   ┌──────────────────┼──────────────────┐
                   ▼                  ▼                  ▼
          ConversationStore       RunStore          EventStore
                   │                  │                  │
                   └──────────────────┼──────────────────┘
                                      ▼
                           Manager Session / Room
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
                  Manager 自己处理          AgentInvoker 委派
                                                   │
                                             Driver Runtime
                                                   │
                                                Worker
```

### 3.1 单一应用服务

新增 `TeamsHeadlessGateway`，作为 HTTP 与 CLI 的共同应用服务。它只编排现有领域能力，不复制 Manager、Room、Invoker 或 InteractionBroker 的实现。

建议接口：

```ts
interface TeamsHeadlessGateway {
  createRun(input: CreateGatewayRunInput): Promise<GatewayRun>;
  getRun(runId: string): Promise<GatewayRun>;
  streamEvents(runId: string, afterSeq?: number): AsyncIterable<GatewayEvent>;
  respond(runId: string, input: GatewayRespondInput): Promise<GatewayRun>;
  cancel(runId: string): Promise<GatewayRun>;
  probe(): Promise<GatewayHealth>;
}
```

### 3.2 不直接暴露底层事件

Gateway Event 是公开、版本化的稳定投影。以下内容不得原样外送：

- pi SDK 原始事件；
- Driver 私有 payload；
- continuation token；
- Worker Session handle；
- Connector 配置、命令或环境变量；
- 内部 Room/Session/Delegation 存储结构；
- 本地绝对路径和未授权附件路径。

内部事件先归一化为用户可理解的 Gateway Event，再持久化和推送。

## 4. HTTP 契约

### 4.1 创建 Run

```http
POST /api/headless/v1/runs
Content-Type: application/json
```

请求：

```ts
interface CreateGatewayRunRequest {
  /** 唯一必填业务字段。 */
  query: string;
  /** 可选；缺省时创建新 conversation。 */
  conversationId?: string;
  /** 可选幂等键；SDK/CLI 应自动生成，用户无需手写。 */
  requestId?: string;
  /** 可选平台 Workspace 引用；缺省使用 Gateway 默认上下文。 */
  workspaceId?: string;
  /** 可选附件引用；必须先进入平台受管附件存储。 */
  attachments?: GatewayAttachmentInput[];
}
```

禁止增加：

```ts
target?: string;
workerId?: string;
roomId?: string;
sessionId?: string;
connectorId?: string;
transport?: string;
```

返回 `202 Accepted`：

```json
{
  "runId": "run_01...",
  "conversationId": "conv_01...",
  "status": "queued",
  "eventsUrl": "/api/headless/v1/runs/run_01.../events",
  "statusUrl": "/api/headless/v1/runs/run_01..."
}
```

`requestId` 缺省时由服务端生成并在响应中返回。可靠客户端应由 SDK/CLI 自动生成它，以便在未收到响应时安全重试，但协议不要求最终用户理解或填写。

### 4.2 订阅 SSE

```http
GET /api/headless/v1/runs/:runId/events
Accept: text/event-stream
Last-Event-ID: 17
```

响应要求：

- `Content-Type: text/event-stream; charset=utf-8`；
- 每个 Run 的 `id` 单调递增；
- 支持 `Last-Event-ID` 或等价 `afterSeq` 断点续传；
- 定期发送 SSE comment heartbeat，避免空闲代理断连；
- 已完成 Run 重连时重放缺失事件后正常结束；
- 慢消费者不得阻塞 Runtime，事件先持久化再异步投递；
- 重放只读 EventStore，不重新触发 Manager 或 Worker。

### 4.3 读取终态

```http
GET /api/headless/v1/runs/:runId
```

返回权威 Run 状态：

```ts
type GatewayRunStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";
```

completed 时返回最终回答与受管产物引用。调用方不得被迫从所有 `answer.delta` 重新拼装权威结果。

### 4.4 回复交互

```http
POST /api/headless/v1/runs/:runId/respond
Content-Type: application/json

{
  "interactionId": "int_01...",
  "responses": [
    {"requestId":"req_permission","action":"approve","scope":"once"}
  ]
}
```

约束：

- 只接受 Gateway 公开的 `interactionId`，不接受上游 continuation token；
- 重复提交必须幂等；
- respond 后继续使用同一个 `runId` 和 SSE 地址；
- Manager 追问、Worker permission、确认类交互使用同一公开模型，但内部恢复路径仍由 InteractionBroker 区分。

### 4.5 取消

```http
POST /api/headless/v1/runs/:runId/cancel
```

取消必须进入现有 Runtime/Invoker 控制面，不能只断开 SSE。成功后写入 `run.cancelled` 终态事件，并使 `GET /runs/:runId` 返回 cancelled。

### 4.6 健康与协议探测

```http
GET /api/headless/v1/health
```

建议返回：

```json
{
  "agentId": "puddingteams",
  "protocolVersion": "1",
  "progress": "sse",
  "operations": ["run", "continue", "respond", "cancel"],
  "conversation": true,
  "serverVersion": "0.1.x"
}
```

这里的 `continue` 表示调用 `POST /runs` 时携带既有 `conversationId`，不是恢复 waiting_input Run；后者只能走 respond。

## 5. SSE 事件模型

### 5.1 统一 envelope

```ts
interface GatewayEvent<T = unknown> {
  id: number;
  type: GatewayEventType;
  runId: string;
  conversationId: string;
  timestamp: string;
  data: T;
}
```

SSE framing：

```text
id: 7
event: delegation.progress
data: {"id":7,"type":"delegation.progress","runId":"run_01","conversationId":"conv_01","timestamp":"...","data":{"participant":"代码实现负责人","message":"正在运行测试"}}

```

### 5.2 第一版事件全集

| Event | 用途 | 是否终态 |
| --- | --- | --- |
| `run.queued` | Run 已持久化，等待执行 | 否 |
| `run.started` | Manager 开始处理 query | 否 |
| `run.progress` | 不属于某个 Worker 的平台/Manager 进度 | 否 |
| `team.route_decided` | Teams 已决定自己处理、单 Worker 或多 Worker 编排 | 否 |
| `conversation.prepared` | 内部对话上下文已创建或恢复 | 否 |
| `delegation.started` | 已委派一个角色 | 否 |
| `delegation.progress` | Worker 生命周期、工具或生成进度的公开投影 | 否 |
| `delegation.completed` | 某次委派完成 | 否 |
| `delegation.failed` | 某次委派失败；Manager 仍可能继续 | 否 |
| `interaction.required` | 需要调用方回答问题、确认或授权 | 否 |
| `interaction.resolved` | 公开交互已处理 | 否 |
| `answer.delta` | 最终回答的增量文本 | 否 |
| `run.completed` | Run 成功完成 | 是 |
| `run.failed` | Run 失败 | 是 |
| `run.blocked` | 缺能力或需要外部条件 | 是 |
| `run.cancelled` | Run 已取消 | 是 |

### 5.3 路由与房间事件不增加调用负担

调用方可以观察 Teams 的选择，但事件只提供展示所需信息：

```text
event: team.route_decided
data: {"strategy":"single_worker","summary":"已交由代码实现角色处理"}

event: conversation.prepared
data: {"kind":"direct","created":true,"summary":"已准备持续对话上下文"}

event: delegation.started
data: {"participant":"PuddingClaw","task":"检查本地源码并运行测试"}
```

默认不公开 `workerId`、`roomId`、`delegationId`。如果未来需要运维诊断，使用单独的受权限保护字段或诊断 API，不能把这些 id 变成后续调用的必要参数。

### 5.4 `interaction.required` 是唯一需要调用方动作的进度事件

允许的情况：

- Manager 对 query 的必要澄清；
- Worker 权限审批；
- 明确的高风险确认；
- Workspace 不明确且无法安全选择；
- 多个不可替代业务选项必须由用户决定。

禁止的情况：

- “请选择使用哪个 Worker”；
- “请先创建一个 direct 房间”；
- “请选择 spawn 还是 HTTP”；
- “请提供 Connector id”；
- Teams 已经能够依据责任边界和运行状态自主完成的技术选择。

## 6. CLI 契约

### 6.1 最小命令

```bash
puddingteams run "分析这个项目并修复测试失败"
```

机器调用：

```bash
puddingteams run --input-json - --jsonl
```

stdin：

```json
{"query":"分析这个项目并修复测试失败"}
```

多轮：

```json
{
  "query": "继续处理剩余问题",
  "conversationId": "conv_01..."
}
```

不提供 `--target`、`--worker`、`--room`、`--connector` 或 `--transport`。

### 6.2 CLI 是 HTTP Gateway 的薄客户端

```text
外部系统 spawn puddingteams CLI
        ↓ stdin JSON
CLI POST /api/headless/v1/runs
        ↓
CLI GET eventsUrl（SSE）
        ↓ 转换 framing，不改变事件语义
stdout JSONL
```

每个 SSE event 在 stdout 对应一行：

```json
{"id":7,"event":"delegation.progress","data":{"participant":"代码实现负责人","message":"正在运行测试"}}
```

约束：

- stdout 只输出协议 JSONL，诊断写 stderr；
- Ctrl-C 调用 cancel，再退出；不能只杀 CLI 留下后台 Run；
- CLI 不直接打开 Pi Session、不读写 Window/Delegation 文件、不创建第二个 Teams Runtime；
- Teams server 未运行时明确返回连接错误；第一版不静默启动独立 Runtime；
- CLI 与 HTTP 对同一 query 产生相同的 Gateway Event 和最终结果。

### 6.3 CLI 交互命令

```bash
puddingteams respond <runId> --input-json -
puddingteams cancel <runId>
puddingteams run get <runId> --json
```

这些命令仍通过 HTTP 控制面执行，不直写本地状态。

## 7. Conversation、Run 与内部状态映射

### 7.1 公开身份

| 公开身份 | 生命周期 | 调用方职责 |
| --- | --- | --- |
| `conversationId` | 多条 Run | 后续 query 原样带回；不理解内部 Session |
| `runId` | 一条 query 的完整处理 | 订阅、查询、取消和 respond |
| `interactionId` | 一次待回答交互 | 提交选择或授权 |
| `requestId` | 创建请求幂等 | 可选；通常由 SDK/CLI 自动生成 |

### 7.2 内部映射

```text
conversationId
  → managerSessionId + room context + workspace binding

runId
  → manager run + 0..N delegationId + event sequence + terminal result

interactionId
  → InteractionBroker public id + encrypted provider state
```

映射不得反向泄漏 continuation token、Worker handle 或凭证明文。

### 7.3 并发规则

- 同一 conversation 同时只允许一个会改变对话上下文的 active Run；第二条 query 默认排队或返回明确 conflict，不得并发写同一 Manager Session；
- 不同 conversation 可以并行；
- 一个 Run 内 Manager 可以并行委派多个 Worker；
- SSE 断开不取消 Run；只有显式 cancel 或 Runtime 策略可以取消；
- server 重启后的 orphan 处理沿用现有诚实判死原则，Gateway 补写可重放的 `run.failed(errorCode:"server_restart")`。

## 8. Workspace、附件与安全边界

### 8.1 第一版本机边界

第一版可以继续：

- 默认监听 `127.0.0.1`；
- 不要求 API Key；
- CLI 自动使用本机 Gateway 地址；
- Web 与 Headless API 共用单进程 Runtime。

但只要允许 `0.0.0.0`、局域网或公网访问，就必须先完成：

- 调用方认证；
- tenant/user 身份；
- Run、conversation、workspace、artifact 的访问范围；
- SSE 和普通 REST 一致的授权检查；
- 速率、并发、body 与事件回放上限；
- 审计日志和凭证脱敏。

不得以“稍后再加 API Key”为理由，在无认证状态下开放远程写接口。

### 8.2 Workspace 不增加普通调用负担

- `workspaceId` 可选；缺省时使用 Gateway 配置的默认 Workspace；
- 不能让远程调用方传任意宿主绝对路径；
- 如果没有安全默认值且 query 确实依赖 Workspace，通过 `interaction.required` 让调用方选择用户可理解的项目；
- SSE 和最终结果只公开受管 artifact 引用，不公开未授权本地路径。

## 9. 与现有内部 API 的关系

| 现有能力 | Gateway 如何复用 | 是否直接公开 |
| --- | --- | --- |
| `PiSessionStore` | 创建/恢复 Manager Session、订阅内部事件 | 否 |
| Room/Window Store | 建立 conversation 上下文、自动复用 direct/group | 否 |
| `AgentInvoker` | Manager 委派与取消 Worker | 否 |
| Driver Runtime | Worker run/continue/respond/cancel | 否 |
| `InteractionBroker` | 保存和恢复 HITL | 仅公开安全 interaction 投影 |
| Delegation Timeline | 生成 Worker 过程事件 | 仅公开有界 Gateway Event |
| `POST /api/sessions/:id/messages` | Web UI 内部发送消息 | 否 |
| `/api/sessions/:id/ws` | Web UI 内部实时通道 | 否 |

Headless SSE 与现有 WebSocket 可以并存：WebSocket 服务 PuddingTeams 自己的 UI，SSE 服务北向稳定协议。两者从同一领域事件生成投影，但不保证消息格式相同。

## 10. 建议代码落点

```text
apps/server/src/headless/
  gateway.ts                 # TeamsHeadlessGateway 应用服务
  conversation-store.ts      # conversationId → 内部上下文
  run-store.ts               # Gateway Run 权威状态与终态
  event-store.ts             # 按 runId/seq 追加、重放
  project-event.ts           # 内部事件 → GatewayEvent
  types.ts

apps/server/src/routes/
  headless.ts                # REST + SSE，仅做协议校验与调用 gateway

packages/puddingteams-cli/
  bin/puddingteams.js        # 增加 run/respond/cancel/get 路由
  runtime/...                # CLI bundle 中的 Headless HTTP client
```

依赖方向：

```text
routes/headless ──> TeamsHeadlessGateway ──> 现有领域服务
CLI client ───────> HTTP Headless API
```

禁止：

```text
CLI ──> 直接读写 state/*.json 或 sessions/*.jsonl
Gateway ──> 绕过 Manager 直接让调用方指定 Driver
routes/headless ──> 复制一套 direct-dispatch / InteractionBroker 状态机
```

## 11. 开发顺序

### Phase 1：冻结公开契约与持久化

1. 定义 Gateway Run/Event/Conversation 类型；
2. 实现 RunStore、EventStore 与 requestId 幂等；
3. 实现内部事件的安全投影；
4. 覆盖断线重放、终态重读和 server restart。

退出条件：可以在不接 HTTP 的测试里提交 query，得到持久 Run、可重放事件和终态。

### Phase 2：接通 Manager 与自动路由

1. Gateway 创建/恢复独立 conversation；
2. query 进入 Manager Session；
3. Manager 自己回答、单 Worker、多 Worker 都映射到同一 Run；
4. 自动创建/复用 direct/group 上下文，不修改 Web UI activeSession；
5. HITL 映射为 `interaction.required/respond`。

退出条件：调用只传 query，Teams 可完成自己回答、单 Worker 委派和并行委派，调用方全程不提供 target。

### Phase 3：HTTP REST + SSE

1. 实现 health、create/get/respond/cancel；
2. 实现 SSE heartbeat、Last-Event-ID、终态收口；
3. 设置 body、事件大小、并发和慢消费者上限；
4. 本机回环 E2E。

退出条件：断开 SSE 后 Run 继续，重连不丢不重算，GET 可取得最终结果。

### Phase 4：CLI spawn 适配

1. 增加 `puddingteams run/respond/cancel/get`；
2. stdin JSON、stdout JSONL、stderr 诊断严格分流；
3. SSE → JSONL 一对一转换；
4. Ctrl-C cancel 与退出码契约；
5. CLI/HTTP 事件一致性测试。

退出条件：外部 Agent 可以 spawn CLI，只提交 query，并看到与 HTTP 等价的流式过程和结果。

### Phase 5：远程认证与多租户

在远程监听前增加身份、scope、速率限制、审计与 artifact 访问控制。此阶段不改变 query-first 契约。

## 12. 验收标准

### 12.1 调用方负担

- [ ] `POST /runs` 只传 `{query}` 可以完成一次 Run；
- [ ] CLI 只传 query 可以完成一次 Run；
- [ ] 公开请求没有 target/worker/room/connector/transport；
- [ ] Worker 停用、改名或替换不要求调用方修改请求；
- [ ] Manager 可以根据 query 自主决定零、一个或多个 Worker。

### 12.2 事件与结果

- [ ] 路由、委派、进度、交互和终态通过 SSE 可观察；
- [ ] 内部创建/复用房间可以作为进度报告，但不要求调用方处理；
- [ ] SSE 重连支持 Last-Event-ID，不重新执行 Run；
- [ ] GET Run 可重新读取终态和最终结果；
- [ ] CLI JSONL 与 HTTP SSE 语义一致；
- [ ] 公开事件不含 token、Worker handle、Connector 配置或未授权路径。

### 12.3 生命周期

- [ ] 同一 conversation 可连续多轮；
- [ ] waiting_input 通过 respond 恢复原 Run，不创建新 Run；
- [ ] cancel 真正取消 Manager/Delegation，不只是断开流；
- [ ] 同 Run 可并行委派多个 Worker；
- [ ] server restart 后返回诚实、可重放的失败终态。

## 13. 最终边界

PuddingTeams 北向协议表达的是：

> “把这条 query 交给这个团队，持续告诉我团队在做什么，并在完成、失败或需要我决定时给出结构化事件。”

它不表达：

> “告诉我你有哪些 Worker，让我选择一个，再告诉我如何创建房间和选择 transport。”

调用方只负责提出任务、接收进度、回答真正需要外部决策的交互，以及消费最终结果。Manager、Worker、Room、Connector、transport 和内部恢复机制始终由 PuddingTeams 自己负责。
