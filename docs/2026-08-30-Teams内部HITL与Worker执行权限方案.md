# Teams 内部 HITL、Worker 能力准入与运行状态闭环方案

> 状态：实施中（Phase 0 状态闭环、Phase 2 准入核心与“换 Worker”动作已落地；默认 gap policy 待后续实现）
>
> 日期：2026-08-30
>
> 关联事实源：
>
> - `docs/2026-08-06-通用-agent-接入-底层与扩展方案.md`
> - `docs/2026-08-05-房间即群聊-产品模型方案.md`
> - `docs/2026-08-14-会话记录格式与Harness消费.md`

## 1. 结论先行

HITL 的产品与安全所有权属于 PuddingTeams，不属于 Worker。

Worker/Connector 只负责诚实暴露执行能力，以及在上游确实支持时把“需要权限/输入”的信号翻译成 PWCP 事件；是否暂停、展示审批、持久化决策、恢复、超时、幂等和审计，全部由 Teams 控制。

当 WorkItem 或 Manager 要求只读，而目标 Worker 无法强制只读时，Runtime 不应直接把 Delegation 封存为 `workspace_policy_blocked`，也不应静默降级为可写执行。正确行为是：

1. Teams 在启动 Worker 前完成执行能力评估；
2. 若存在满足要求的安全路径，自动选择该路径；
3. 若没有无损安全路径，创建 Teams 内部 admission Interaction；
4. Delegation 进入等待策略决策状态，Worker 尚未启动；
5. 用户选择取消、改用其他 Worker，或确认接受能力缺口并继续使用当前 Worker；
6. Teams 记录准入决定后启动 Worker；该决定不修改 Worker 配置，也不向 Worker 授予任何权限；
7. Teams 只能诚实记录“用户允许使用该 Worker”，不能把它描述成“Worker 已获得只读/写入授权”。

安全能力由 Connector 声明、Driver 按实际配置计算、`probe()` 验证；用户只能作出 Teams 准入决定，不能手工把一个未验证 Worker 标记为“保证只读”。

同时必须修复另一条相互独立、但在 UI 上被混为一谈的状态链路：Manager 的 delegate 工具调用是否仍未结束，不等于 Worker 是否正在运行。Delegation Store、Driver Run 与 Manager tool call 是三层状态，前端必须分别投影。停止、异常中断和刷新恢复时，每个已展示的工具调用都必须得到持久化终态，旧 HTTP 历史快照也不得覆盖较新的 WebSocket 失败事件。

## 2. 背景与现有问题

### 2.1 触发案例

Manager 为只读 Git 查询创建了 `read_only_shared` Delegation，目标为 Claude Code。当前 Claude Code Connector：

- 没有声明 `honorsInvocationCwd`；
- 没有声明 Driver 级只读强制能力；
- headless `-p` 没有跨进程 `respond`，`interactionKinds: []`；
- 默认 `permissionMode=bypassPermissions`，不应被解释为只读。

Runtime 在 Driver 启动前以 `workspace_policy_blocked` 封存失败：

```text
Connector 无法强制只读，也不保证 InvocationContext.cwd，不能安全执行
```

拦截副作用是正确的，但把“需要用户作出 Teams 准入决定”投影成普通失败是错误的。它造成：

- 用户只看到技术性失败，不知道有哪些安全选项；
- Manager 无法区分永久失败与可由用户决策解除的 admission gap；
- 同样的能力缺口会被模型反复派活、反复失败；
- Worker 配置页只展示零散的 `permissionMode`、`sandbox`，没有统一的有效权限视图；
- Teams 已有 HITL Store/API/UI，但主要由 Worker `input_required` 触发，平台无法主动使用同一闭环。

当前 Runtime 对另一些 `honorsInvocationCwd=true` 的 Worker 会把无法强制只读的任务自动改成 `isolated_worktree`。这不是安全降级：WorkspaceExecutionCoordinator 只创建 Git worktree、传入 cwd 并在结束后采集/提升变更，没有 OS 级访问控制。该自动降级也必须由本方案移除，改成 admission HITL。

同一轮中还并发执行了 Manager 自己的只读 Bash：

```text
cd /Users/pet/puddingteams && git branch --show-current && git rev-parse --abbrev-ref HEAD
```

该路径不是实际项目路径，因此 Git 返回“不是 git 仓库”。这条 Bash 失败与 Claude Code Delegation 是两个独立工具调用：前者是 Manager 使用了错误 cwd，后者是在约 1ms 内被 Workspace policy 拦截。界面却把未结束的 delegate 工具调用显示成 Worker“执行中”，造成“本地 Bash 失败后才派活”或“Worker 仍在运行”的错误观感。

随后暴露出三项状态闭环缺陷：

- 停止请求没有明确的 `stopping` 反馈，前端未严格检查 HTTP 状态与 `{ aborted }`；
- 中断时未保证所有未闭合工具调用先持久化终态 `toolResult`，刷新后错误卡可能丢失；
- delegate 调用恢复只看 Manager 流是否结束，没有按 `managerToolCallId` 回查 Delegation Store 的真实失败、取消或完成状态。

因此本方案同时处理两条轴：**执行准入/权限 HITL**，以及**运行状态/停止/错误持久化**。前者决定 Worker 能否启动，后者保证系统始终诚实展示已经发生的结果。

### 2.2 第一性原理

“要求 Worker 只读”包含三个不同命题，不能混成一个布尔值：

1. **执行约束**：执行面能否技术上阻止写入；
2. **写前截获**：无法直接阻止时，能否在副作用发生前暂停并报告写入意图；
3. **决策所有权**：谁决定是否升级权限，以及如何持久化、恢复和审计该决定。

Teams 能完全拥有第 3 项；第 1、2 项取决于具体 Connector/上游协议。Teams 的保证不是“第三方 Worker 永远守规矩”，而是：

- 不伪造 Worker 能力；
- 不在能力不足时静默放宽策略；
- 在副作用发生前能够阻断的路径必须阻断；
- 无法无损执行时必须把选择权交给用户；
- 能力缺口的接受或拒绝产生明确、可恢复、可审计的 Teams 准入决策。

### 2.3 产品边界：Teams 是协作控制面

PuddingTeams 的核心职责是让多个异构 Agent 更可靠地协作，而不是成为代码执行容器：

- **Teams**：任务契约、Worker 选择、能力发现、准入/HITL、并发调度、状态对账、停止反馈、产物交接、验收和审计；
- **Worker**：真正执行代码、命令和外部操作，并承担其原生 permission/sandbox 的实现；
- **Connector/Driver**：把 Worker 的真实能力和事件翻译成统一协议，不替 Worker 编造能力，也不把执行责任搬进 Teams。

因此，Teams 只需要知道“该 Worker 能否证明只读、能否上报权限请求、是否遵循 cwd、是否可取消/恢复”，不需要接管 syscall、mount、容器镜像或通用文件访问控制。能力不足时的产品动作是询问用户是否仍使用该 Worker、换 Worker 或取消，而不是在 Teams 内补造一个执行沙箱。

## 3. 范围与非目标

### 3.1 本期范围

- 建立统一 Worker 执行能力与 Teams 准入模型；
- 增加 Teams 主动创建的 admission HITL；
- 将 Workspace admission capability gap 从普通失败改为等待用户决策；
- 在 Worker 管理页展示静态能力、有效能力、探测状态和风险；
- 支持按 Worker/全局配置 admission gap 的默认策略；
- 首批校准 Claude Code、Codex、pi、PuddingClaw 四个 Connector；
- 完整覆盖刷新恢复、并发、幂等、过期、Goal stale fence 和审计；
- 区分 Manager tool call、Delegation 与 Driver Run 三层状态；
- 完成停止反馈、未闭合 toolResult 终态补写和 delegate 刷新回填；
- 防止延迟 HTTP 历史快照覆盖更新的 WebSocket 工具失败事件。

### 3.2 非目标

- 不假装 Teams 可以约束任意恶意本地二进制；
- PuddingTeams 不自研通用 OS/容器沙箱，也不建设 write-root confinement 子系统；强制只读只能复用经验证的 Worker 原生能力或可信远端策略；
- 不通过提示词把“请勿写入”包装成强制沙箱；
- 不让用户手工提升 Connector 的安全能力等级；
- 不在本期为 Claude Code/Codex headless 发明不存在的跨进程 resume 协议；
- 不把事后 diff 观测描述为写前阻断；
- 不为历史数据保留兼容层。项目未上线，结构升级直接替换并提升 Store 版本。

## 4. 核心概念

### 4.1 请求策略与有效能力分离

Workspace 协作策略表达任务预期和工作目录组织方式；`DriverCapabilities` 表达 Worker 能证明什么。Runtime 负责比较二者并产生一个可审计的 admission 结果。

本期不重构 Workspace 策略结构，继续沿用现有 `WorkspaceAccessMode`：

```ts
interface WorkspaceExecutionPolicy {
  mode: "read_only_shared" | "isolated_worktree" | "exclusive_write";
  source: "harness_default" | "manager_derived" | "user";
  reason: string;
  baselineStrategy: "git_tree" | "filesystem_manifest" | "external_snapshot";
  promoteOnAcceptance: boolean;
}
```

只保留产品当前实际需要的三个判断：

- `read_only_shared`：任务不期望产生 Workspace 变更；Worker 能证明只读则直接执行，否则进入 Teams admission；
- `isolated_worktree`：预期产生代码变更，并在独立 Git checkout 中组织和验收；它不是权限沙箱；
- `exclusive_write`：必须直接写目标 Workspace 的串行任务。

PuddingTeams 当前不提供通用 OS 沙箱。它可以调用 Worker 自带的强制能力（例如 Codex `-s read-only`）或可信远端策略，但 Git worktree、cwd、基线和 diff 都不能阻止 Worker 用绝对路径写回原项目。

用户选择“继续使用当前 Worker”时，`mode` 不变，Teams 只记录 `readOnlyAssessment=unverified_user_accepted`。这不是授权 Worker 写入；若任务原本要求不产生变更，实际检测到变更仍应作为契约偏差进入验收。没有真实并发冲突需求前，不再额外引入面向用户的 lease 配置。

Git worktree 是 Git 提供的“同一仓库的另一个工作目录”：它有独立 checkout，Worker 的改动不会直接出现在用户当前 checkout 中，Teams 可以在验收后再提升变更。它适合多 Agent 并行开发，但不是副本沙箱；进程仍可能读取或修改 worktree 之外的路径。

### 4.2 Worker 权限能力

在现有 `DriverWorkspaceCapabilities` 上增加写前截获能力：

```ts
interface DriverWorkspaceCapabilities {
  honorsInvocationCwd: boolean;
  readOnlyEnforcement: "none" | "sandbox" | "remote_policy";
  mutationInterception: "none" | "pre_mutation";
  mutationObservation: Array<
    "event_stream" | "git_diff" | "filesystem_diff"
  >;
}
```

约束：

- `readOnlyEnforcement !== "none"`：Connector 承诺执行面会拒绝写入；
- `honorsInvocationCwd=true` 只表示 Worker 从指定目录启动，不表示它不能用绝对路径、父目录或外部工具写回原 Workspace；
- `mutationInterception === "pre_mutation"`：Connector 承诺任何受控 Workspace 写入都会在发生前产生结构化 permission Interaction，并可由同一 Run 的 `respond` 恢复；
- `interactionKinds` 包含 `permission` 但没有 `pre_mutation`，只能说明“可能产生某类权限问题”，不能证明所有文件写入都会被截获；
- `mutationObservation` 只用于事后审计，不得提升 admission 权限等级；
- 未声明字段按最低能力处理。

### 4.3 能力来源与可信度

前端和 Runtime 使用同一个有效能力对象：

```ts
interface EffectiveExecutionCapabilities {
  connectorId: string;
  transport: DriverTransport;
  configured: DriverWorkspaceCapabilities;
  probed?: DriverWorkspaceCapabilities;
  effective: DriverWorkspaceCapabilities;
  verification: "verified" | "connector_declared" | "unverified";
  capabilityFingerprint: string;
  issues: Array<{
    code: string;
    severity: "info" | "warning" | "blocking";
    message: string;
  }>;
}
```

来源优先级：

1. Connector 包声明理论能力和可配置选项；
2. Driver `capabilities()` 按当前 binding、transport 和配置计算有效能力；
3. `probe()` 校验当前 CLI/API 版本是否支持所声明参数；
4. Runtime 取三者交集，任何不一致按较低能力处理；
5. 能力指纹写入 Delegation，用户决策后、Driver 启动前再次计算，防止配置/版本在审批期间变化。

用户配置只能选择 Connector 已声明的模式。例如 Codex 可选择 `sandbox=read-only`，从而使有效能力成为 `readOnlyEnforcement=sandbox`；用户不能直接勾选“此 Worker 保证只读”。

### 4.4 两类 Teams Interaction

扩展现有 `InteractionRecord`：

```ts
type InteractionSource = "worker" | "platform_policy";

interface InteractionRecord {
  id: string;
  delegationId: string;
  source: InteractionSource;
  kind: "permission" | "question" | "confirmation";
  requests: InteractionRequest[];
  status:
    | "pending" | "responding"
    | "approved" | "rejected"
    | "expired" | "failed";
  revision: number;

  // 仅 source=worker 时存在，指向加密 provider state。
  providerStateRef?: string;

  // 仅 source=platform_policy 时存在，公开但不可由浏览器篡改。
  policyContext?: AdmissionPolicyContext;

  // 人类作出的决定，与决定是否已成功应用分开记录。
  decision?: {
    chosenAction: AdmissionPolicyContext["allowedActions"][number];
    actorId: string;
    actorDisplayName?: string;
    decidedAt: string;
    requestId: string;
  };
  application?: {
    operationId: string;
    status: "pending" | "applying" | "applied" | "failed";
    collaborationPolicy?: WorkspaceCollaborationPolicy;
    readOnlyAssessment?: "verified" | "unverified_user_accepted" | "not_required";
    workspaceExecutionScopeId?: string;
    replacementDelegationId?: string;
    failureCode?: string;
    updatedAt: string;
  };

  consumedRequestId?: string;
  consumedPayloadHash?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

```ts
interface AdmissionPolicyContext {
  reasonCode: "read_only_not_enforceable" | "cwd_not_honored";
  collaborationPolicy: WorkspaceCollaborationPolicy;
  capabilityFingerprint: string;
  effectiveCapabilities: EffectiveExecutionCapabilities;
  allowedActions: Array<
    | "cancel"
    | "proceed_with_worker"
    | "select_another_worker"
  >;
}
```

`platform_policy` Interaction 不创建伪 provider token，不写 `InteractionSecretStore`。浏览器只提交 action；服务端按持久化的 `policyContext` 执行决策，不信任浏览器回传 policy/cwd/agentId。

`decision` 回答“谁在何时选择了什么”，`application` 回答“该 Teams 准入决定是否已落实到 Delegation”。Interaction 进入 `approved/rejected` 不等于启动流程已经应用成功；UI 必须能显示 applying/failed，审计也不能用一个 `approved` 掩盖跨 Store 失败。

## 5. 状态机

### 5.1 Delegation 状态扩展

新增明确状态 `waiting_admission`，不复用 `waiting_input`：

```text
admitted
  │
  ├─ capability 满足 ───────────────────────────────> running
  │
  └─ capability gap ─> waiting_admission
                           │
                           ├─ reject/cancel ─────────> cancelled
                           ├─ 接受能力缺口 ───────────> admitted ─> running
                           └─ 改用其他 Worker ────────> cancelled + replacement Delegation

running ── worker input_required ──> waiting_input ── respond ──> running
```

必须区分：

- `waiting_admission`：Worker 尚未启动，没有 `runHandle`，由 Teams 自己恢复；
- `waiting_input`：Worker Run 已存在且暂停，必须调用 Driver `respond` 恢复同一 Run。

这样启动恢复、取消、超时和 UI 都不会误以为 admission Interaction 有一个可 resume 的上游 Run。

### 5.2 admission 决策规则

请求 `mode=read_only_shared` 时：

1. `readOnlyEnforcement=sandbox|remote_policy`：直接运行；
2. 无强制只读：进入 `waiting_admission`，创建 platform policy Interaction；
3. 不得因为能创建 worktree 而自动放宽为可写；
4. 不得在用户选择前调用 Driver `run/continue`。

即使 Worker 声称会遵循提示词，只要能力模型不能证明第 1 项，仍走第 2 项。`mutationInterception=pre_mutation` 只能说明 Worker 可能在运行中发出权限请求，不能证明这次任务不会产生变更。

Teams 启动前的 admission HITL 只回答“Teams 是否可以在已知能力缺口下使用这个 Worker”。选择继续不会调用 Driver `respond`，不会改变 Worker 的 permission/sandbox，也不会把能力状态改成“已验证只读”。

### 5.3 用户动作语义

#### 取消

- Interaction -> `rejected`；
- Delegation -> `cancelled`；
- 封存平台拒绝原因，不产生 Worker session/run handle；
- Manager 得到明确的取消结果，不自动重试。

#### 继续使用当前 Worker

- Interaction 记录 `chosenAction=proceed_with_worker`、操作者、时间和 capability fingerprint；
- Delegation 的协作策略和 WorkItem 契约保持不变，记录 `readOnlyAssessment=unverified_user_accepted`；
- 不修改 Worker config，不向 Worker 发送“批准写入”，也不调用 Worker `respond`；
- Driver 启动前再次计算 capability fingerprint；任何变化都重新评估；
- Teams 仍按已有 WorkItem 串行门禁避免同一任务的并发碰撞，这只是调度行为，不是 Worker 权限；
- 若运行后检测到 Workspace 变更，按原任务契约记录偏差并进入验收，不能因为用户允许使用该 Worker 就自动视为合规。

#### 改用其他 Worker

- 当前 Delegation 取消；
- 用户选择只来自服务端返回的候选 Worker 列表；
- Runtime 对候选 Worker 重新做 capability assessment；
- 新 Delegation 通过 `parentDelegationId` 或显式 replacement link 记录因果，不能复用旧 Worker 的 session handle。
- replacement 使用稳定 `admission-replacement:<originalDelegationId>` operation identity；Goal 任务必须先以 WorkState CAS 将 active slot 从原 Delegation 原子切换到新 Delegation，Driver 才能启动。Goal epoch、WorkItem revision、房间成员或 Workspace 快照任一变化都 fail closed。
- 新 Delegation 已创建但 Interaction 尚未回填 link 时，启动恢复必须找到**唯一** replacement，并校验其 `replacementAdmissionReady` 持久标记；该标记只会在房间/Workspace/成员复核及 Goal WorkState reservation 全部提交后写入。只看到 child、未看到此标记，或找到多个 child，都必须 fail closed，不能猜成改派成功或重复启动。
- `application` 只允许 `applying → applied | failed` 的单向 CAS；后续 WorkState 投影失败不得把已运行的 replacement 从 `applied` 反写成 `failed`。

Worktree 不属于 admission 动作。它由 WorkItem 的协作策略预先选择：Teams 为同一 Git 仓库创建另一个 checkout，让不同 Worker 的预期代码变更彼此分开，随后再验收和提升。它不改变 Worker 权限，也不能弥补只读能力缺口。

### 5.4 过期、重启与并发

- `waiting_admission` 不计 active Run timeout，但有独立 Interaction TTL；
- 服务重启后从 `interactions.json` 恢复，无需 Worker reattach；
- 同一 Interaction 响应使用现有 requestId + revision + payload hash 幂等规则；
- 审批期间 Agent 配置、Connector 版本、Workspace trust、Goal epoch 或 WorkItem revision 变化，响应返回 409 stale，不启动 Worker；
- capability fingerprint 发生任何变化时旧批准都不再消费，必须重新评估；若新能力已经自动满足原请求，可关闭旧 Interaction 并按新 assessment 启动，但不能把旧批准当作授权依据；
- 房间删除/Workspace 切换会取消 `waiting_admission`；
- 用户批准与另一个用户拒绝并发时，以 Interaction CAS 首个成功写入为准。
- Human 决定、幂等 requestId 和 `application=applying|applied` 必须在同一次 Interaction CAS 中落盘；若旧数据或崩溃窗口出现 `approved` 但缺 application，启动对账必须 fail-closed 取消 pre-start Delegation，绝不猜测或重复启动 Worker。

### 5.5 运行状态、停止与错误持久化

#### 三层状态不得互相冒充

系统分别维护并展示：

1. **Manager tool call**：`pending | completed | failed | aborted`，表示 Manager 的工具协议是否已经闭合；
2. **Delegation**：包括 `waiting_admission | running | waiting_input | completed | failed | cancelled`，以 Delegation Store 为事实源；
3. **Driver Run**：是否真正创建进程/远端 Run，以及是否仍可 abort/reattach。

delegate 工具仍 pending 时，如果对应 Delegation 已 `failed`，Worker 卡必须立即显示失败；不得用工具调用的 pending 状态推断 Worker“执行中”。反过来，`waiting_admission` 虽然 Delegation 未终结，也必须显示“等待用户决定，Worker 尚未启动”。

#### delegate 工具终态补写

每个 delegate 工具调用创建时持久化：

```ts
{
  managerSessionId: string;
  managerToolCallId: string;
  delegationId: string;
}
```

正常结束、快速失败、用户停止、Manager 流异常和服务恢复都走同一个 settlement 函数：

1. 按 `managerSessionId + managerToolCallId` 定位唯一 delegate 调用；
2. 按 `delegationId` 读取 Delegation Store 权威终态；
3. 仅对仍 pending 的调用写入一次终态 `toolResult`；
4. 先完成 store/session JSONL 持久化，再广播 WebSocket 终态；
5. 使用 CAS/幂等键防止 abort、Driver end 和恢复扫描重复补写。

服务启动和会话刷新时，对未闭合 delegate 调用执行恢复扫描。若 Delegation 已经失败、取消或完成，立即回填真实结果；若 Delegation 仍运行，只恢复运行投影，不伪造完成。远端 Worker 丢失观测且无法证明已结束时记录 `observation_lost`，不得伪造 `cancelled` 或 `completed`。

#### 停止反馈

前端停止状态机：

```text
running -> stopping -> stopped
                  \-> stop_failed -> running/needs_attention
```

- 点击停止后立即进入 `stopping`，禁用重复点击但保留状态说明；
- 只有 HTTP 2xx 且响应 `{ aborted: true }` 才显示停止成功；
- 非 2xx、网络错误、解析错误或 `{ aborted: false }` 都必须显示可重试错误；
- 后端停止接口幂等：已终止可返回 `aborted: true, alreadySettled: true`；找不到精确目标不得用成功掩盖；
- 停止成功前，后端先驱动 Driver abort/记录观测丢失，再补齐所有未闭合工具终态，最后发布 Manager/房间边界事件；
- Driver/Manager abort 必须有服务端截止时间，且不能在 Session JSONL repair mutex 内无界等待；超时返回可见失败并以 effect-unknown 终态修复未闭合工具，`GET /messages` 不得被停止请求一起锁死；
- `waiting_admission` 的停止只取消 Interaction 与 Delegation，不调用不存在的 Driver Run。

#### HTTP/WS 顺序栅栏

刷新恢复不能只保护 `running`。消息历史和活动状态分别维护单调 revision；`tool_execution_end`、Interaction 终态、Delegation 终态等会改变消息的 WebSocket 事件必须推进 message revision。延迟返回的 HTTP 快照只有在 revision 不旧于当前客户端状态时才能整体落地，否则应丢弃或按事件序列合并。

这样可以覆盖关键竞态：HTTP 先读取旧历史，随后 WebSocket 收到失败卡，最后旧 HTTP 返回；失败卡不得再次消失。

### 5.6 Goal/WorkItem 与进程投影

`waiting_admission` 必须贯穿所有 Harness 门禁，不能只存在于 Delegation Store：

- `WorkItemStatus` 新增 `waiting_admission`，保留 `activeDelegationId`；
- Goal `execution.status` 投影为 `waiting_human`；
- Goal 完成门禁、同 WorkItem 串行门禁和 active delegation 查询都把它视为活动委托；
- Worker 进程列表将它标记为 `workerStarted=false`，不计入 live Worker/进程数；
- 启动对账和 reaper 不得把它当成丢失 Run，因为本来就没有 Driver handle；
- Manager session stop、房间删除、Workspace 切换、Goal interrupt 和 Interaction TTL 都必须取消 Interaction 与 Delegation，并清除 WorkItem active gate；
- pre-start 取消/过期产生 `workerStarted=false` 的封存 Receipt，明确没有 Worker 输出、变更集或 Run handle，不伪造 Driver 结果。

### 5.7 admission 跨 Store 崩溃一致性

Interaction、Delegation、WorkState 与 WorkspaceExecution 当前是独立持久化边界，不能依赖一次内存调用跨四个 Store 原子成功。新增 write-ahead `AdmissionOperationRecord`，以稳定 `operationId` 驱动所有幂等写入：

```ts
interface AdmissionOperationRecord {
  id: string;
  interactionId: string;
  sourceDelegationId: string;
  chosenAction: string;
  capabilityFingerprint: string;
  phase:
    | "decision_recorded"
    | "scope_acquired"
    | "driver_starting"
    | "driver_started"
    | "settled"
    | "failed";
  replacementDelegationId?: string;
  workspaceExecutionScopeId?: string;
  driverRunHandle?: string;
  revision: number;
  updatedAt: string;
}
```

恢复矩阵：

| 最后持久化阶段 | 重启动作 |
| --- | --- |
| `decision_recorded` | 用同一 operationId 重放 Teams 准入决定 |
| `scope_acquired` | 重新校验 fingerprint 与 stale fence 后进入启动边界 |
| `driver_starting`，可按 operationId reattach/probe | 绑定既有 Run，不重复启动 |
| `driver_starting`，无法证明是否已启动 | 标记 `observation_lost/needs_attention`，不得自动再启动 |
| `driver_started` | 按 Driver 恢复协议继续观测 |
| `settled/failed` | 只重放 UI/Manager 投影，不再产生副作用 |

调用 Driver 前必须先持久化 `driver_starting`，并把稳定 operationId 传给支持幂等启动的 Driver。没有 idempotent start/reattach 能力的 Connector 在不确定窗口内宁可需要人工处理，也不能冒险重复启动。每个阶段提供故障注入测试。

## 6. Teams 内部 HITL 响应分发

当前 `/api/interactions/:id/responses` 最终统一调用 Driver `respond`。改造后必须先按 Interaction source 分发：

```ts
async function respondInteraction(id, response, ctx) {
  const interaction = await store.getInteraction(id);

  if (interaction.source === "platform_policy") {
    return admissionPolicyBroker.respond(interaction, response, ctx);
  }

  return workerInteractionBroker.respond(interaction, response, ctx);
}
```

边界要求：

- API、幂等、窗口归属、Goal stale 校验继续复用；
- `platform_policy` 永远不调用 Driver `respond`；
- `worker` Interaction 继续恢复同一 `runHandle`；
- Worker Interaction 只能在现有执行契约内 approve/reject；如果请求超出 WorkItem 契约，Teams 不借 admission HITL 改写契约，而是拒绝/终止该 Run，后续由用户另行修改任务；
- 两类 Interaction 使用同一审批卡和刷新恢复通道，但显示不同来源与后果；
- 浏览器不接触 provider state、owner token、capability raw config 或绝对执行根。

## 7. Manager 行为

### 7.1 Manager 不负责猜能力

Manager 只声明任务预期，例如“该 WorkItem 不应修改目标 Workspace”，以及是否需要 worktree 等协作设置。Worker 能否证明该预期、是否需要 HITL，由 Runtime 决定。

系统提示应明确：

- `needs_input`/`waiting_admission` 都不是普通失败；
- 不得看到 admission Interaction 后改用自然语言绕过门禁；
- 不得在用户未决定前重复派发同一 WorkItem；
- 用户拒绝后应报告结果或选择其他合法 Worker，不应暗中放宽策略。

### 7.2 manager toolResult

进入 `waiting_admission` 后，delegate 工具必须在 Interaction 与 Delegation 持久化成功后，立即以一条结构化 `needs_input` toolResult 闭合，包含 Interaction id、原因摘要和可选动作，但不把策略选择交给模型代答；不得让原工具调用跨越人类等待窗口。审批完成后：

- 若原契约仍成立且启动同一 Delegation：后续结果通过 `pudding:task_result`/follow-up 投影；
- 若改用其他 Worker：创建 replacement Delegation，并使用新的 `managerToolCallId`（若存在新的 Manager 工具调用），绝不复用旧 call id；
- 若取消或替换 Worker：投影明确终态，防止 Manager 把它当作仍在运行。
- replacement 没有新的 Manager tool call，因此最终结果必须写入幂等 outbox/custom projection（`replacement-result:<delegationId>:<revision>`）；正常完成、发送失败和启动恢复共用同一 event id。

同一 `managerToolCallId` 永远只有一条 toolResult；审批后的结果不能再给旧 call id 写第二条。若 crash/abort 发生在 `waiting_admission` 已持久化、`needs_input` toolResult 尚未落盘之间，刷新/启动恢复按 `managerSessionId + managerToolCallId + toolName=delegate` 从 DelegationStore + InteractionStore 回填唯一的 `needs_input`，不得错误补成 `interrupted`。不得让 manager tool call 因等待人类数小时而占用模型流或 HTTP 请求。

## 8. Worker 管理前端

### 8.1 “执行能力与风险”统一视图

Worker 详情页“基础接入”增加只读的执行权限卡：

| 字段 | 示例 |
| --- | --- |
| 工作目录遵循 | 已验证 / Connector 声明 / 不支持 |
| 强制只读 | Codex sandbox / 远端策略 / 不支持 |
| 执行位置 | 目标 Workspace / Git worktree（协作隔离） |
| 写前权限反馈 | 可暂停并恢复 / 仅普通 permission / 不支持 |
| Teams 启动前 HITL | 支持（平台能力） |
| 变更观测 | Git diff、文件系统 diff、事件流、无 |
| 当前风险 | 低 / 只读未验证 / 运行前需确认 / 不允许执行 |
| 能力来源 | Connector 版本、上游版本、最近 probe 时间 |

配置值与有效能力分开展示。例如：

- Claude `permissionMode=bypassPermissions`：显示“无运行中 HITL，高风险”；
- Claude `permissionMode=plan`：只能按 Connector 真实保证展示，不能自动推断为强制文件只读；
- Codex `sandbox=read-only`：Driver 动态声明 `readOnlyEnforcement=sandbox`；
- PuddingClaw：显示“支持 permission Interaction”，但在补充 `pre_mutation` 契约前仍不能显示“所有写入均写前截获”；
- pi：显示“权限在 child session 内部处理，当前不上抛 Teams”。

### 8.2 用户可配置的策略

用户配置的是 Teams 行为，不是 Worker 能力：

```ts
type CapabilityGapPolicy =
  | "ask"                 // 默认：创建 admission HITL
  | "deny";               // 直接拒绝，不启动 Worker
```

支持全局默认和 Worker 级收紧覆盖：

- Worker 覆盖可以从 `ask` 收紧为 `deny`；
- 不允许从组织级 `deny` 放宽为自动继续；
- 不提供“信任此 Worker 为只读”的开关；
- “继续使用当前 Worker”只对具体 Delegation 生效，不保存为永久信任，也不改变 Worker 能力标记。

### 8.3 房间审批卡

admission 审批卡必须直接回答四件事：

1. 原任务要求什么权限；
2. 当前 Worker 缺少什么能力；
3. Worker 是否已经启动（这里必须是“尚未启动”）；
4. 每个动作会让 Teams 接下来做什么。

示例：

```text
Claude Code 无法证明此次执行保持只读，且当前 headless 模式不能把写入请求上报给 Teams。

Worker 尚未启动。

[取消] [仍然使用这个 Worker] [选择其他 Worker]
```

刷新页面后卡片从 InteractionStore 恢复，不能依赖一次性 toast。若读取到 `application.status="applying"`，前端必须短轮询同一 Interaction 直到 `applied/failed`，不能一次 GET 后永久显示“处理中”。

## 9. Connector 首批校准

### 9.1 Codex

- `capabilities()` 必须按 binding 的实际 `sandbox` 动态返回：
  - `read-only` -> `readOnlyEnforcement=sandbox`；
  - `workspace-write|danger-full-access` -> `none`；
- 保留 `honorsInvocationCwd=true`；
- headless 仍为 `interactionKinds=[]`，不伪造运行中 HITL；
- `probe()` 校验当前 Codex 版本支持 `-s read-only`。

### 9.2 Claude Code

- 明确声明 `honorsInvocationCwd` 的真实语义；若 `cwd` 只是启动目录但不是访问边界，UI 必须说明；
- `bypassPermissions` 显示高风险；
- `plan/default/acceptEdits` 分别按上游真实行为计算能力，不能只按名字推断；
- 当前 headless 无跨进程 resume，保持 `interactionKinds=[]`；
- 无强制只读时进入 Teams admission HITL；worktree 不影响该判断。

### 9.3 PuddingClaw

- 保留 `interactionKinds=["permission"]` 和 `respond`；
- 只有上游协议能证明所有 Workspace 写入在副作用前产生 permission request 时，才声明 `mutationInterception=pre_mutation`；
- 未达到该契约前按 `none`，由 Teams admission HITL 决定是否仍使用该 Worker；
- spawn/http 两个 transport 分别 probe，不能用一个 transport 的能力替代另一个。

### 9.4 pi Worker

- 当前 child pi 权限在内部消化，不上抛 Teams，保持 `interactionKinds=[]`；
- 不把内部可能出现的确认 UI 算作 Teams HITL；
- 未来若实现 child Session permission bridge，再新增 `pre_mutation` fixture 和端到端测试。

## 10. API 与数据结构改动

### 10.1 Store 版本

- `delegations.json`：ExecutionState 增加 `waiting_admission`，其余新增字段均为 v2 内的加法扩展；保持现有 store v2，不能仅因增加可选字段而要求用户删除已有运行数据；
- `interactions.json`：增加 `source`、可选 `policyContext`、可选 `providerStateRef`，直接提升版本；
- Delegation 增加 capability snapshot/fingerprint、admission Interaction id、用户决策摘要；
- 新增 admission operation journal，记录跨 Store 应用阶段与稳定 operationId；
- WorkItemStatus 增加 `waiting_admission`，ExecutionReceipt 增加 `workerStarted` 以诚实表达 pre-start 终态；
- 不做旧版兼容读取。

### 10.2 建议 API

```text
GET  /api/agents/:agentId/execution-capabilities
POST /api/agents/:agentId/connector/probe

GET  /api/interactions?windowId=&sessionId=
GET  /api/interactions/:id
POST /api/interactions/:id/responses
POST /api/interactions/:id/cancel
```

继续复用现有 Interaction 路由，不另建 `/approvals`。响应投影增加：

```ts
{
  source: "worker" | "platform_policy";
  policySummary?: {
    reasonCode: string;
    workspaceMode: WorkspaceExecutionPolicy["mode"];
    allowedActions: string[];
    workerStarted: boolean;
  };
}
```

Worker 有效能力接口只返回安全摘要和来源，不返回 secret、完整 env、owner token 或不必要的绝对路径。

## 11. 安全不变量

1. capability gap 尚未得到 Teams 准入决定前，不得启动对应 Driver；
2. 用户不能通过前端 payload 提升有效能力；
3. 只有 Worker/远端执行面强制只读时，UI 才能显示“已验证只读”；Teams admission 决定不得提升该能力等级；
4. `mode=isolated_worktree` 只是协作与变更组织，不是安全沙箱；
5. `proceed_with_worker` 只允许 Teams 启动该 Worker，不改变 Worker 权限，也不改变 WorkItem 的变更预期；
6. 事后 diff 永远不等价于写前阻断；
7. admission approval 只对一个 Delegation/operationId/capability fingerprint 生效；
8. 配置、版本、Workspace trust 或 Goal contract 变化后旧审批失效；
9. 若用户另行修改 Goal/WorkItem 的变更预期，必须走正常 revision/contract hash 更新，不能由 admission Interaction 暗中修改；
10. `platform_policy` Interaction 不得创建或读取 Worker provider secret；
11. `worker` Interaction 在原契约内必须恢复原 Run，不得自然语言重试；超出契约的请求不能由 admission Interaction 代为批准；
12. 所有拒绝、过期和替换动作必须产生可解释终态，不能留下 running 幽灵；
13. 第三方 Connector 声明的能力必须经 probe/版本约束交叉检查，无法验证时降级；
14. UI 中的“已验证”“Connector 声明”“未验证”必须视觉可区分。

## 12. 实施分期

### Phase 0：先封闭运行状态与停止链路

- `apps/server/src/pi-bridge/session-store.ts`：统一 abort 后未闭合 toolResult settlement，并保证先持久化、后广播；
- `apps/server/src/agent-runtime/invoker.ts`：按 `managerSessionId + managerToolCallId + delegationId` 对齐 delegate 工具与真实 Delegation 终态；
- `apps/server/src/agent-runtime/runtime.ts`：区分已确认本地退出与远端 `observation_lost`，不伪造取消；
- `apps/server/src/routes/chat.ts`、`apps/web/src/lib/api.ts`：严格执行 HTTP 状态与 `{ aborted }` 契约；
- `apps/web/src/hooks/useChat.ts`：增加 `stopping`/失败反馈，并为消息历史增加独立 revision 栅栏，防止旧 HTTP 覆盖新 WS 工具终态；
- 启动恢复扫描补齐已终结 Delegation 对应的 pending delegate toolResult。

验收：快速失败的 Claude Delegation 不再显示为 Worker 运行中；停止失败可见且可重试；刷新、服务重启以及 HTTP/WS 乱序后，失败卡与真实终态不丢失。

### Phase 1：能力模型与只读展示

- 保持现有 Workspace policy 结构，只补齐 Worker 能力声明和展示；
- 扩展 PWCP `DriverWorkspaceCapabilities`；
- 增加 capability fingerprint 与有效能力聚合器；
- 校准四个第一方 Connector；
- 增加 Worker“执行权限”只读卡；
- 暂不改变 Runtime admission 行为，但把能力缺口解释清楚。

验收：同一 Worker 修改配置或 transport 后，有效能力和风险实时变化；用户无法手工提升能力。

### Phase 2：Teams admission HITL

- Interaction 增加 `source=platform_policy`；
- Delegation 增加 `waiting_admission`；
- 新增 AdmissionPolicyBroker；
- Interaction response 按 source 分发；
- 增加 admission operation journal 与跨 Store 启动对账；
- 将 `waiting_admission` 投影到 WorkItem、Goal active gate、worker-process、取消和 reaper；
- `workspace_policy_blocked` 的 capability gap 改为创建 Interaction；
- Worker 启动前做二次 capability fingerprint 校验。

验收：Claude Code 收到只读任务且无安全路径时不启动进程，房间出现可恢复审批卡。

### Phase 3：准入动作

- 接入继续使用当前 Worker、换 Worker和取消；候选 Worker 由服务端按当前能力缺口筛选；
- 准入决定不修改 Goal/WorkItem 契约；另行修改任务预期仍走正常 revision/contract 流程；
- Manager follow-up 与旧 Delegation 终态闭环；
- 增加全局/Worker capability gap policy。

验收：每种用户动作都有唯一、可审计的 Delegation/WorkItem 结果，不存在“审批后仍显示只读”的分叉。

### Phase 4：Connector 写前 HITL

- 为真正支持写前截获的 Connector 增加 PWCP fixture；
- 验证多 request、reject、once/run scope、超时与重启；
- 只有 fixture 和真实 probe 均通过后才能声明 `pre_mutation`；
- `pre_mutation` 只表示 Worker 原生运行中权限交互，不提升 Teams 的只读评估或 worktree 执行模式；
- Worker 请求超出 WorkItem 契约的操作时，Teams 不自行改写契约，必须终止/拒绝并让用户另行修改任务定义。

验收：Worker 准备写入时，副作用尚未发生；用户拒绝后原 Run 按协议继续或进入明确终态。

## 13. 测试计划

### 13.1 能力解析

- Codex `read-only/workspace-write/danger-full-access` 产生不同 effective capability；
- Claude 不因 `permissionMode` 名字被错误提升为强制只读；
- probe 与配置冲突时按较低能力处理；
- 用户 payload 不能覆盖 capability；
- capability fingerprint 对配置、transport、Connector/upstream version 变化敏感；
- `honorsInvocationCwd=true` 时，worktree 也只能显示为协作隔离，不能显示为写边界；
- `pre_mutation` Connector 收到 `mode=read_only_shared` 时，若无强制只读仍进入 platform admission；

### 13.2 admission HITL

- capability gap 创建一条 platform Interaction，不启动 Driver；
- 页面刷新、服务重启后 Interaction 仍 pending；
- approve/reject 幂等；同 requestId 不同 payload 返回冲突；
- TTL 过期后不能启动 Worker；
- 两个用户并发响应只有一个 CAS 成功；
- 审批期间 capability fingerprint 改变后旧批准不再消费；
- 删除房间/切换 Workspace 会取消 pending admission；
- `waiting_admission` 阻止 Goal 自动完成和同 WorkItem 再次派发，但不显示 live Worker；
- Manager session stop 与单独取消 admission 都封存 `workerStarted=false` Receipt，且不会调用 Driver abort；
- `decision_recorded/scope_acquired/driver_starting/driver_started` 每个阶段注入崩溃后，恢复只应用缺失步骤；
- `driver_starting` 无法确认是否已启动时进入 needs_attention，不重复启动；
- `proceed_with_worker` 前后 Worker binding/config 完全不变，且不调用 Driver `respond`；
- `proceed_with_worker` 不改变 Workspace mode、WorkItem revision 或 contract hash；
- 原契约为 `no_changes` 时，运行后发现变更仍记录为契约偏差；

### 13.3 准入与协作动作

- WorkItem 选择 `isolated_worktree` 时，从独立 checkout 启动并显示“协作隔离，非沙箱”；
- admission 卡不把 worktree 列为权限替代方案；
- 不遵循 cwd 的 Worker 不能使用 `isolated_worktree`；
- 用户接受只读能力缺口后仍显示“只读未验证（用户允许使用）”，不得显示“已授权写入”；
- 换 Worker 不复用旧 sessionHandle；
- 接受 capability gap 不改变 WorkItem revision；改用其他 Worker 才创建 replacement Delegation。

### 13.4 Worker-originated HITL

- `pre_mutation` request 在文件变化前到达；
- reject 后 diff 仍为空；
- approve once 不能扩散为 run/session；
- 浏览器断开不自动批准；
- Worker 无 `respond` 时不得声明 `pre_mutation`。

### 13.5 回归

- 普通 Worker `input_required/respond` 仍恢复同一 Run；
- `workspace_policy_blocked` 的非 capability 原因仍可保持 blocked；
- Manager 同时启动 Bash 与 delegate，Bash 先失败、delegate 快速失败时，两张工具卡分别闭合且不串绑；
- 并行工具 A 已失败、工具 B 的 delegate 仍运行时立即停止，再刷新并重启服务：每个 callId 恰有一条 toolResult，A 的原始错误不丢，B 得到诚实终态；
- Delegation 已先进入 terminal、delegate `tool_execution_end` 尚未落盘时，按 `managerToolCallId` 回填唯一真实结果；
- `waiting_admission` 已落盘、`needs_input` toolResult 未落盘时，恢复为 needs_input 而不是 interrupted；
- replacement Delegation 不复用旧 `managerToolCallId`，旧调用也不会收到第二条结果；
- HTTP 旧历史在 WS `tool_execution_end` 之后返回时，不得覆盖失败卡；
- 停止按钮覆盖 `stopping`、防重入、HTTP 非 2xx、`{ aborted:false }`、网络错误和超时，失败均可见且不得显示已停止；
- pending admission 分别覆盖刷新、服务重启、TTL、单独取消、Manager-session stop，均不调用不存在的 Worker Run；
- stop/refresh/toolResult 修复不受 `waiting_admission` 影响；
- Manager 不会把 pending admission 标为 worker running；
- Session JSONL、DelegationStore、InteractionStore 三者刷新后状态一致。

## 14. 文档同步要求

实现行为时必须同步：

- `docs/2026-08-06-通用-agent-接入-底层与扩展方案.md`：Driver capability、状态机、HITL source、Connector 校准；
- `docs/2026-08-14-会话记录格式与Harness消费.md`：Interaction/Delegation 结构、审批投影和 Session custom message；
- `docs/2026-08-05-房间即群聊-产品模型方案.md`：房间审批卡与 Worker 配置页；
- `extensions/README.md` 与 Connector 作者指南：能力声明、probe 和 fixture 要求。

运行状态闭环若改变 Session JSONL 的终态事件、`details` 字段或 revision，也必须同步 `docs/2026-08-14-会话记录格式与Harness消费.md`；不得把只存在于内存/WebSocket 的状态当作刷新恢复事实源。

若复用现有 `pudding:interaction_required`，需扩展并记录其 `details.source/policySummary` schema；若新增 customType，必须先同步会话格式文档，不能只改前端。

## 15. 待评审决策

1. capability gap policy 是否允许 Worker 级覆盖全局策略；建议只允许收紧；
2. admission Interaction 默认 TTL；建议 24 小时，并随房间/Workspace 生命周期提前失效；
3. Codex `sandbox=read-only` 是否作为发行默认；建议新建 Codex Worker 默认 read-only，写任务选择相应 Worker/binding 配置，而不是由 Teams admission 修改 Codex 权限；
4. Claude Code 默认 `permissionMode=bypassPermissions` 是否保留；建议改为更保守配置，并在无法提供 Teams 运行中 HITL 时始终显示高风险提示。

## 16. 完成定义

本方案完成不是“错误文案更友好”，而是满足以下可观察结果：

- Manager 本地工具失败、Delegation 快速失败和 Worker Run 状态可分别解释，不再互相冒充；
- 点击停止立即有 `stopping` 反馈，成功与失败严格按后端确认展示；
- 中断、刷新、重启和 HTTP/WS 乱序后，工具失败结果仍能从持久化事实源恢复；
- Manager 要求只读、Worker 无法保证时，不启动 Worker、不封存普通失败，而是出现 Teams admission HITL；
- 用户能看懂能力缺口和每个选择的执行后果；
- 用户拒绝、继续使用当前 Worker 或换 Worker 都形成唯一可恢复状态；
- Worker 管理页展示的是运行时有效能力，不是用户自报标签；
- Teams 准入授权不会伪装成 Worker 权限，也不会改写 Goal 冻结契约；
- 刷新、重启、并发响应和配置漂移后，Teams 仍能诚实回答“谁批准了什么、哪个 Worker 是否已经启动、实际按什么边界执行”。
