# PuddingClaw Worker + PuddingTeams Pi Platform 三阶段实施方案

> 日期：2026-08-03
>
> 状态：已按 PuddingClaw Worker / 独立 Pi Platform / Room Pi Manager 三阶段修订
>
> 说明：文件名保留历史上的 `mcp` 字样；MCP 已不属于当前 v0 范围。
>
> 2026-08-20 覆盖决策：PuddingClaw 当前只支持本机回环 CLI/Backend，已取消
> Worker Access Key、`PUDDINGCLAW_TOKEN` 与 `PUDDINGCLAW_HEADLESS_TOKEN`。
> 本文件是历史快照，涉及 Token/远程 Worker 的段落不再作为实现要求；当前契约以
> PuddingClaw 仓库的 `docs/headless-worker-cli.md` 和 PuddingTeams 的
> `docs/2026-08-06-通用-agent-接入-底层与扩展方案.md` 为准。

## 1. 结论与当前优先级

方向已明确：

- **Pudding Platform 基于 Pi 自研**，Pi Manager Runtime 是 Platform 内部核心，不是外部消费者；
- **PuddingClaw 暂不抽象成 PuddingAgent**，继续保持垂域问数产品和运行时；
- **PuddingClaw 作为 Pudding Platform 的 Worker 接入**；
- **PuddingClaw Node CLI 是一个 Worker Plugin**：由 PuddingClaw 开发、发布和安装，安装后可被 Platform 探测并出现在 Worker 列表中，供 Pi Manager 根据能力自主选择；

总体严格分为三个阶段，不同阶段不交叉扩张范围：

| 阶段 | 目标 | 主要交付 | 明确不做 |
| --- | --- | --- | --- |
| **1. PuddingClaw 相关改造** | 先把 PuddingClaw 变成可被无人值守调用的 Worker | Headless API、SMART/FULL_ACCESS 自动交互、Worker Access Key、Node CLI、manifest、模型发现、自动安装 | Platform 前后端、Room、多 Worker 调度 |
| **2. 独立的 Pi Platform** | 单独建设 PuddingTeams 前后端，先跑通 Pi 调用 PuddingClaw | Node/TS Backend、Web 管理端、Pi SDK Runtime、Worker Registry/Secret Store、PuddingClawAdapter、带运行中反馈的最小 Playground | Room 持久协作、Project/DAG/Loop、完整调度 |
| **3. Room Pi Manager 调度模式** | 建设真正的长期 Room 和 Manager 自主调度 | Room/Project/Thread/Task/Run/Event、Manager Activation Queue、`team_task/team_project`、验收、恢复、Room UI | 远程多节点、MCP/A2A 等非主链路能力 |

当前只执行**阶段 1**。第一目标不是建设完整 Platform Plugin Registry，也不是 MCP，而是先打通：

```text
puddingclaw run
  → PuddingClaw Headless Run API
    → PuddingClaw Agent Run
      → 无人工等待地进入终态
        → stdout 返回稳定 JSON
```

因此阶段 1 的 v0 先完成两个核心调用交付，并补齐对外凭证管理：

1. **Headless Run API**：PuddingClaw 唯一核心调用资产；
2. **Node/TypeScript 薄 CLI**：安装在调用节点，通过 HTTP 调用 Headless Run API，先确保 `puddingclaw run` 可用；
3. **Worker Access Key**：由 PuddingClaw 签发和管理，供 Platform/CLI 访问 Worker API，不与 LLM Provider API Key 混用。

面向任意外部 Agent 或自动化调用者的 v0 业务输入收敛为两个概念：

```text
message + model
```

- `message`：任务内容；
- `model`：PuddingClaw 的**分析模型/语义模型**，对应现有前端的 `analytics_model_id`，它决定数据资产、语义资产、关系、Guardrail 和可用分析范围；这是 Worker 的核心能力绑定，不是底层 LLM。

底层 `llm_model_id`、thinking level、外部 Platform project、endpoint、token、timeout 和访问模式都属于 PuddingClaw 或 Worker 安装/运行配置，不暴露给调用 Agent 逐次选择。阶段 1 不识别尚未实现的 PuddingTeams，也不接收 Platform workspace；CLI/Backend 始终使用 PuddingClaw 自己管理的本地 `~/puddingclaw` Worker workspace。

## 2. 产品与调用边界

### 2.1 正确的包含关系

```text
阶段 1：PuddingClaw Worker
  puddingclaw Node CLI → Headless Run API

阶段 2：PuddingTeams 独立 Platform
  Platform Web ↔ Platform Backend / Pi Runtime
                         └─ Worker Registry → PuddingClaw CLI → Headless API

阶段 3：Room Pi Manager
  Room Web ↔ Room/Project/Task/Event Backend
                  └─ Pi Manager 自主选 Worker Plugin 并调度
```

Platform 不需要另开发一套用于调用 PuddingClaw 的 CLI；Pi Manager 直接使用 PuddingClaw 提供的 CLI。

### 2.2 CLI 是 Worker Plugin 的调用面

`puddingclaw` CLI 不是第二套 Agent Runtime，也不能直接初始化 PuddingClaw Python 代码。它只负责：

- 读取调用参数和 stdin JSON；
- 读取 endpoint/token 配置；
- 调用 Headless Run API；
- 将稳定 JSON 写到 stdout；
- 将诊断信息写到 stderr；
- 用稳定退出码表达 completed、blocked/failed、连接失败、超时和取消。

Session JSON 仍由 PuddingClaw Backend 单一写入。CLI 不读取、不修改 Session JSON，也不 import Backend 内部模块。

### 2.3 Plugin 与 Worker Instance 分离

一个已安装的 PuddingClaw Plugin 可以对应多个 Worker Instance：

```text
Plugin: puddingclaw

Instances:
- puddingclaw:finance
  endpoint: http://finance-puddingclaw:8888

- puddingclaw:sales
  endpoint: http://sales-puddingclaw:8888
```

本期只交付 CLI 和单 endpoint 配置能力；多实例注册、Worker 列表和 Manager 选择逻辑由后续 Pudding Platform 方案实现。阶段 1 的任务始终运行在 PuddingClaw 自己管理的 Worker workspace 中。

## 3. 现状关键事实

- `POST /api/agent` with `stream=false` 已是半个 headless：返回 `{reply, session_id, project_id, **run_outcome}`（`backend/api/agent.py:289-323`）。
- 当前阻塞点是任何 HITL interrupt 都会进入 `_astream_with_hitl_resume`，transition 到 `waiting_hitl` 并等待 resume registry；无人值守调用会永久挂起（`backend/graph/deepagents_manager.py:4745`）。
- 审批模式是 Session 级 `ApprovalMode{STRICT, SMART}`，随 Run config snapshot 冻结；SMART 已经覆盖确定性自动审批和灰区 reviewer（`backend/graph/permission_policy.py`）。本方案保留新增可信 `FULL_ACCESS` 模式的路线，但它不是 headless 的同义词。
- SMART 模式下，到达 resume 层的 `permission_request` 已经越过 SMART 自动审批边界，headless 必须 fail-closed；FULL_ACCESS 模式下，只有仍处于服务端预配置 Worker authority scope 内的请求才允许自动 approve，硬边界外仍自动 reject。
- 业务确认类 interrupt 并非都能用一个 `approve` payload 解决：维度构建、逻辑数据集和 Skill Plan 都有各自的校验、状态或副作用契约。
- 现有 Backend 无统一 API 鉴权，开发/打包链路还可能监听 `0.0.0.0`；只给新路由加 token 不能保护仍对外可达的旧 `/api/agent`。

## 4. Headless 交互与审批语义

### 4.1 Headless 与访问模式分离

`ApprovalMode` 表达授权审批强度，headless 表达遇到交互时如何继续，两者是不同维度。本方案不新增 `ApprovalMode.HEADLESS`，而是采用：

```text
approval_mode = strict | smart | full_access
interaction_mode = interactive | auto
```

Headless Run 首版默认使用：

```text
approval_mode = smart
interaction_mode = auto
```

可信本地部署可以由服务端显式切换为：

```text
approval_mode = full_access
interaction_mode = auto
```

`FULL_ACCESS` 的语义是**预配置 Worker authority scope 内完全授权、无需人工审批**，不是关闭沙箱或允许任意宿主机访问：

- 项目目录、Workspace、已配置数据源、允许的网络和显式挂载目录属于可自动批准范围；
- Docker/Workspace 隔离、只读数据策略、SQL guardrail、凭证边界和显式禁止目录继续生效；
- 超出服务端 authority scope 的路径、网络、工具或能力仍自动 reject；
- FULL_ACCESS 只解决权限审批，不代表自动确认数据库口径、维度规则、逻辑数据集规则或 Skill Plan 等业务决定。

访问模式只能由 PuddingClaw 服务端配置或预先创建的 Session policy 决定。CLI 请求不得把 `smart` 自行提升为 `full_access`。建议使用服务端配置 `PUDDINGCLAW_HEADLESS_APPROVAL_MODE=smart|full_access`，默认值为 `smart`。

`interaction_mode` 和最终 `approval_mode` 都必须进入 Run config snapshot，恢复过程中不能因外部配置变化而改变。Headless API 新建的专用 Session 要写入可识别的 worker/headless metadata；传入已有 `session_id` 时必须校验它允许 headless 调用，不能把交互 Session 静默切成无人值守模式。

### 4.2 v0 自动处理矩阵

v0 的目标是**不永久等待并进入终态**，不是保证所有任务都 `completed`。

| Interrupt | v0 行为 | 说明 |
| --- | --- | --- |
| `permission_request` | SMART：自动 reject；FULL_ACCESS：authority scope 内自动 approve、范围外 reject | 自动审批结果必须留痕，硬边界永不放开 |
| `user_input_request` | 允许时 `agent_decide`；否则 cancel/blocked | 现有契约是 `submit/cancel/agent_decide`，不存在通用 `decline` |
| `database_sql_revision_request` | reject 或 blocked，并返回 `needs_input` | 不能静默批准对用户业务口径的修改 |
| `dimension_build_rule_request` | cancel/blocked，并返回 `needs_input` | confirm 需要完整、校验后的 `build_rule` |
| `logical_dataset_rule_request` | cancel/blocked，并返回 `needs_input` | confirm 需要来源表、基准表和 schema 策略 |
| `skill_plan_confirmation_request` | cancel/blocked，并返回 `needs_input` | 不只是一条确认值，还关联计划 commit 状态 |

业务确认的确定性自动生成策略属于后续版本；在没有可靠 resolver 前，不得用空 `confirm` 伪造用户决定。

### 4.3 首版发布策略：先 SMART，按中断数据决定是否切 FULL_ACCESS

第一轮实现和真实试跑默认启用 `smart + auto`。每个 Run 统计：

- interrupt 总数；
- 各 interrupt type 次数；
- permission target/capability 的脱敏分类；
- SMART 自动通过次数；
- resume 层自动 reject 次数；
- 因 reject 导致的 blocked/failed 次数；
- 任务是否可以在不扩大权限的情况下完成。

响应和 Trace 增加机器可读 `interrupt_summary`。完成一批真实问数任务后再判断：

- 如果 resume 层 permission interrupt 很少，继续默认 SMART；
- 如果大量任务因同一类边界内权限被拒而失败，补强确定性 SMART policy；
- 如果部署环境是用户明确授权的本地专用 Worker，且 authority scope 已收敛，可由运维显式启用 FULL_ACCESS；
- 不允许为了降低中断数量而把项目外路径、宿主机敏感目录或任意网络纳入默认 FULL_ACCESS。

### 4.4 必须经过 Resume Registry 正式处理

Headless 分支不能只手工构造 `Command(resume=...)` 后跳过 registry，否则会遗留 pending future、pending request 和错误的审计状态。

新增统一的 `HeadlessInterruptResolver`（具体文件实现时确定），职责是：

1. 根据 interrupt type 选择策略；
2. 调用对应 resume registry 的正式 resolve/reject/cancel 路径；
3. 取得 registry 规范化后的 decision payload；
4. 完成 pending future/request 清理；
5. 写入 decision trace；
6. 生成 LangGraph `Command(resume=...)`；
7. 汇总 `auto_resolved` 和 `needs_input`。

交互模式原有路径保持不变。

## 5. v0 Headless Run API 契约

### 5.1 Endpoint

新增 `backend/api/headless.py`：

```http
POST /api/headless/runs
Authorization: Bearer <worker-access-key>
Content-Type: application/json
```

请求：

```json
{
  "message": "分析上个月销售下降原因",
  "analytics_model_id": "sales-analysis-model",
  "session_id": null,
  "metadata": {
    "room_id": "room-123",
    "task_id": "task-456",
    "caller": "external-agent"
  }
}
```

v0 采用同步等待，复用 `api/agent.py` 的非流式消费逻辑，外层使用可取消的 timeout。超时或客户端取消必须触发现有 Agent cancellation 清理，使 Run 落为终态，不能留下 active Run。

字段约定：

- `analytics_model_id` 是唯一对外部调用者暴露的模型参数，对应现有前端“选择分析模型”，必须来自 PuddingClaw Analytics Model Registry；
- 模型绑定决定本次 Run 可使用的数据资产、语义资产、关系、Guardrail 和分析上下文，不允许把它替换为通用 LLM 名称；
- `llm_model_id` 和 `thinking_level` 不进入 Worker CLI 协议，PuddingClaw 按 Backend 配置选择底层 LLM；
- 外部 Platform project 不进入任务请求。CLI/Backend 自动解析和注册 PuddingClaw 自己的 Worker workspace，Agent Runtime 内部继续使用稳定 `project_id`；未来 Platform 在 Adapter/ExecutionRecord 中维护 Room、Task 与本次 Worker Run 的映射；
- timeout 由 CLI/Worker Instance 配置控制，不要求 Pi Manager 在每个任务里生成。

模型选择规则：

- 已提供且有效：冻结到本次 Run config snapshot；
- 未提供：不静默使用“无分析模型”或任意默认模型，不启动 Run，返回结构化 `needs_input` 和可选模型；
- ID 无效或模型当前不可用：同样返回候选模型，并说明原选择不可用；
- Registry 只有一个可用模型时也可以在响应中标记为 `recommended`，但是否自动绑定由 Platform policy 决定，PuddingClaw 默认仍要求明确选择。

响应：

```json
{
  "schema_version": "1",
  "run_id": "run-xxx",
  "session_id": "session-xxx",
  "session_ttl_seconds": 86400,
  "session_expires_at": 1785897600.0,
  "project_id": "proj_xxx",
  "analytics_model_id": "sales-analysis-model",
  "approval_mode": "smart",
  "status": "completed",
  "outcome": "completed",
  "reply": "……",
  "final_response": "……仅最后一次 Assistant content……",
  "verification": {
    "status": "not_required",
    "summary": ""
  },
  "budget_exhaustion_reason": null,
  "model_call_count": 3,
  "auto_resolved": [],
  "interrupt_summary": {
    "total": 0,
    "auto_approved": 0,
    "auto_rejected": 0,
    "by_type": {}
  },
  "needs_input": null
}
```

`reply` 为兼容字段，保留本 Run 聚合后的全部用户可见 Assistant content；`final_response` 只取最后一次 Assistant content，不包含工具调用前的过程叙述。未来的外部 Agent Adapter 应把 `final_response` 映射为 tool result 的 `content`，把 `reply`、Run 元数据和验收信息保留在 `details` 中。

`auto_resolved` 和 `needs_input` 属于 v0，而不是推迟到 v1。Pi Manager 必须能判断 Worker 为什么未完成、是否应补充输入后重试。

未选择分析模型时，Worker 不启动 Run，返回例如：

```json
{
  "schema_version": "1",
  "status": "needs_input",
  "outcome": "model_selection_required",
  "needs_input": {
    "type": "analytics_model_selection",
    "prompt": "请选择 PuddingClaw 分析模型",
    "options": [
      {
        "id": "sales-analysis-model",
        "name": "销售经营分析",
        "description": "销售趋势、区域和商品分析",
        "version": "1.0.0",
        "tags": ["sales"]
      }
    ]
  }
}
```

外部调用 Agent 将 `prompt/options` 告诉用户，取得选择后以相同任务和选中的 model ID 再次调用 Worker。

### 5.2 Session 规则

- 无 `session_id`：创建专用 headless worker Session，默认 `approval_mode=smart`；只有服务端显式配置时使用 `full_access`，并写入 headless/worker metadata；
- 有 `session_id`：验证 Session 存在、无 active Run、允许 headless 调用；
- CLI/API 调用参数不得提升 Session 的 approval mode；
- 同一 Session 禁止并发 Run；
- CLI 重试不应无条件重复执行。正式异步 API 前，至少为请求预留 `request_id` / `Idempotency-Key` 契约。

### 5.3 鉴权和监听边界

- PuddingClaw 签发专用 **Worker Access Key**，语义是 Platform/Worker 调用凭证，不是 LLM Provider API Key；
- PuddingClaw 前端在“设置 → Worker 接入”管理 Key：创建、只显示一次明文、复制、轮换、吊销，列表只显示名称和前缀；
- Backend 只保存 `key_id/prefix/secret_hash/name/scopes/allowed_analytics_models/authority_profile/expires_at/last_used_at/revoked_at`，不保存可回显的明文；
- 每个外部 Agent 集成或安装实例使用独立 Key，支持独立审计和吊销，不得所有调用方共用一个全局 token；未来 PuddingTeams Worker Instance 沿用该规则；
- v0 scope 至少包含 `worker:health`、`worker:models:read`、`worker:runs:create`、`worker:runs:read`、`worker:runs:cancel`；
- Key 只设置该 Worker 允许的最大 authority profile，CLI/请求参数不能把 SMART 提升为 FULL_ACCESS；
- CLI 使用 `Authorization: Bearer <worker-access-key>`，由 Platform Secret Store 通过环境变量或 Secret Mount 注入，不提供 `--token`；
- 同机安装可由 PuddingClaw 部署程序自动创建 machine-local Key 并写入仅当前系统用户可读的凭证存储；远程接入则从前端创建并导入 Platform Secret Store；
- `PUDDINGCLAW_HEADLESS_TOKEN` 只作为阶段 1 开发期单静态 Key 兼容项，产品契约统一使用 Worker Access Key；
- 本机 v0 默认要求 Backend 绑定 `127.0.0.1`；
- 若部署为远程 Worker，必须通过反向代理/网络策略只暴露受保护的 worker API，不能让未鉴权的 `/api/agent` 成为绕过路径；
- Worker Access Key 管理 API 本身只能由 PuddingClaw 管理员访问；如果 Backend 远程可达，必须先补管理端用户鉴权或放在受保护反代后，不能暴露无鉴权的 Key 创建接口；
- CLI 不输出 token，不把 token 写入 stdout、Trace 或异常详情。

最小管理 API：

```http
POST   /api/worker-access-keys
GET    /api/worker-access-keys
POST   /api/worker-access-keys/{id}/rotate
DELETE /api/worker-access-keys/{id}
```

## 6. Node/TypeScript Worker Plugin CLI

### 6.1 目录与包

CLI 位于 PuddingClaw 仓库，但与 Python Backend 解耦：

```text
packages/puddingclaw-cli/
├─ src/
│  ├─ cli.ts
│  ├─ client.ts
│  ├─ commands/
│  │  ├─ run.ts
│  │  ├─ doctor.ts
│  │  ├─ capabilities.ts
│  │  ├─ workspace.ts
│  │  └─ models.ts
│  └─ output.ts
├─ worker.manifest.json
├─ package.json
├─ tsconfig.json
└─ test/
```

包建议命名：

```text
@pudding/worker-puddingclaw
```

命令入口保持：

```text
puddingclaw
```

使用 Node 20+ 原生 `fetch` 和 `AbortSignal`；CLI 不依赖 Python、`pipx`、Backend venv 或 Session 文件。

### 6.2 v0 命令

首个必须打通的命令：

```bash
puddingclaw run "分析上个月销售下降原因" \
  --model sales-analysis-model \
  --json
```

为 Platform/Pi 调用提供 stdin JSON，避免模型生成内容经过 shell 转义：

```bash
printf '%s' '{"message":"分析上个月销售下降原因","model":"sales-analysis-model"}' \
  | puddingclaw run --input-json - --json
```

CLI 的业务参数保持最小：

```text
puddingclaw run <message> [--model <analytics_model_id>]
```

- `--model` 精确映射 API 的 `analytics_model_id`，不是 `llm_model_id`；
- `--model` 未提供或无效时，CLI 不把它当作普通参数错误，而是输出结构化模型候选和 `needs_input`，使外部 Agent 能向用户询问；
- `--json` 和 `--input-json -` 是机器协议开关，不属于 Agent 的业务决策；
- `session_id`、Room/Task metadata 等连续性字段只保留在 stdin JSON 协议中，不扩展为一组常规命令行参数；
- 不暴露 `--project`、`--llm-model`、`--thinking`、`--approval-mode`、`--token`、`--endpoint` 或任意本地路径参数。

同时提供最小探测面：

```bash
puddingclaw version --json
puddingclaw doctor --json
puddingclaw capabilities --json
puddingclaw models list --json
```

`models list` 通过 Headless API 返回与现有前端“选择分析模型”相同的数据。它至少包含 `id/name/description/version/tags`，供 Pudding Platform 渲染 Worker 模型选择器；不得返回本地模型路径、数据源凭证、Provider Key 或未脱敏连接信息。

`capabilities --json` 必须声明 `analytics_model_selection.required=true` 和动态模型发现命令。这样任意外部 Agent Adapter 都可以先发现模型，也可以直接调用 `run`，再根据 `needs_input.options` 向用户询问。

后续异步 API 出现后再增加：

```bash
puddingclaw runs submit
puddingclaw runs get <run_id>
puddingclaw runs wait <run_id>
puddingclaw runs cancel <run_id>
```

### 6.3 配置

CLI 读取：

```text
PUDDINGCLAW_URL=http://127.0.0.1:8888
PUDDINGCLAW_TOKEN=<worker-token>
PUDDINGCLAW_PROJECTS_ROOT=<optional, defaults to the local user's home>
PUDDINGCLAW_TIMEOUT_S=600
```

兼容旧方案时可同时接受 `PUDDINGCLAW_BACKEND_URL` / `PUDDINGCLAW_HEADLESS_TOKEN`，但文档和新部署统一使用上面的短名称。secret 由环境变量或 Secret Mount 注入，不写入 `worker.manifest.json`。

`PUDDINGCLAW_HEADLESS_APPROVAL_MODE` 是 Backend 的服务端配置，不是 CLI 配置。`doctor --json` 可以报告当前有效模式，但 CLI 不提供将模式提升为 `full_access` 的参数。

`PUDDINGCLAW_PROJECTS_ROOT` 是 CLI 与 Backend 的共享部署配置：本机部署时两侧必须解析到同一个目录；若两进程使用不同系统用户，安装器必须显式配置同一挂载路径，不能分别使用各自的 home。

### 6.4 PuddingClaw Worker workspace

阶段 1 只定义 PuddingClaw 自身的执行目录，不定义外部 Platform 身份或目录。默认规则为：

```text
${PUDDINGCLAW_PROJECTS_ROOT:-$HOME}/puddingclaw
```

CLI 在发起 Run 前幂等创建该目录，Backend 在同一路径上注册并返回稳定的内部 `project_id`。目录已存在时直接复用，不清空、不覆盖内容。CLI 不提供 `--project` 覆盖入口，避免外部 Agent 把模型生成内容变成本地路径授权。

外部 Agent 只需要安装 CLI 并提供 Worker Access Key。调用方身份由 Key 记录和未来 Adapter 自己的 ExecutionRecord 管理，不进入阶段 1 的 CLI 参数、响应字段或 workspace 命名。远程 Backend 若看不到 CLI 所在主机的本地目录，必须由部署配置提供双方可见的 `PUDDINGCLAW_PROJECTS_ROOT`；跨主机目录同步不属于 CLI v0。

### 6.5 stdout、stderr 与退出码

- `--json` 时 stdout 只能出现一个协议 JSON；
- 人类可读输出默认优先打印 `final_response`；兼容旧 Worker 未返回该字段时才回退到 `reply`；
- 日志、重试提示和诊断信息全部写 stderr；
- `SIGINT` 必须中止 HTTP 请求并返回 `130`。

退出码：

| Code | 含义 |
| --- | --- |
| `0` | Run completed |
| `1` | Worker 返回 needs_input/blocked/failed/verification_failed 等非 completed 终态 |
| `2` | CLI 参数、协议、连接或鉴权错误 |
| `3` | CLI 等待超时 |
| `130` | 调用方取消 |

## 7. Worker Plugin Manifest 与 Platform 探测契约

完整 Worker Plugin Registry 属于 Pudding Platform 后续任务，但 PuddingClaw CLI 从 v0 起提供稳定 manifest 和探测命令，避免未来重做。

`worker.manifest.json` 示例：

```json
{
  "schemaVersion": "1",
  "id": "puddingclaw",
  "name": "PuddingClaw",
  "description": "企业数据分析、NL2SQL、知识查询和指标归因 Worker",
  "kind": "agent-worker",
  "protocolVersion": "1",
  "transport": {
    "type": "cli",
    "command": "puddingclaw",
    "input": "stdin-json",
    "output": "stdout-json"
  },
  "capabilities": [
    "data.query",
    "data.analysis",
    "data.nl2sql",
    "knowledge.query"
  ],
  "modelSelection": {
    "type": "analytics_model",
    "required": true,
    "discoveryCommand": ["models", "list", "--json"]
  },
  "commands": {
    "probe": ["doctor", "--json"],
    "capabilities": ["capabilities", "--json"],
    "models": ["models", "list", "--json"],
    "run": ["run", "--input-json", "-", "--json"]
  }
}
```

`puddingclaw doctor --json` 至少返回：

```json
{
  "schema_version": "1",
  "agent_id": "puddingclaw",
  "cli_version": "0.1.0",
  "protocol_version": "1",
  "configured": true,
  "authenticated": true,
  "reachable": true,
  "server_version": "0.1.0",
  "project_id": "proj_xxx",
  "workspace_ready": true,
  "capabilities": ["data.query", "data.analysis", "data.nl2sql", "knowledge.query"]
}
```

不得返回 token、Provider Key 或可还原凭证的信息。

`puddingclaw models list --json` 返回面向用户的安全摘要：

```json
{
  "schema_version": "1",
  "model_type": "analytics_model",
  "required": true,
  "models": [
    {
      "id": "sales-analysis-model",
      "name": "销售经营分析",
      "description": "销售趋势、区域和商品分析",
      "version": "1.0.0",
      "tags": ["sales"]
    }
  ]
}
```

候选来自现有 `GET /api/analytics/models`，但 Headless API 必须投影为安全 DTO，不直接透传其中的 `path`、完整 data assets 或内部配置。

## 8. 安装与部署

CLI 由 PuddingClaw 构建和发布。PuddingClaw 本机安装/部署时自动安装固定版本的 Node CLI，使本地 Pi Platform 能探测到它。

开发安装：

```bash
npm install -g ./packages/puddingclaw-cli
```

正式发布建议先构建并打包固定 artifact，再由安装器安装：

```bash
npm pack ./packages/puddingclaw-cli
npm install -g ./pudding-worker-puddingclaw-0.1.0.tgz
```

不要在每次启动时在线安装 `latest`。生产镜像应预装固定版本。

如果全局 npm 目录存在权限或 PATH 问题，安装到用户级目录并建立跨平台 command shim：

```text
~/.puddingclaw/cli/
~/.local/bin/puddingclaw             # macOS/Linux
<user-bin>/puddingclaw.cmd            # Windows
```

当 Platform 与 PuddingClaw Server 不在同一节点时，Worker Plugin 包必须安装在 **Pi Manager 所在调用节点**；CLI 通过 `PUDDINGCLAW_URL` 访问远程 PuddingClaw Server。

## 9. 阶段 1：PuddingClaw 改造实施步骤

### Step 1：冻结协议与 Headless interaction policy

- 定义 API/CLI `schema_version=1`；
- 保留 `ApprovalMode{STRICT, SMART}`，增加边界受限的 `FULL_ACCESS`；
- 增加并冻结 Run `interaction_mode`；
- 建立 `HeadlessInterruptResolver`；
- 为六类现有 interrupt 定义 v0 策略；
- 从 v0 开始记录 `auto_resolved`、`needs_input` 和 `interrupt_summary`；
- 默认部署使用 SMART，FULL_ACCESS 必须由服务端显式启用。

### Step 2：Headless Run API

- 新增 `backend/api/headless.py`；
- 抽取/复用非流式 Agent stream 消费逻辑；
- 捕获 `run_started`、`verification_report`、`run_outcome` 和 `done`；
- 实现 timeout/cancellation 清理；
- 创建/校验专用 Session；
- 增加安全的分析模型发现接口，复用 Analytics Model Registry；
- 缺少/无效 `analytics_model_id` 时返回 `model_selection_required` 和候选模型，不启动 Agent Run；
- 增加 token dependency 和 router；
- 本机部署默认收敛监听地址。

### Step 3：Worker Access Key

- 新增 Worker Access Key 数据模型、哈希存储、Bearer 鉴权 dependency 和 scope 校验；
- 实现创建、列表、轮换、吊销和 last-used 审计；
- 在 PuddingClaw 设置前端增加“Worker 接入”页，Key 明文只显示一次；
- 支持 scope、可用分析模型、最大 authority profile 和有效期；
- 同机部署自动生成 machine-local Key，凭证文件权限收紧；
- 确保日志、异常、Trace、`doctor` 和前端列表都不泄露明文。

### Step 4：Node CLI 最小可运行版本

- 新增 `packages/puddingclaw-cli/`；
- 实现 HTTP client、abort、timeout、错误归一化；
- 实现 `puddingclaw run` 的 positional 和 stdin JSON 两种输入；
- 实现 `--model` 到现有 `analytics_model_id` 的映射；
- 回传 `session_id/session_expires_at`，支持通过 stdin `session_id` 或人工 `--session` 延续同一逻辑任务；
- 实现缺少/无效模型时的结构化候选输出；
- 实现 PuddingClaw Worker workspace 的用户目录幂等创建和 Backend 注册；
- 实现 print/JSON 输出与稳定退出码；
- 实现 `version/doctor/capabilities/models list`。

### Step 5：Worker Plugin 包与自动安装

- 增加 `worker.manifest.json`；
- 生成 npm tarball；
- 在 PuddingClaw 安装/部署脚本中安装固定版本 CLI；
- 验证 macOS/Linux/Windows command shim 和 PATH；
- Docker/Platform 镜像使用构建期预装，不使用启动期 latest 安装。

### Step 6：测试与文档

Backend 测试：

- interaction mode snapshot；
- STRICT/SMART/FULL_ACCESS policy 与 snapshot；
- 六类 interrupt 自动处理；
- SMART 残余 permission 自动 reject；
- FULL_ACCESS authority scope 内自动 approve、范围外自动 reject；
- registry 状态/future 不残留；
- Worker Access Key 创建/一次显示/哈希存储/scope/轮换/吊销/last-used；
- token、timeout、cancel、session 模式、并发保护；
- 仅清理 24 小时未更新且无 active Run/pending future 的 Headless Session，普通前端 Session 不参与 TTL；
- `auto_resolved` / `needs_input` / verification 输出。

Node CLI 使用 `node:test` 或项目统一测试框架覆盖：

- 参数解析与 stdin JSON；
- analytics model 字段映射、模型列表脱敏、缺失/非法模型候选响应；
- Worker workspace 幂等建目录和 Backend 注册；
- stdout/stderr 隔离；
- HTTP、鉴权、timeout、abort；
- JSON schema 和退出码；
- doctor/capabilities；
- mock server 下的成功、blocked 和失败终态。

新增 `docs/headless-worker-cli.md`，记录 API、CLI、安装、环境变量、协议和排障。

## 10. 阶段 1 明确不做

- 不抽象 PuddingAgent；
- 不开发 Pudding Platform 前后端；
- 不开发 Platform Worker Plugin Registry 和 Manager 自主选择逻辑，只冻结 PuddingClaw manifest/probe 契约；
- 不开发 Python CLI；
- 不开发进程内 CLI Runtime；
- 不开发 MCP Server；
- 不开发 A2A；
- 不做 JSONL 全事件输出；
- 不做异步 submit/status/cancel API；
- 不把 FULL_ACCESS 扩展为业务确认自动批准，不自动批准需要业务规则或副作用的 HITL；
- 不让 CLI 直接写 Session、Run、Grant 或 Trace。

MCP 以后只作为其他生态兼容层。如果 Pudding Platform 的 Pi Manager 已能通过 Worker Plugin CLI 调用 PuddingClaw，MCP 不是主链路。

这里的“不做 JSONL 全事件输出”只限制 PuddingClaw Worker CLI 的执行协议，不等于调用方界面必须一直空白等待。阶段 1 的机器调用契约固定为：

- `--json` 模式的 stdout 在 Run 进入终态后只输出一个完整 JSON，不能混入 spinner、日志或进度文本；
- stderr 只用于诊断；如果以后为人工直接调用增加 spinner，也只能写 stderr，不能成为 Platform 协议；
- CLI v0 不承诺 token、reasoning、tool call 或业务步骤的增量事件；
- 未来的外部 Agent Adapter（包括 PuddingTeams）应根据“子进程已启动、仍存活、已退出”自行投影运行中状态，不等待 CLI 先输出内容。

## 11. 验收清单

1. 启动 PuddingClaw Backend 后，以下命令无需人工介入并在超时内进入终态：

   ```bash
   puddingclaw run "分析一个已配置项目的数据" \
     --model <analytics-model-id> \
     --json
   ```

2. 无需 `--project` 或任何外部 Platform 参数；首次运行自动创建 `${PUDDINGCLAW_PROJECTS_ROOT:-$HOME}/puddingclaw`，再次运行幂等复用并返回稳定内部 `project_id`；
3. `--model` 使用与现有前端相同的 `analytics_model_id`；底层 `llm_model_id` 不出现在 CLI 接口中；
4. 未传或传入无效 model 时不启动 Run，返回 `analytics_model_selection`、用户提示和脱敏候选项；`models list` 返回同一组候选；
5. stdin JSON 调用成功，问题中的换行、引号和非 ASCII 字符不经过 shell 拼接：

   ```bash
   printf '%s' '{"message":"分析销售趋势","model":"<analytics-model-id>"}' \
     | puddingclaw run --input-json - --json
   ```

6. stdout 只有一个合法 JSON，stderr 可独立收集；
7. 完成响应包含 `schema_version/run_id/session_id/session_ttl_seconds/session_expires_at/project_id/analytics_model_id/approval_mode/status/outcome/reply/final_response/verification/auto_resolved/interrupt_summary/needs_input`；其中 `final_response` 只含最后一次 Assistant content，`reply` 继续保留聚合内容以兼容旧调用；
8. SMART 下残余 permission 自动 reject；FULL_ACCESS 下 authority scope 内自动 approve、范围外自动 reject；两种模式都不挂起并完整留痕；
9. 业务确认无法安全自动完成时，不伪造 approve，返回机器可读 `needs_input`；
10. timeout/SIGINT 后 Backend 中没有遗留 active Run 或 pending resume future；
11. 新任务回传 `session_id/session_expires_at`；同一连续任务可复用该 Session，不同任务不共享默认 Session；过期 Headless Session 返回 `410` 并被统一清理，普通 PuddingClaw Session 不受影响；
12. `puddingclaw doctor --json` 能区分未配置、鉴权失败、服务不可达和健康状态；
13. npm tarball 安装后 `puddingclaw` 位于 PATH，且不依赖 Python venv；
14. PuddingClaw 设置页可创建、轮换和吊销 Worker Access Key，明文只显示一次，Backend 只保存哈希；
15. 独立 Worker Instance Key 的 scope、分析模型范围和 authority profile 生效，吊销后立即无法调用；
16. Backend 相关 pytest、前端凭证管理测试与 Node CLI 测试全绿。

### 11.1 当前实现状态（2026-08-04）

阶段 1 聚焦 CLI 与 Headless Worker，本身不依赖 PuddingTeams。按这一边界，核心开发已经完成：真实 Worker Key 调用可进入终态，Headless API、SMART/FULL_ACCESS 基础策略、Worker Access Key 管理、Node CLI、PuddingClaw 内部 workspace、分析模型选择、`final_response`、显式 Session 连续性、24 小时 Headless-only TTL 清理、doctor、外部 Agent Skill 启动器和 npm tarball 均已有实现；CLI 相关测试通过，本机 tarball 安装后可直接执行 `puddingclaw version`。

因此阶段 1 可以标记为**开发完成，发布验证待收尾**。剩余项不再阻塞阶段 2 开始开发，但应作为阶段 1 hardening backlog 完成：

1. 增加 timeout、客户端断开和 SIGINT 后无 active Run、无 pending resume future 的回归测试；
2. 补齐六类 interrupt、Worker Access Key 轮换/过期/model scope/authority profile/last-used/立即吊销，以及前端凭证管理的直接测试；
3. 完成 Linux/Windows command shim CI 验证；macOS 本地 tarball 安装已验证。

下一开发阶段是独立 Pi Platform。PuddingTeams 的 `platform_id`、Room/Project workspace、Worker Registry 和 ExecutionRecord 均从阶段 2 开始设计，不反向写入阶段 1 的 PuddingClaw CLI 协议。

阶段 1 核心开发完成并冻结 CLI/Headless 协议后，即可开始 Pudding Platform 侧的 Worker Plugin Registry、安装检测、Worker Instance 配置和 Pi Manager 自主选择能力；以上未完成的发布验证继续作为 PuddingClaw hardening 并行收口。

## 12. 阶段 2：独立的 Pi Platform 前后端与 PuddingClaw 调用闭环

> 本阶段在阶段 1 的 CLI/Headless 核心开发完成、协议冻结后开始。目标是单独建设基于 Pi 的 PuddingTeams Platform 前后端，并跑通 `Pi → team_task → puddingclaw CLI → Headless API → 结果回到 Pi`。阶段 1 的跨平台与异常清理验证可并行继续；本阶段不实现真正 Room 调度。

### 12.1 对 Pi 官方 subagent 示例的判断

已重点阅读：

- `packages/coding-agent/examples/extensions/subagent/index.ts`；
- `packages/coding-agent/examples/extensions/subagent/agents.ts`；
- `packages/coding-agent/examples/extensions/subagent/README.md`；
- `packages/coding-agent/docs/extensions.md`；
- `packages/coding-agent/docs/rpc.md` 和 `docs/sdk.md` 中与嵌入、事件和 Session 相关的部分。

同时参考了 AgentTeams 中真正决定 Room/Task 行为的实现，而不只参考概念文档：

- `plugins/teamharness/skills/team/{roomflow,team-coordination,project-management,task-delegation,task-execution}`；
- `plugins/teamharness/mcp/server.py` 中 project-scoped Task Room 创建/复用与 task/project flow；
- `copaw/src/copaw_worker/task.py` 中 Project、Task、DAG/Loop 和 Result 状态机；
- `copaw/src/matrix/channel.py` 中 mention gating、Room 历史、thread、typing/read receipt 和防 agent ping-pong；
- `agentteams-controller/api/v1beta1/types.go` 中 Team Room、Leader DM、成员个人 Room 和成员运行状态。

官方 `subagent` example 可以直接作为 PuddingTeams `team_task` 的**执行适配模板**：

- 用 `pi.registerTool()` 把委派能力暴露给 Manager；
- 使用 TypeBox 定义严格的工具入参；
- 用 `spawn(..., { shell: false, stdio: ["ignore", "pipe", "pipe"] })` 启动隔离 Worker；
- 子 Pi 使用 `--mode json -p --no-session`，stdout 按 LF 拆分 JSONL event；
- `message_end` / `tool_result_end` 驱动进度与最终输出；
- `onUpdate` 把子任务状态持续反馈给父 Agent；
- 支持 single、parallel、chain 三种执行模式；
- AbortSignal 触发 `SIGTERM`，5 秒后兜底 `SIGKILL`；
- 汇总 turn、token、cache、cost、context 和 stop reason；
- 并行任务带数量和并发限制，返回父 Agent 的内容有 50KB 上限。

但它不是完整的 Teams Platform：

- `--no-session` 表示子任务一次性运行，没有 Room/Member 的持久上下文；
- Task 状态只存在 tool call 内存和 Pi tool result 中；
- 没有数据库任务租约、进程重启恢复、幂等、重试、Worker 心跳或跨节点调度；
- parallel/chain 是一次 tool call 内的控制流，不是持久 DAG；
- TUI `renderCall/renderResult` 不能替代 Web Room UI；
- extension reload、session replacement 或 Platform 重启后，内存中的子进程索引会失效。

结论：**复制它的 tool、spawn、abort、usage 和并发控制模式，并按 Adapter 选择输出 framing，不复制它的内存状态边界。** PiSubagentAdapter 可以复用示例的 JSONL parser；PuddingClawAdapter 必须遵守自己的 stdout 单 JSON manifest，不能为了复用示例而强制所有 Worker 改成 JSONL。

### 12.2 阶段 2 运行时分层

```text
PuddingTeams Web
  ├─ Worker 接入/安装/健康页
  ├─ Worker Instance 凭证与分析模型配置
  └─ Pi Playground（单会话调用验证）
  ↕ HTTP/WebSocket
PuddingTeams Backend
  ├─ Platform Config / Worker Registry / Secret Store
  ├─ Pi AgentSessionRuntime（Playground/集成验证）
  ├─ PuddingTeams Extension
  │    └─ team_task tool（最小 Worker 调用）
  ├─ Platform Orchestrator
  │    ├─ Worker Plugin Registry
  │    ├─ Worker Instance Registry
  │    ├─ Secret Resolver
  │    └─ Local Process Supervisor
  └─ Worker Adapters
       ├─ PiSubagentAdapter → pi --mode json -p --no-session
       ├─ PuddingClawAdapter → puddingclaw run --input-json - --json
       └─ OtherCliAdapter → manifest command
```

PuddingTeams Backend 是独立 Node/TypeScript 服务，前端是独立 Web 应用。Backend 优先直接使用 Pi SDK 的 `createAgentSession()` / `AgentSessionRuntime`；`pi --mode rpc` 只作为进程隔离、跨语言部署或早期排错时的替代方案。

阶段 2 只需少量的 Playground Session/ExecutionRecord 用于调试和审计，不建 Room/Project/Task 领域模型，不做 Room Activation Queue，不把临时 Playground Session 包装成 Room。

### 12.3 `team_task` Extension 的职责

建议把 PuddingTeams extension 做成多文件 npm/pi package：

```text
packages/puddingteams-extension/
├─ package.json
└─ src/
   ├─ index.ts                 # registerTool + lifecycle hooks
   ├─ platform-context.ts      # 绑定 tenant/user/platform identity
   ├─ orchestrator-client.ts   # 调 Platform 内部调度服务
   ├─ team-task-tool.ts        # schema/result mapping
   └─ renderers.ts             # 仅供 Pi TUI 调试，可选
```

Backend 创建 Playground `AgentSessionRuntime` 时，通过 SDK `DefaultResourceLoader.extensionFactories` 注入带名字的 inline extension factory，并用闭包绑定不可伪造的 `PlatformContext`。npm package 提供 factory，凭证和 Worker Instance 配置不落入模型输入：

```ts
const teamsExtension = {
  name: "puddingteams",
  factory: createPuddingTeamsExtension({ platformContext, orchestratorClient }),
};
```

`team_task` 的 LLM 可见参数保持任务语义，不把 Platform 内部状态交给模型生成：

```ts
type TeamTaskInput = {
  task: string;
  worker?: string;             // Manager 可指定；省略时 Orchestrator 按能力匹配
  model?: string;              // 仅对需要业务模型的 Worker，例如 PuddingClaw analytics_model_id
};
```

以下字段由 extension 从服务端 Platform context 注入，不放进 tool schema：

```text
user/tenant identity
platform_id
worker access/approval policy
trace/correlation id
```

阶段 2 的 `team_task` 只证明 Pi 能根据 Registry 选择 Worker Plugin，并通过 Adapter 完成调用。它只保存最小 `ExecutionRecord`，不创建 Room、Project、Task 或 Thread：

```ts
type TeamTaskResult = {
  execution_id: string;
  worker_plugin_id: string;
  worker_instance_id: string;
  status: "running" | "completed" | "needs_input" | "failed" | "cancelled";
  result?: unknown;
  needs_input?: unknown;
};
```

`execute()` 不直接把所有调度逻辑塞进 extension，而是：

1. 向 Platform Orchestrator 创建最小 ExecutionRecord；
2. Pi Manager 根据 Registry 能力摘要选择 Worker Plugin；Orchestrator 只在该 Plugin 下选择健康 Worker Instance；只有唯一候选等确定性场景才允许省略 worker；
3. Process Supervisor 通过对应 Adapter 执行；
4. Playground 通过 WebSocket 展示最小进度；
5. extension 使用 `onUpdate` 把压缩进度反馈给 Pi Manager；
6. 完成后只把稳定、截断后的 Worker result 返回给 Manager；
7. Pi 在 Playground 中继续生成最终回复。

Pi Extension 的 `signal` 必须传播为 Platform cancel，再由 Adapter 终止 CLI/HTTP Run。不能只让 tool call 返回取消而留下后台任务继续运行。

#### 12.3.1 执行活动反馈：不依赖 PuddingClaw 流式输出

必须区分两种不同能力：

1. **Platform 活动状态实时化**：Platform 知道任务已被接受、CLI 已启动和子进程是否仍存活，因此可以立即展示 `running`；阶段 2 必须实现。
2. **Worker 业务进度流式化**：PuddingClaw 主动输出 reasoning、工具调用、查库步骤或部分答案；CLI v0 不提供，未来通过 JSONL/SSE/异步 Run 协议补充。

`PuddingClawAdapter` 启动同步 CLI 时按以下状态机执行：

```text
ExecutionRecord.created
  → spawn puddingclaw CLI
    → ExecutionRecord.running + execution.started WebSocket event
      → 等待单个 stdout JSON（前端本地显示运行时长/动画）
        ├─ completed   → execution.completed
        ├─ needs_input → execution.needs_input
        ├─ failed      → execution.failed
        └─ cancel      → execution.cancelled
```

Playground 在收到 `execution.started` 后立即显示“PuddingClaw 正在处理…”，不等待 CLI stdout。extension 的 `onUpdate` 也先向 Pi Runtime 报告压缩后的 started/running 状态，使 Pi 工具调用卡片保持 active。CLI 完成后，Platform 解析唯一 JSON 并用终态替换运行中状态。

可选的 Process Supervisor heartbeat 只表示“进程仍存活”，可以更新 `last_heartbeat_at`；它不是百分比或业务进度，默认不连续写入聊天时间线。前端根据持久的 `ExecutionRecord.status=running` 和 `started_at` 自行显示动画与耗时；WebSocket 断线重连后从 Backend 状态恢复，不能依赖一次性的前端乐观状态。

这与 AgentTeams 的聊天室体验一致：AgentTeams 在收到任务后立即开启并续期 typing indicator，同时创建“处理中...”占位消息，完成后再更新占位内容。该反馈由 Channel/Platform 层产生，并不能推导出下游 Worker 必须流式返回。

### 12.4 Worker 发现与 PuddingClaw 分析模型选择

Worker Plugin Registry 从已安装包的 manifest 和 probe 命令建立目录：

```text
discover package/manifest
  → command -v / executable probe
  → doctor --json
  → capabilities --json
  → models list --json（若 manifest 声明动态业务模型）
```

Pi extension 支持启动后动态注册工具，但 PuddingTeams v0 建议保持一个稳定的通用 `team_task`，执行时实时读取或短 TTL 缓存 Registry。Manager 在 `session_start` / `before_agent_start` 获得最新能力摘要，完整 Worker/模型目录按需读取，避免目录过大污染上下文，也避免频繁重注册工具 schema。

PuddingClaw 的 `model` 明确是 `analytics_model_id`：

```text
Manager 选择 PuddingClaw
  → team_task 未带 model
    → PuddingClawAdapter 执行 models list 或收到 model_selection_required
      → team_task 返回结构化 needs_input.options
        → Pi Manager 向用户展示分析模型名称、说明、版本和标签
          → 用户选择
            → Manager 再次 team_task(..., model=<analytics_model_id>)
```

底层 LLM model 不进入该流程，由 PuddingClaw Backend 自己配置。PuddingClaw 模型列表必须经过 Headless 安全 DTO 投影，不向 Platform UI 或 Pi 暴露路径、数据源凭证或内部连接配置。

### 12.5 阶段 2 前后端设计与验收

独立 Platform 仓库/服务建议至少分为：

```text
puddingteams/
├─ apps/
│  ├─ web/                       # 独立 Platform 前端
│  └─ api/                       # Node/TypeScript Backend + Pi SDK
├─ packages/
│  ├─ puddingteams-extension/    # team_task
│  ├─ worker-registry/           # manifest/probe/capability
│  ├─ worker-adapters/           # PuddingClaw/Pi/other CLI
│  └─ protocol/                  # DTO/event/schema
└─ infra/                             # DB/secret/deployment
```

前端最小页面：

1. **Workers**：展示已发现 Plugin、CLI 版本、安装/配置/健康状态和 capability；
2. **Worker Instance**：配置 endpoint，导入 PuddingClaw Worker Access Key，密钥提交后只显示 `configured/prefix/last_verified_at`，不再回显明文；
3. **Models**：调用 `models list` 展示 PuddingClaw 分析模型，不展示底层 LLM；
4. **Pi Playground**：一个最小对话/运行页，展示 Pi streaming、`team_task` call、Worker `running` 状态与耗时、可用时的真实进度、`needs_input` 和最终回复；不能把本地动画或 heartbeat 标成业务进度。

Backend 最小模块：

```text
PiRuntimeService
WorkerPluginRegistry
WorkerInstanceService
EncryptedSecretStore
PuddingClawAdapter
LocalProcessSupervisor
PlaygroundSessionService
ExecutionRecordStore
```

PuddingClaw Worker Access Key 只进入 `EncryptedSecretStore`。Pi prompt、tool args、ExecutionRecord、WebSocket event、日志和前端 API 都只持有 `secret_ref`，真实 Key 只在 Adapter 启动 CLI 前短暂解析并通过环境变量注入。

阶段 2 验收门禁：

1. PuddingTeams Web/API 与 PuddingClaw 是独立进程和独立部署单元；
2. Registry 能发现已安装 `puddingclaw` CLI，并显示 installed/configured/healthy 状态；
3. 在 Platform 中导入 Worker Access Key 后，`doctor/models list` 通过；缺失、过期或被吊销 Key 有明确错误；
4. 用户在 Pi Playground 输入分析任务，Pi 根据 capability 选中 PuddingClaw 并调用 `team_task`；
5. 未绑定分析模型时，Playground 显示 PuddingClaw 返回的脱敏候选，用户选择后继续原任务；
6. `team_task` 通过 `puddingclaw run --input-json - --json` 完成调用，Pi 拿到结果并在 Playground 生成最终回复；
7. CLI 尚未输出时，Playground 已能基于 `ExecutionRecord.running` 显示“PuddingClaw 正在处理…”；刷新或 WebSocket 重连后仍能恢复运行中状态；
8. timeout/cancel 能清理 CLI 和 PuddingClaw Run，明文 Key 不出现在前端、Pi context、stdout 或日志。

上述闭环通过后才进入阶段 3。不得为了提前演示而在 Playground 数据模型上直接叠加 Room/Project/Task；阶段 3 按正式领域模型实现。

## 13. 阶段 3：真正的 Room Pi Manager 调度模式

阶段 3 在阶段 2 已验证的 Pi Runtime、Registry、Secret Store、Supervisor 和 Adapter 之上新增持久协作层：

```text
PuddingTeams Room Web
  ↕ HTTP/WebSocket
PuddingTeams Backend
  ├─ Room / Project / Thread / Message / Task / Run / Event Store
  ├─ Room Activation Queue（同一 Room 串行唤醒 Manager）
  ├─ Pi Manager AgentSessionRuntime（每个活跃 Room 一个 runtime）
  ├─ PuddingTeams Extension
  │    ├─ team_task（Direct/Quick Task 委派）
  │    └─ team_project（DAG/Loop/验收/revision）
  └─ 复用阶段 2 Orchestrator / Registry / Supervisor / Adapters
```

阶段 2 的 `team_task` ExecutionRecord 升级为 Quick Task 原子入口：同一事务创建 `Project(mode=quick)`、Task、Task Thread 和首个 Run，返回 `project_id/task_id/thread_id/run_id/status`。复杂项目不继续扩充 `team_task` 参数，另用稳定项目工具：

```text
team_project.create      创建 Project，选择 dag/loop
team_project.plan        写入任务边界、owner、depends_on 和验收标准
team_project.ready       只返回依赖已验收的节点
team_project.accept      验收 submitted result，再解锁下游
team_project.revise      创建新 revision Task，不覆盖旧 Run
team_project.complete    生成项目级结果并按 reply_route 回复
```

Manager 可使用持久 Pi Session 续接对话，但 **Room 不等于 Pi Session**：Room 是长期产品容器，Pi Session 是可重建、可分支、可替换的 Manager 运行时上下文。

### 13.1 AgentTeams Room 模式中应保留的设计

AgentTeams 的 Room 不是“一个 Agent 对话 Session”的别名，而是权限、通知、上下文和任务路由的通信拓扑：

```text
AgentTeams
  ├─ Team Room                 全队共享协调
  ├─ Leader ↔ Admin DM         管理/外部请求
  ├─ Manager ↔ Member Room     成员个人通信
  └─ Project Task Room         按 projectId 创建或复用，任务执行和完成通知
```

其中 `TaskMeta.room_id` 只是内部任务分配 Room；最终结果发给谁由 Project 级 `reply_route` 决定。同一来源 Room 中的两个 Project 不得因 requester 相同而复用同一 Task Room；AgentTeams 使用稳定 `projectId` 作为复用键。

PuddingTeams 是自有 Web/Backend，不需 Matrix 来解决 agent 间通信，不应照搬“每个项目再建物理 Room”的运维成本。保留其语义，改成原生数据模型：

| AgentTeams | PuddingTeams 优化后 | 用户可见性 |
| --- | --- | --- |
| Team Room | `Room(kind=team)`，长期协作容器 | 主页面/主时间线 |
| Project Task Room | `ProjectThread`，按 `project_id` 唯一复用 | Room 内的项目视图 |
| Worker assignment/completion | `TaskThread`，绑定 `task_id` 和 owner | 可在侧栏展开 |
| Leader/Admin DM | `ReplyRoute` + 私有 system event | 只对有权限用户显示 |
| Matrix mention | 结构化 `target_actor_id/audience/requires_response` | UI 使用 @ 选择，后端不靠文本猜 |
| Matrix state/MinIO | Platform DB + Artifact Store | 统一事实源 |

首版不必做 Manager → Team Leader → Worker 三层组织。先做 `Human ↔ Pi Manager ↔ Worker Plugin`，数据模型保留 `parent_member_id` 和 `role=leader|worker` 即可；当一个团队内 Worker 数量和上下文明显增大时，再引入 Team Leader，避免 Manager 微管理每个子 Worker。

### 13.2 PuddingTeams Room 领域模型

Room、Project、Task、Run 必须分层：

```text
Room（长期团队空间）
  ├─ Main Thread（用户与 Manager 对话）
  ├─ N Projects（一次有边界的工作）
  │    └─ 1 Project Thread
  │         └─ N Tasks（一个 owner + 一份可验收输出）
  │              ├─ 1 Task Thread
  │              └─ N TaskRuns（重试/恢复）
  └─ N Members（Human / Manager / Leader / Worker Plugin）
```

最小持久实体：

| Entity | 关键字段 |
| --- | --- |
| Room | `id/name/kind/status/workspace/created_by/sequence` |
| RoomMember | `id/room_id/actor_type/actor_id/role/parent_member_id/status/last_active_at` |
| AgentSessionBinding | `room_id/manager_session_id/generation/last_consumed_sequence/summary_version` |
| Thread | `id/room_id/project_id?/task_id?/kind/visibility/status` |
| Message | `id/room_id/thread_id/actor_id/content/source/target_actor_id/requires_response/sequence` |
| Project | `id/room_id/thread_id/mode/plan_type/status/reply_route_id/requester/acceptance` |
| PlanNode | `project_id/task_id/depends_on/status/order` |
| Task | `id/project_id/thread_id/parent_task_id/assigned_member_id/spec/status/idempotency_key` |
| TaskRun | `id/task_id/attempt/adapter/worker_run_id/status/lease/exit_code/usage` |
| RoomEvent | `id/room_id/thread_id/project_id?/task_id?/run_id?/sequence/type/actor/payload` |
| ReplyRoute | `id/channel/target_room/target_thread/target_user/source_metadata` |
| ModelBinding | `room_id/worker_plugin_id/model_type/model_id/source` |

`Project.reply_route` 是产品路由，不是 Worker 参数。PuddingTeams Web 的默认值可以是：

```json
{
  "channel": "puddingteams",
  "target_room": "<room_id>",
  "target_thread": "<request_thread_id>",
  "target_user": "<requester_id>"
}
```

以后接 Slack/Matrix/钉钉时仅增加 Channel Adapter，项目完成回复仍按当初保存的 `reply_route` 发送，不从当前 Pi Session、最后一条 Message 或 Task Thread 反推。

#### 13.2.1 Room 中的三种工作流

参考 AgentTeams，Manager 先分类，再决定是否创建持久任务状态：

1. **Direct Reply**：普通问答或无需独立 Worker 的小操作，只产生 Message/Event，不创建 Project/Task。
2. **Quick Task**：只需一个 Worker、一份可验收输出。`team_task` 原子创建 quick Project + 单 Task + Thread + Run。
3. **Project Task**：多 Worker、多步骤或需要反复迭代。Manager 选 DAG 或 Loop，指定 owner、依赖和验收标准，只委派 ready nodes。

DAG 适合依赖可预先确定的有限工作；Loop 适合“测试通过为止”、“迭代到质量门槛”和研究探索。Loop 只规划当前轮，评估后再 `continue/replan/ask_user/stop_success/stop_blocked`，不预先膨胀成大 DAG。

#### 13.2.2 Task 提交与 Manager 验收分离

Worker 返回成功不等于项目节点完成：

```text
assigned → running → submitted
                         │
              Manager check result
                         ├─ accept   → accepted/completed → 解锁下游
                         ├─ revise   → 创建新 revision Task
                         └─ blocked  → 问用户或终止 Project
```

Worker 结果统一为 `SUCCESS | SUCCESS_WITH_NOTES | REVISION_NEEDED | BLOCKED | INTERRUPTED`。只有 Manager 验收后的 `SUCCESS/SUCCESS_WITH_NOTES` 可把 PlanNode 变为 `completed`。前端要明确区分“Worker 已提交”和“Manager 已验收”，并展示验收标准、修订说明和 Artifact。

PuddingClaw CLI 返回 `completed` 时，Adapter 对 Platform 产生的应是 `task.submitted`，而不是 `task.accepted`。这样 Manager 可检查 PuddingClaw 分析是否真正回答了任务，也可转人工、重试或更换分析模型。

#### 13.2.3 Room 激活、上下文与防循环

Pi Session JSONL 负责 Manager 模型上下文；Platform 数据库才是 Room/Project/Task/Run 事实源。建议映射为：

```text
Room 1 ── 0..1 active Manager AgentSessionRuntime
Room 1 ── N historical AgentSessionBinding generations
Room 1 ── N Projects / Threads / Events
```

Room 可在 Manager runtime 未加载时存在。激活 Manager 的事件限定为：

- 用户向 Manager 发消息；
- `task.submitted` / `task.blocked` / `run.needs_input`；
- 用户完成 needs-input 选择；
- 明确的 schedule/system action。

同一 Room 的 Manager turn 必须 single-flight，其他触发按 Room sequence 入队，避免两个 Manager turn 同时验收或重复委派。每次激活从 `last_consumed_sequence` 读取持久 Event，并结合 Room summary、当前 Project/Task snapshot 构建确定性上下文。不复制 AgentTeams 仅放内存的“未 @ 消息缓冲区”。

AgentTeams 用 `NO_REPLY` 文本防止 agent 互相回复。PuddingTeams 应用结构化路由代替：

```text
actor_id / actor_type
target_actor_id
audience = user | manager | worker | system
requires_response = true | false
causation_id / correlation_id
```

Worker 进度默认 `requires_response=false`，只有终态、阻塞和 needs-input 才唤醒 Manager。后端还要按 `causation_id + target_actor_id` 去重，不把 Manager 自己发的 UI 广播再投递回 Manager。

`pi.appendEntry()` 或 tool result `details` 可以保存 Room/Project/Task 引用，用于 Pi 分支恢复和调试，但不能作为唯一任务数据库。Session switch/fork/reload 后重新绑定事件，不能继续使用 replacement 前捕获的旧 `pi`、`ctx` 或 `SessionManager` 对象。

### 13.3 事件、前端和恢复

PuddingTeams Web 不复刻 subagent example 的 TUI renderer，而是订阅 Platform WebSocket。事件应表达业务状态，而不只是子进程日志：

```text
message.created
manager.turn_started / manager.delta / manager.turn_finished
project.created / project.planned / project.completed / project.blocked
task.created / task.assigned / task.acknowledged
run.started / run.progress / worker.tool_started / worker.tool_finished
run.needs_input / run.completed / run.failed / run.cancelled
task.submitted / task.accepted / task.revision_requested / task.blocked
artifact.created
```

所有事件用统一 envelope：

```ts
type RoomEvent<T> = {
  id: string;
  room_id: string;
  sequence: number;
  type: string;
  actor: { type: "user" | "manager" | "worker" | "system"; id: string };
  thread_id?: string;
  project_id?: string;
  task_id?: string;
  run_id?: string;
  causation_id?: string;
  correlation_id: string;
  created_at: string;
  payload: T;
};
```

Pi SDK 的 `session.subscribe()` 提供 Manager 的 message/tool/agent streaming；Worker Adapter 提供 Worker events。Backend 先落库并分配 Room 内单调 `sequence`，再发 WebSocket；前端断线后按 sequence 补拉，不把 WebSocket 当事实源。

Room 的“Agent 正在处理”属于 Platform/Channel 活动反馈，不要求 Worker 提供增量内容。参考 AgentTeams，PuddingTeams 采用两层反馈：

- **瞬时活动提示**：Manager 或 Worker 接单后，Room 显示 typing/active 状态；在 `run.started` 后保持，进入终态后关闭；
- **持久占位投影**：主时间线或 Task Thread 创建一条稳定 ID 的“PuddingClaw 正在处理…”消息/状态卡，完成后原位更新为最终结果、`needs_input`、失败或取消，而不是不断追加心跳消息。

占位投影必须绑定 `run_id/task_id/worker_instance_id`。前端刷新或断线重连时从持久 Run/Event 重建；typing 可以丢失，占位状态不能只存在浏览器内存。单纯的存活 heartbeat 不写成 `run.progress`，只有 Worker 确实报告了可验证的业务阶段时才产生 `run.progress`、`worker.tool_started` 或 `worker.tool_finished`。

Room 前端 MVP 建议包含：

- 中间主时间线：用户、Manager 最终回复、重要 Worker 状态；
- 右侧 Team 列表：Worker Plugin/实例、能力、安装/配置/健康、当前任务；
- Project/Task 侧栏：DAG/Loop、owner、depends-on、submitted/accepted 状态；
- Task Thread 抽屉：任务 spec、压缩进度、tool event、Artifact、验收/修订记录；
- `needs_input` 卡片：包括 PuddingClaw 可选分析模型，选择后续跑原 Task；
- 权限控件：取消 Run、暂停 Project、SMART/FULL_ACCESS 状态与审计。

PuddingClaw CLI v0 是同步单 JSON，因此首版只能可靠产生 `task.assigned/run.started/run.completed|failed|needs_input/task.submitted`。其中 `run.started` 由 Platform 在成功 spawn CLI 后产生，运行中动画、typing 和占位消息由 Platform 投影，不需要等待 CLI stdout。以后 PuddingClaw 增加异步或 JSONL event contract，再补真实的工具级实时事件，不阻塞 PuddingTeams Room MVP。

Worker 完成、阻塞或 needs-input 事件必须带 `room_id/project_id/task_id/run_id`。Manager 恢复后使用固定流程：

```text
load task by task_id
  → resolve project from task.project_id
    → inspect submitted result/artifacts
      → accept | revise | block
        → resolve next ready nodes
          → reply through project.reply_route when report is due
            → mark requester report sent（幂等）
```

禁止从“当前打开的 Room”或“当前 Pi Session”猜 Project、Task 或 reply route。

Process Supervisor 必须补齐官方示例没有的恢复机制：

- Quick Task 创建使用 idempotency key，Project/Task/Thread/Run 原子落库；
- Worker 领取使用 lease/heartbeat；
- Platform 重启时把无有效 lease 的 running Run 标记为 orphaned 并按 policy 恢复或失败；
- `task.submitted` 和 `project.report_sent` 消费都必须幂等；
- stdout 按 LF 严格解析，不使用会把 Unicode `U+2028/U+2029` 当分隔符的通用 line reader；
- stdout 只接协议，stderr 只接诊断；
- output/event payload 做大小限制，完整大结果转 Artifact 引用；
- 并发限制按全局、Room、Worker Instance 三层配置；
- cancel 先优雅终止，超时后强制清理进程树，并落最终事件。

### 13.4 安全边界

- Pi extension 拥有宿主机完整 Node 权限，只安装受信任的 PuddingTeams package；
- 默认不加载项目仓库中的任意 `.pi/agents` 作为团队成员，除非 Room 明确信任该项目；
- Worker executable 和参数只能来自已验证 manifest，执行必须 `shell:false`，不得拼接模型生成的 shell command；
- `room_id`、租户、workspace、token 和 approval mode 来自服务端上下文，不能由 LLM tool args 覆盖；
- Worker 能力和分析模型候选必须脱敏；
- SMART/FULL_ACCESS 是具体 Worker 的服务端 policy，`team_task` 不能提升权限；
- Extension `tool_call` gate 可作为 Manager 本地最后一道限制，但跨 Worker 的授权和审计必须由 Orchestrator/Adapter 统一执行。

## 14. 三阶段交付顺序与门禁

### 阶段 1：PuddingClaw Worker 改造

1. 实现 Headless Run API、SMART/FULL_ACCESS 自动交互和稳定 JSON 协议；
2. 实现 PuddingClaw Worker Access Key 后端与前端管理；
3. 实现 Node CLI、manifest、doctor/capabilities/models 和 npm 安装产物；
4. 完成自动安装、本机凭证配置、脱敏和端到端测试。

**门禁**：不依赖 Platform，直接执行 `puddingclaw run --input-json - --json` 必须能在无人值守下进入终态，鉴权、模型选择、取消和自动审批测试通过。

### 阶段 2：独立 Pi Platform 前后端

1. 创建独立 PuddingTeams Web/API 项目，嵌入 Pi SDK；
2. 用 Pi `subagent` example 做 `team_task` 执行适配，复用 tool/spawn/abort/onUpdate；JSONL parser 仅用于声明该 framing 的 Pi/其他 Adapter，PuddingClawAdapter 读取终态单 JSON；
3. 实现 Worker Plugin/Instance Registry、Encrypted Secret Store、Process Supervisor 和 `PuddingClawAdapter`；
4. 实现 Workers/Instance/Models/Pi Playground 前端，以及基于 ExecutionRecord/WebSocket 的“正在处理”、耗时和终态替换；
5. 跑通 Pi 自主选择 PuddingClaw、处理分析模型 `needs_input`、调用 CLI 并生成最终回复。

**门禁**：从独立 Platform UI 完成一次真实 `Pi → PuddingClaw → Pi` 闭环；即使 PuddingClaw CLI 尚无 stdout，UI 也能显示并在重连后恢复 `running`，完成后原位进入终态；凭证不进入模型/日志/前端，timeout/cancel 无遗留进程。此时仍没有 Room/Project/Task 持久调度。

### 阶段 3：Room Pi Manager 调度

1. 实现 Room/Project/Thread/Task/Run/Event/ReplyRoute 数据库和状态机；
2. 实现 Room Activation Queue 和“每个活跃 Room 一个 Manager runtime”；
3. 把阶段 2 `team_task` 升级为 Quick Task 原子链路，实现 `submitted → Manager accepted`；
4. 实现 Room Event API/WebSocket 和 Room/Team/Project/Task Thread 前端，包括 AgentTeams 式 typing/active 提示、持久“处理中”占位投影和终态原位更新；
5. 实现 `team_project` DAG/Loop、revision、依赖解锁、恢复和项目级 reply route；
6. 再评估 Team Leader 层级，最后才考虑远程 Worker、MCP/A2A 兼容和跨节点调度。

**门禁**：Platform 重启或 Pi Session 替换后，仍能通过持久 `task_id/project_id/reply_route` 恢复、验收、继续下游任务并回复正确用户，不从当前 Session 猜测业务状态。

## 15. 可行性与开发难度

结论是**可行，但必须坚持三阶段门禁**。阶段 2 已经是独立 Platform 产品，需要前后端分离服务；阶段 3 才是 Room 调度系统。难点不在 Pi 能否调用 Worker，而在凭证边界、持久状态、异步恢复、验收边界和前端事件投影。

| 部分 | 难度 | 主要风险 |
| --- | --- | --- |
| 阶段 1 Headless/Access Key/Node CLI | 中到高 | HITL 收敛、FULL_ACCESS 边界、凭证泄露、Run 取消清理 |
| Pi `team_task` spike | 低到中 | spawn/abort/onUpdate 与不同 Adapter 的 stdout-json/JSONL framing，官方示例可直接参考 |
| 阶段 2 独立 Platform 闭环 | 中到高 | Pi SDK 嵌入、Registry、Secret Store、PuddingClawAdapter 和前端 streaming |
| Room/Project/Task/Run 后端 | 高 | 事务、幂等、状态机、租约和重启恢复 |
| Pi Manager Room Runtime | 中到高 | Room single-flight、Session 代际、事件重放与上下文压缩 |
| Room 前端 MVP | 中到高 | 流式消息与持久 Event 合并、断线补拉、Task Thread 投影 |
| DAG/Loop + Leader 验收 | 高 | 并发调度、revision、依赖解锁和项目级回复 |

单人全职的粗略工程量级：阶段 1 约 **2–4 周**，阶段 2 可演示独立 Platform 闭环约 **3–5 周**，阶段 3 Quick Task Room MVP 再需 **4–7 周**；完整 DAG/Loop、验收恢复和生产级前端还需继续增量。估算基于单机、单租户、不含远程 Worker 和外部 Channel；不应把 Pi extension spike 的时间当成整个 Platform 的工期。
