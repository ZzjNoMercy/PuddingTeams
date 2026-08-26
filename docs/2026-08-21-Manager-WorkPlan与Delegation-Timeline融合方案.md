# Session Goal 执行计划与 Delegation Timeline 融合方案

> 状态：2026-08-21 已落地。本文同时是领域模型与实现契约；权威聚合位于 `apps/server/src/store/work-state.ts`（v5），Manager core tools 位于 `apps/server/src/pi-bridge/agent-extensions.ts`，恢复/Outbox 调度位于 `apps/server/src/index.ts`，统一抽屉位于 `apps/web/src/components/chat/session-runtime-drawer.tsx`。Driver SPI 仅增加可选幂等透传，不承载 WorkPlan。
>
> 交互原型：`designs/manager-workplan-timeline/index.html`，包含深色/浅色主题、Goal 任务树、DAG 对照视图以及普通聊天不显示 Goal 入口的状态。Figma v1 参考稿：[03 · Recommended · Fusion · 1440×900](https://www.figma.com/design/Xa6bhuUx31oRrOMK0tJ8p2?node-id=6-2)；2026-08-21 的 Goal 融合与依赖图收口以本地原型为准。
>
> 待审增量：真实环境 Verifier、Submission 验证门禁和 Goal 整合复验尚未实现，设计见 `docs/2026-08-26-真实环境复验与可信验收方案.md`。本文下文仍只描述已落地行为。

## 1. 结论

PuddingTeams 不再把 WorkPlan 做成普通 Session 上的独立项目管理对象，而是把它作为 **Session 内某个 Goal 的结构化执行面**。Session 是连贯对话容器，可串行拥有多个 Goal；每个 Goal 有稳定 `goalId`，同一 Session 同时最多一个 `active` Goal，终态 Goal 保留为只读历史。`SessionWorkState` 仍是单个 Goal 的权威状态，`WorkItem` 只表达该 Goal 内 Manager 显性的任务拆解、依赖、提交和验收：

```text
Session
 └─ Goal（SessionWorkState，goalId；最多一个 active，可有多个历史）
     └─ Goal 执行计划（Manager WorkPlan，仅有 Manager 时）
       ├─ WorkItem W1（dependsOn=[]）
       │    ├─ Delegation D1（首次执行）
       │    └─ Delegation D2（revision/followup）
       │          └─ 现有 pi Session 回放或 delegation timeline
       ├─ WorkItem W2（dependsOn=[W1]）
       │    └─ Delegation D3
       └─ WorkItem W3（dependsOn=[W1]）
            └─ Delegation D4
```

这四层回答不同问题：

| 层 | 回答的问题 | 责任主体 |
|---|---|---|
| `SessionWorkState` | 整个 Goal 现在做到哪、还差什么 | Manager / PuddingTeams Goal 控制面 |
| `WorkPlan + WorkItem` | Goal 要经过哪些可验收步骤、依赖和验收状态是什么 | Manager Harness（solo/group Goal） |
| `Delegation` | 某次具体委托交给谁、Run 当前状态和结果是什么 | PuddingTeams Runtime |
| 现有执行过程 | Worker 在这次 Delegation 内做了什么 | pi Session 或 Connector timeline |

Worker 内部 Todo 仍由 Worker 自己管理。PuddingTeams 不读取、不合并、不接管 Worker 私有 Todo；只有 Connector 已经公开为 `WorkerActivity(kind:"todo")` 的事件，才作为某次 Delegation 的只读执行细节展示。

`goalRevision` 只表示同一个 Goal 的契约修订，`execution.epoch` 只隔离同一个 Goal 中断前后的执行世代；两者都不能充当 Goal 身份。Delegation、Decision、Outbox 与前端历史查询必须携带 `goalId`，旧 Goal 的迟到回调即使 `workItemId/epoch` 与新 Goal 相同，也不得写入新 Goal。

### 1.1 Goal 是按需激活，不是 Session/群聊默认状态

创建 Room、进入群聊或 Manager 在场都不自动创建 Goal。Session 初始仍是普通聊天；问候、闲聊、头脑风暴、一次性问答和能在当前回复内完成的轻量请求均不产生 Goal。推荐激活矩阵：

| 场景 | Goal 如何创建 | 是否需要额外确认 |
|---|---|---|
| 用户明确输入 `/goal` 或点击“设为 Goal” | PuddingTeams 直接创建 | 不需要 |
| solo/group Manager 收到目标明确、需要持续执行的任务 | Manager 显式调用常驻 core tool `create_session_goal` | 目标与完成边界清楚时不需要 |
| Manager 判断请求可能需要追踪，但目标或边界含糊 | 先自然语言询问或展示“建议设为 Goal”动作 | 用户确认后才创建 |
| direct Worker 单聊 | 仅用户通过 `/goal`/UI 创建；Worker 可以建议但不能替用户创建 | 需要用户动作 |

因此 `manager_explicit` 表示“Manager 模型作出可审计的 tool call”，不是平台在所有群聊上运行隐藏的关键词触发器。目标 core tool 建议为：

```ts
create_session_goal({
  goal,
  completionCriteria: string[],
  completionReviewMode,
  activationReason,
  criteriaOrigin: "user_input" | "manager_derived",
  sourceMessageIds
})
```

该工具在尚无 Goal 的 solo/group Manager Session 中常驻可用，以 pi `toolCallId` 作为幂等 `operationId`；创建成功后才注入 Goal context、显示头部“目标与执行”按钮，并允许 `update_work_state`、Decision 和 WorkPlan 工具生效。一个清晰的多步骤交付请求可以由 Manager 当轮直接创建，不额外打断用户；“你好”“你是谁”“帮我解释这段话”等不会调用该工具。

Goal 完成条件的权威来源始终是用户意图，不是 Reviewer 的自由生成：

- 当前 `/goal` 实现由用户在创建表单中逐行填写 `completionBoundary`，每个非空行就是一项冻结条件；
- 目标 `manager_explicit` 模式允许 Manager 把用户消息中已经明确表达的结果、约束和完成边界规范化成 `completionCriteria[]`，每个数组元素是一项条件；core tool 在权威 Store 边界按换行落为 `completionBoundary`，避免模型用分号把多项条件误压成一项。必须记录 `criteriaOrigin/sourceMessageIds`，不得补充用户未要求的新质量门槛；
- 如果 Manager 需要作出新的产品判断才能写出条件，属于“目标或边界含糊”，必须先询问用户，不能偷偷代填；
- 用户后续可以显式修改 Goal/完成条件，修改会增加 `goalRevision`，旧版本复核不得应用到新契约。

目标 v5 将来源随 Goal 契约持久化，而不是只留在 toolResult：

```ts
interface GoalContractProvenance {
  criteriaOrigin: "user_input" | "manager_derived";
  sourceMessageIds: string[];
  authoredByAgentId?: "manager";
}
```

目标策略属于 Harness 设置：

```json
{
  "harness": {
    "goalActivation": {
      "solo": "manager_explicit",
      "group": "manager_explicit",
      "direct": "user_explicit",
      "confirmWhenAmbiguous": true
    }
  }
}
```

可选值至少包含 `manager_explicit | user_explicit | disabled`；它只决定谁有权创建，不允许绕过 Goal 创建工具、幂等账本或完成边界校验。

## 2. 为什么不是扩展 Delegation

`Delegation` 是一次运行事实，不是 Manager 的业务计划。把 `dependsOn`、提交和验收直接塞进 Delegation 会产生三个问题：

1. 一项工作可能经历首次执行、补充证据、返修等多次 Delegation，不能让一次 Run 代表整个任务；
2. `Delegation.completed` 只说明 Worker 已结束本次执行，不说明 Manager 已接受交付；
3. `parentDelegationId + handoffKind` 表示执行因果，`dependsOn` 表示业务依赖，二者不是同一张图。

因此固定两类边：

```text
WorkItem.dependsOn       业务 DAG：W1 被验收后，W2/W3 才可开始
Delegation.parent...     执行因果：D2 是 D1 的追问，D3 使用了 D2 的交付
```

`parentDelegationId` 继续只指向同一 Manager Session 中的上游 Delegation；`workItemId` 则把多次执行尝试归入同一个 Manager Todo。

## 3. 领域模型

### 3.1 WorkPlan

一个 manager Session 的活动 Goal 最多有一个 WorkPlan，二者同生共灭；普通 Session 不创建 WorkPlan。solo/group 通过 `/goal` 建立 Goal 后，Manager 可惰性拆成 WorkItem DAG。direct Session 也能建立 Goal，但因没有 Manager 回合，不伪造 Manager Todo：抽屉直接展示 `SessionWorkState` 的 Goal/完成条件与当前 Worker 执行过程，Worker 私有 Todo 仍不上收。

```ts
interface GoalWorkPlan {
  id: string;
  /** Manager 已确认该计划覆盖到哪一版 Goal 契约。 */
  coveredGoalRevision: number;
  needsReconcile: boolean;
  revision: number;
  items: Record<string, WorkItem>;
  createdAt: string;
  updatedAt: string;
}
```

### 3.2 WorkItem

```ts
interface WorkItem {
  id: string;
  title: string;
  description?: string;
  assignedAgentId?: string;
  /** 只能引用同一 WorkPlan 中的 WorkItem；必须是无环 DAG。 */
  dependsOn: string[];
  acceptanceCriteria: string[];
  /** 指向本项服务的冻结 Goal 条件序号或稳定 ID。 */
  sourceGoalCriteria: string[];
  status:
    | "planned"       // 仍被依赖阻塞
    | "ready"         // 所有依赖均 accepted，可开始
    | "in_progress"
    | "waiting_input"
    | "submitted"     // Worker 或 Manager 已形成正式 Submission，等待验收
    | "revision"      // Manager 要求返修，可创建下一次 Delegation
    | "accepted"
    | "blocked"
    | "cancelled";
  delegationIds: string[];
  activeDelegationId?: string;
  submissions: WorkItemSubmission[];
  acceptedSubmissionId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface WorkItemSubmission {
  id: string;
  attempt: number;
  source: "delegation" | "manager";
  delegationId?: string;
  /** Worker 指向 Delegation.result；Manager 指向本会话内联摘要与证据，不复制正文。 */
  resultRef:
    | { kind: "delegation_result"; delegationId: string }
    | { kind: "manager_summary"; evidenceRefs: string[] };
  artifactIds: string[];
  summary?: string;
  submittedAt: string;
  review?: {
    verdict: "accepted" | "revision" | "blocked";
    summary: string;
    evidenceRefs: string[];
    reviewedAt: string;
  };
}
```

`acceptanceCriteria` 属于 Manager 对该 WorkItem 的中间交付验收契约，不是 Worker Todo，也不是新的 Goal 条件。Manager 可以根据冻结 Goal 条件、该步骤的预期产物和下游依赖生成它，但不得借 WorkItem 给 Goal 偷加要求；必要时用 `sourceGoalCriteria`/稳定引用记录它服务于哪些 Goal 条件。WorkItem 进入 `in_progress` 后，如果修改验收条件，必须增加 revision 并留下变更原因；不得静默降低已经提交结果的验收门槛。

### 3.3 Delegation 增量字段

```ts
interface DelegationRecord {
  // 现有字段保持不变
  workPlanId?: string;
  workItemId?: string;
  /** 同一个 WorkItem 中的第几次执行尝试，从 1 开始。 */
  attempt?: number;
}
```

未绑定 WorkItem 的普通委托继续合法；它们出现在抽屉的“未归入计划”分组，不为兼容而伪造 WorkItem。

## 4. 状态机与提交验收

### 4.1 主路径

```text
planned --依赖全部 accepted--> ready
ready --创建绑定 Delegation--> in_progress
ready/revision --Manager 开始自己的 WorkItem--> in_progress
in_progress --Interaction pending--> waiting_input
waiting_input --respond/approve--> in_progress
in_progress --Delegation completed--> submitted
in_progress --Manager 提交内联结果与证据--> submitted
submitted --Manager accept--> accepted
submitted --Manager request revision--> revision
revision --创建新 Delegation--> in_progress
submitted --确认无法继续--> blocked
```

失败和取消保持分层：

- `Delegation.failed/cancelled` 只结束这一次尝试；Manager 可把 WorkItem 置为 `revision` 后换 Worker 重试，也可明确置为 `blocked/cancelled`；
- `Delegation.completed` 自动生成 `WorkItemSubmission` 并把 WorkItem 推进到 `submitted`，**不会**自动 `accepted`；
- `assignedAgentId=manager` 的工作项必须通过 `advance_manager_work_item` 明确记录 `in_progress → submitted`，再走同一个 `review_work_item` 验收门；WorkItem 一旦开始或产生 Submission 就禁止物理删除，只能取消并保留审计事实；
- 只有 `accepted` 才满足下游 `dependsOn`；`submitted`、`completed`、`revision` 都不能解锁后继；
- WorkPlan 全部非取消项 `accepted` 后只代表计划完成，Goal 仍需沿用现有 completion review 门禁才能 `resolved`。
- manager 自审 `resolved` 时必须逐条原样提交全部冻结 Goal 条件、证据引用和 `satisfied` 说明，并追加 `CompletionReview{mode:"manager"}`；权威 Store 的普通 `update` 禁止直接写入 `resolved`，唯一入口是 manager/independent completion review，因此完成后的条件状态不是前端推测。

### 4.1.1 瞬时限流

pi worker 在 AgentSession 内部重试耗尽后若仍收到 429 / RPM / overload，Runtime 不结束 WorkItem，也不要求 Manager 重建 Delegation。Connector 保留同一 `delegationId` 与 `sessionHandle`，优先采用 Provider 返回的 Retry-After（未提供时才使用本地冷却策略）进入可取消等待，再向同一会话发送“从已有进度继续、不要重复已完成工作”的续跑指令。只有冷却续跑次数耗尽后才形成 `Delegation.failed`。这样限流不会重复发送完整任务背景、重复工具调用或制造多个虚假 attempt。

### 4.2 多次尝试示例

```text
W1 调研市场规模
  D1 completed → Submission S1 → Manager: revision（缺来源）
  D2 completed → Submission S2 → Manager: accepted

W2 撰写报告 dependsOn=[W1]
  W1/S1 submitted 时：仍为 planned
  W1/S2 accepted 后：自动 ready
```

验收动作属于 PuddingTeams Harness 控制面，不要求第三方 Worker 适配新的“accept”协议。Worker 只需按现有 Driver SPI 返回 `NormalizedResult`、Artifact 和可选活动事件。

### 4.3 两层验收责任

```text
用户意图 / 用户填写的 Goal 完成条件
  → Manager 拆出 WorkItem 与中间验收条件
  → Worker Submission
  → Manager accept / revision / blocked
  → 全部 WorkItem accepted
  → Manager 提交 Goal 完成申请
  → manager 自审 或隔离 Reviewer 逐项核证
  → 仅主观条件/业务授权无法由证据判断时请求人类确认
```

责任固定如下：

| 层 | 条件由谁确定 | 谁执行验收 | 是否直接完成 Goal |
|---|---|---|---|
| Goal `completionBoundary` | 当前实现由用户逐行输入；目标自动激活只能由 Manager 从明确用户意图中规范化 | `manager` 自审或 `independent` 隔离 Reviewer；`needs_human` 时转人 | 是，但最终状态只由 PuddingTeams 门禁提交 |
| WorkItem `acceptanceCriteria` | Manager 从 Goal 契约和步骤产物派生 | Manager 明确 `accept/revision/blocked` | 否，只解锁依赖 |
| Worker 私有 Todo | Worker | Worker | 否 |

当前独立 Reviewer 并不“生成验收标准”。它生成的是逐项 `status/explanation/evidenceRefs`；criterion 文本必须与冻结 `completionBoundary` 的每个非空行逐字、原序一致，不能合并、拆分、改写或新增。`manager` 自审模式不启动隔离 Reviewer；Manager 在无活动委托、无待回答 Decision、WorkPlan 全部验收且有最终 brief 时，通过 manager completion review 逐项提交证据并完成 Goal，不能用普通状态更新直写 resolved。普通人类不逐项验收所有 WorkItem，只处理创建/修改 Goal 契约、业务取舍，以及 Reviewer 判为 `needs_human` 的主观或授权条件。

## 5. Manager 工具与 Harness 执行路径

目标工具均是 PuddingTeams core tools，不属于 Connector Extension：

```ts
update_work_plan({
  expectedRevision,
  title?,
  upsertItems: [{ id?, title, description?, assignedAgentId?, dependsOn, acceptanceCriteria, sourceGoalCriterionIndexes?: number[] }],
  removeItemIds?: string[],
  reason: string
})

agent_<worker>__delegate({
  task,
  workItemId?,              // 新增可选绑定
  parentDelegationId?,
  handoffKind?,
  ...existingFields
})

review_work_item({
  workItemId,
  expectedRevision,
  verdict: "accepted" | "revision" | "blocked",
  summary,
  evidenceRefs?: string[]
})
```

`sourceGoalCriterionIndexes` 是从 1 开始的结构化序号，只引用 context 中展示的 `{index, criterion}`。Manager 不读写 `goal:<revision>:<ordinal>` 内部 ID，也不能把 `id=文本` 展示串回传；core tool 在当前 `goalId/revision` 下把序号原子映射为持久化的 `sourceGoalCriteria` 稳定引用。

执行链：

```text
Manager 显性规划
  → update_work_plan 校验 revision、引用和 DAG 无环
  → Manager 调 delegate(workItemId=W1)
  → ScopedAgentInvoker / AgentInvoker / Runtime / Driver（现有路径）
  → Runtime 更新 Delegation 状态和完整 NormalizedResult
  → GoalCommandGateway 以 delegation boundary operationId 幂等生成 Submission
  → manager 收到现有 toolResult 投影
  → Manager 调 review_work_item 验收或返修
  → accepted 后 GoalCommandGateway 原子解锁依赖项
```

顺序固定为“先持久化 Runtime 事实，再推进 WorkItem，再生成/恢复 Manager 上下文”。不能先把模型看到的 toolResult 当作权威状态，也不能从自然语言推测 WorkItem 已验收。

## 6. 落盘与事实源

### 6.1 Goal 聚合快照：不再新增 `work-plans.json`

```text
<PUDDINGTEAMS_HOME>/state/work-states.json
```

`WorkStateStore` 以原子改写方式保存多个 `SessionWorkState + DecisionRequest`。`plan` 是单个 Goal 聚合的可选子结构；v5 以 `goalId` 为 `states` 主键，同一 `sessionId` 可以有多个终态 Goal，但最多一个 active Goal。项目未上线，不保留双写或历史兼容层。这既避免 Goal 与 WorkPlan 两个快照之间出现崩溃窗口，也隔离同一 Session 的连续目标。

文件仍是当前状态快照，不是 JSONL。结构示意：

```json
{
  "version": 5,
  "states": {
    "goal-01": {
      "goalId": "goal-01",
      "sessionId": "mgr-s-01",
      "goal": "发布 2026 Agent 产品趋势报告",
      "completionBoundary": "报告、数字和引用经复核可交付",
      "contractProvenance": {
        "criteriaOrigin": "user_input",
        "sourceMessageIds": ["msg-user-01"]
      },
      "goalRevision": 1,
      "status": "active",
      "revision": 12,
      "execution": {
        "epoch": 3,
        "status": "interrupted",
        "interruption": {
          "id": "INT1",
          "kind": "server_restart",
          "fingerprint": "sha256:...",
          "delegationIds": ["D3"],
          "interruptedAt": "2026-08-21T10:35:00.000Z"
        }
      },
      "plan": {
        "id": "WP1",
        "revision": 7,
        "items": {
          "W2": {
            "id": "W2",
            "title": "撰写正式报告",
            "dependsOn": ["W1"],
            "status": "revision",
            "delegationIds": ["D3"],
            "submissions": []
          }
        }
      }
    }
  },
  "decisions": {},
  "operations": {
    "op-resume-01": {
      "goalId": "goal-01",
      "sessionId": "mgr-s-01",
      "epoch": 3,
      "kind": "resume_goal",
      "payloadHash": "sha256:...",
      "status": "committed",
      "resultRevision": 12
    }
  },
  "outbox": {}
}
```

`operations` 是有界幂等账本，`outbox` 是待投影到 Session JSONL/待唤醒 Manager 的持久队列；二者与 Goal 状态在同一次原子改写中提交。账本可按“每个 Session 最近 512 条且不少于 30 天”压缩；仍在 pending 或被 outbox 引用的记录不得清理。

### 6.2 四份事实源如何组合

| 事实源 | 权威内容 | UI 用法 |
|---|---|---|
| `state/work-states.json` | Goal 契约、当前摘要、Goal 内 WorkItem DAG、恢复代次、Decision、幂等账本与 outbox | Goal 摘要、依赖图、验收与恢复状态 |
| `state/delegations.json` | 每次执行尝试、Worker/handle、终态结果 | WorkItem 的尝试列表和结果引用 |
| manager / worker Session JSONL | 模型对话、工具调用/结果；pi worker 会话历史 | 聊天回放与 pi 执行过程 |
| `state/delegation-timelines/<id>.jsonl` | spawn worker 单次委托的现有活动时间线 | 选中某次 Delegation 后实时/历史回放 |

不新增第二套“WorkItem Timeline”文件。WorkItem 的当前状态和 submissions/reviews 在 Goal 聚合快照中；Manager 的工具调用与结果已经进入 Session JSONL。为刷新恢复可追加 `display:false` 的投影，但它不是权威状态，也不能反推 Goal。

## 7. Context 与提示词

Manager 每次模型请求前注入**有界 WorkPlan 摘要**，位置在 Goal WorkState 之后：

```text
Goal 工作上下文
Manager WorkPlan：未完成项、dependsOn、验收状态、activeDelegationId
```

只注入未完成项、最近一次 Submission 摘要和稳定引用；不注入 Worker 私有 Todo、不复制 Delegation Timeline、不复制超长 worker 结果。Manager 要核验详细结果时继续使用 Delegation 结果回读和 Artifact。

Manager 行为约束：

1. 需要两个及以上可验收步骤、存在依赖或需要不同 Worker 时，先显性建立/更新 WorkPlan；
2. 委托时绑定 `workItemId`；返修继续绑定同一 WorkItem，并用 `parentDelegationId + handoffKind` 保留执行因果；
3. Worker completed 后必须核对验收条件，明确 accept/revision/blocked；
4. 不把 Worker 自己的 Todo 当作 WorkPlan 进度；
5. 下游只在依赖项 accepted 后开始。

## 8. 统一抽屉信息架构

### 8.1 顶部入口

Goal Session 的会话头部在 Session 选择器与“更多”之间增加一个 32×32 的 `Goal/Execution` 图标按钮，视觉参考 Codex 的列表按钮，但沿用 PuddingTeams 现有 `home-chat-more` 密度和圆角：

- 默认 tooltip：`目标与执行`；
- 有运行项：青绿色 live dot；
- 有待验收 Submission：琥珀色数字 badge，优先级高于 live dot；
- 抽屉打开时使用 `home-soft` 选中底；
- solo/group/direct 都可通过 `/goal` 成为 Goal Session，成为 Goal 后显示该入口；普通 Session 不常驻显示，避免强迫用户进入项目管理流程；
- direct Goal 展示 Goal、完成条件和本 Worker 执行 Timeline；不展示虚构的 Manager Todo 或从 Worker 内部猜测依赖。

Goal 顶部“当前工作”卡原有“运行详情”和消息中的“执行过程”入口都改为打开同一个抽屉，并预选相应 WorkItem/Delegation，不再叠加两个右侧 Inspector。

### 8.2 抽屉结构

推荐桌面宽度 500px（大于 1440px 时可到 540px），右侧浮层，Chat 主区域保持可见；小于 720px 时全屏：

```text
┌ 目标与执行 ───────── 2/4 已验收 ── × ┐
│ Goal 摘要 / 当前阻塞 / 待验收数       │
│ [全部] [待处理 1] [运行中 1]          │
├ Goal 依赖图                           ┤
│          [✓ W1 调研]                 │
│             │                            │
│        ┌────┴────┐                       │
│   [● W2 写作]   [◷ W3 核验]          │ ← 选中
│        └────┬────┘                       │
│          [○ W4 交付]                 │
├ 选中项详情                              ┤
│ 验收条件 · Submission/验收动作          │
│ 尝试：D3 ▾                              │
│ 现有 Delegation Timeline / pi Session   │
└────────────────────────────────────────┘
```

关键交互：

- 点击 WorkItem：在同一抽屉切换详情，不改变房间或 Session；
- 展开“尝试”选择 D1/D2：调用现有 WorkerProcess Router，pi 走 Session 回放，spawn 走 timeline；
- `submitted`：顶部固定显示“接受 / 要求返修 / 标记阻塞”，必须填写验收摘要；
- WorkItem 必须使用有向连线布局：左/上游指向右/下游，分叉表示可并行，汇合表示多个前置条件；
- 默认不再用“依赖 W1”文字作为主表达；点选节点时高亮它的入边/出边，无障碍描述和 tooltip 才保留上游 ID；
- `planned` 节点及其未满足的入边使用弱化色，不显示虚假百分比；
- 仅当前 Goal `execution.epoch` 内、未绑定 `workItemId` 的 Delegation 放在列表底部折叠组，可查看执行过程但不参与 `2/4`；同一 manager Session 中早于 Goal 或属于旧 epoch 的历史委托不得混入 Goal 抽屉；
- “全部 / 需处理 / 执行中”是 WorkItem 视图筛选，不触发继续或启动；中断控制只在确有运行/等待/复核中的执行时出现，动作语义是中断本轮执行并保留 Goal；
- 时间线展示继续做视觉去重和 token batch 折叠，但不跨 Delegation 合并、不改写事实源。

### 8.3 视觉方向

采用“Calm Ops / 融合视图”作为默认方案：

- 暗色石墨表面、低对比发丝线、PuddingTeams 青色用于当前选择和 live；
- 绿色只表示 accepted，琥珀表示 waiting/submitted，红色仅用于 blocked/failed；
- WorkItem 是主导航，Timeline 是选中项的证据，不把每条 worker event 做成高饱和卡片；
- 状态、Worker 和尝试次数放在紧凑 metadata 行；依赖交给图上连线表达，避免文字噪声；
- 验收操作与 Worker HITL 审批严格分区，避免把“允许执行命令”误解为“接受交付”。

原型同时提供“融合 / 紧凑 / 时间线优先”三个密度视图用于比较，默认提交“融合”。

## 9. API 草案

```text
GET  /api/sessions/:sessionId/work-plan
PUT  /api/sessions/:sessionId/work-plan
POST /api/sessions/:sessionId/work-items/:workItemId/review
GET  /api/sessions/:sessionId/work-plan/summary
GET  /api/sessions/:sessionId/goal/recovery
POST /api/sessions/:sessionId/goal/interrupt
POST /api/sessions/:sessionId/goal/resume
```

所有写接口要求 `Idempotency-Key`；请求体仍带 `expectedRevision`。HTTP 重试使用原 key，用户明确发起一次新操作才生成新 key。Manager core tool 不让模型生成 key，直接用 pi `toolCallId` 作 `operationId`。

现有接口保持：

```text
GET /api/rooms/:roomId/delegation-processes?managerSessionId=
GET /api/delegations/:delegationId/process
GET /api/delegations/:delegationId/process/timeline?afterSeq=
WS  /api/delegations/:delegationId/process/timeline/ws?afterSeq=
```

前端先取 WorkPlan，再按选中 WorkItem 的 `delegationIds` 复用现有详情接口。实时更新阶段可先复用 2.5 秒 WorkPlan summary 轮询和现有 timeline WS；后续再增加 Session 级 WorkPlan WS，不能把高频 timeline 事件复制到 Session 级通道。

## 10. 异常与并发

### 10.1 恢复的语义：恢复 Goal，不伪造原 Run 还活着

Goal 是持久控制面，不是一个长时间内存进程。服务重启、Manager 模型回合中断或 Worker 进程消失后：

1. 保留同一 `sessionId`、Goal 契约、Goal revision、已验收 WorkItem、Decision、Artifact 与历史 Delegation；
2. 崩溃前没有提交的 token/推理不是恢复点；最近一个成功的原子 Goal 操作、toolResult 或 Delegation 边界才是安全点；
3. 现有 `reapOrphanedRuns()` 继续把孤儿 Delegation 转成不可变的 `failed(server_restart)`，不把原 D 改回 running；
4. 每个新的中断边界只增加一次 `execution.epoch`；恢复操作沿用该新 epoch，在同一 WorkItem 下创建新 Delegation 尝试，并用 `resumeOfDelegationId` 或现有 `parentDelegationId + handoffKind:"followup"` 指向旧 D；
5. 旧 epoch 晚到的 Manager tool、Worker 回调或 reviewer 结果只记审计，不得改写当前 Goal。

因此产品文案使用“从上次安全点继续”，不说“恢复原进程”。Driver `respond` 恢复同一暂停 Run 的语义仍与这里分开。

显式“暂停 Goal”本身也是一条幂等命令：原子记录 interruption、提升 epoch、把执行态改成 `interrupted`，并向 outbox 写入当前活动 Delegation 的 cancel 请求。Driver cancel 只能 best-effort；旧 Worker 如果随后完成，其完整结果仍保存在原 Delegation，但由于 epoch 已过期不会自动生成 Submission。恢复时 Manager 可以显式“采纳该迟到结果”或创建新尝试，避免既丢结果又误把暂停后的副作用当成已验收事实。

“恢复 Goal”取得当前 epoch 的 resume lease，把执行态从 `interrupted → recovering → running/waiting_human`，不再次提升 epoch。同一 interruption fingerprint、interrupt operationId 或 resume operationId 的重放都必须返回原结果。

### 10.2 业务状态与执行状态分层

当前 `SessionWorkStatus` 把 `waiting_human` 混进 Goal 生命周期。目标结构直接拆开：

```ts
status: "active" | "resolved" | "cancelled";
execution: {
  epoch: number;
  status: "idle" | "running" | "waiting_human" | "interrupted" | "recovering" | "reviewing";
  interruption?: GoalInterruption;
  resumeLease?: { ownerId: string; token: string; expiresAt: string };
};
```

`goalRevision` 只表示 Goal/完成条件契约变化；`revision` 保护聚合快照；`execution.epoch` 专门 fence 恢复前的旧执行。三者不得合并。

### 10.3 幂等规则

每个可产生状态或副作用的入口统一进入 `GoalCommandGateway`：

```text
operationId + goalId + sessionId + epoch + kind + payloadHash + expectedRevision
```

- 新 `operationId`：先校验 `expectedGoalId === activeGoalId`，再按 `expectedRevision + epoch` 校验后执行，在一次原子写中提交新快照、operation result 和 outbox event；
- 相同 `operationId + payloadHash`：直接返回已记录结果，不增 revision、不再追加 review/Decision/Submission；
- 相同 `operationId` 但 payload 不同：`409 idempotency_conflict`；
- 新 `operationId` 但 goalId/revision/epoch 过期：`409 stale_goal_state`，返回当前快照；
- Manager core tool 以 `toolCallId` 为 operationId；Delegation 终态投影以 `delegation-boundary:<delegationId>:<terminalRevision>` 为 operationId；Decision 回答以 HTTP `Idempotency-Key` 为 operationId；
- 独立复核另用 `review:<sessionId>:<goalRevision>:<evidenceDigest>` 去重，避免服务在 reviewer 返回后、落盘前崩溃导致重复追加。

`expectedRevision` 只防并发覆盖，不能代替幂等键；没有 operation ledger 时，“落盘成功但 HTTP/toolResult 丢失”的重试仍会重复执行。除 `create_goal` 以 Session 为幂等作用域外，所有 Goal 写命令的 ledger 都以 `goalId + operationId` 为作用域：后继 Goal 可合法复用客户端幂等键，旧 Goal 的迟到工具调用、HTTP 请求或 reviewer 结果则只能重放旧结果或被拒绝，不能隐式解析并写入新 active Goal。

### 10.4 Outbox 与唤醒

Goal 变更、Decision 回答、恢复指令和终态投影不能“先写状态，再 best-effort 发 custom message”。状态更新时同步写入 outbox，独立 dispatcher 持续重试：

- Session custom message 携带稳定 `eventId`，`appendCustomMessageIfAbsent(sessionId, eventId)` 保证 JSONL 投影去重；
- 真实 tool call 继续用 `toolCallId` + `appendToolResultIfPending` 收口；
- dispatcher 可在“写入 JSONL 后、标记 delivered 前”崩溃，所以接收端去重是必需，不能只依赖 outbox status；
- `triggerTurn:true` 前取得 Goal resume lease；会话正在 streaming 时保留 pending，等 idle 后再以 `followUp` 唤醒，不降级为 steer。

### 10.5 启动恢复编排

server 启动顺序固定为：

```text
init stores
  → reapOrphanedRuns()
  → GoalRecoveryCoordinator.reconcile()
  → drain Goal outbox
  → 开放 HTTP/WS
```

`reconcile()` 对每个 active Goal 重建结构化检查点：已验收 WorkItem、可复用 Artifact、终态/孤儿 Delegation、pending Decision、未完成 review operation 和 Session JSONL 未收口 tool call。同一 `interruption.fingerprint` 只能使 epoch 增加一次，二次启动必须是空操作。

默认恢复策略为 `safe_auto`：

- solo/group：自动唤醒 Manager 做恢复决策，但不盲目重放 Worker 副作用；
- direct：默认显示“从安全点继续”，由用户确认后用 Worker `continue` 开新执行；
- pending Decision：保持 `waiting_human`，不自动代答；
- 已知只读、无副作用的步骤可按策略自动重试；涉及外部发布、付款、写 API 或不可逆命令时先进入 `waiting_human`。

该策略作为 Harness 设置的子项，而不是 Connector 私有配置：

```json
{
  "harness": {
    "goalRecovery": {
      "mode": "safe_auto",
      "directMode": "manual",
      "resumeLeaseMs": 30000,
      "operationRetentionDays": 30,
      "maxOperationsPerSession": 512
    }
  }
}
```

`mode` 可选 `safe_auto | manual`；`manual` 只完成中断对账和状态展示，不主动唤醒 Manager。服务端必须给租约时长、保留天数和账本条数设置安全上下限，不能允许配置把未投递 outbox 或 pending operation 清掉。

一次完整恢复例子：

```text
W2 / D3 running
  → server restart
  → D3 = failed(server_restart)（历史不改写）
  → Goal epoch 2 → 3，execution = interrupted
  → outbox(eventId=goal-recovery:<session>:3)
  → Manager 在原 Session 收到 followUp，读取已 accepted W1 和 D3 交接目录
  → 创建 D5（W2 attempt=2，parentDelegationId=D3）
  → D5 completed 边界以 delegation-boundary:D5:<rev> 幂等生成 Submission
```

用户双击“恢复”、HTTP 超时后重试或两个 dispatcher 同时处理时，都使用同一 operationId/eventId；最终只有一个 resume lease 和一次 Manager 唤醒生效。

### 10.6 外部副作用的边界

PuddingTeams 可以保证“本地 Goal 状态只应用一次”，但无法在所有第三方 Worker/API 上承诺端到端 exactly-once。Connector 执行上下文应新增可选 `idempotencyKey/operationId`，能透传就透传；不支持时使用如下语义：

- 本地控制面：exactly-once state effect；
- outbox / Session 投影：at-least-once delivery + receiver dedupe；
- 外部副作用：best-effort idempotency，中断后状态不明则标记 `effect_unknown`，先对账再重试。

### 10.7 其他并发约束

- 所有 Goal/WorkItem 写操作同时要求 `operationId + expectedGoalId + expectedRevision`，Goal 内执行边界再要求 epoch；冲突返回 `409` 和当前快照；
- `dependsOn` 拒绝自引用、跨 Plan 引用和环；删除被依赖项前必须先重规划；
- Delegation completed 与 Manager review 并发时，Submission 以 `delegationId` 幂等创建；review 只能指向已存在且未复核的 Submission；
- Manager Session/Window 删除前先取消其全部 running/waiting Delegation，使 pending Interaction 过期并清除私有 provider state；随后删除整个 Goal 聚合（包含 plan/operations/outbox）。历史 Delegation 不再可操作；
- Delegation cancel 与 Interaction respond/cancel 若属于 Goal，HTTP 请求也必须携带 `expectedGoalId` 并校验它仍是该 Session 的 active Goal；旧 Goal 入口只能查看历史；
- 重启后由 `work-states.json + delegations.json + Session JSONL` 的结构化事实恢复，不从自然语言聊天文本猜测；
- Goal revision 变化时 WorkPlan 标记 `needsReconcile:true`，Goal 回到 active 并阻止自动 resolved；Manager 必须显式更新验收条件或确认计划仍覆盖新 Goal。

## 11. 分阶段落地

1. **GoalStore v5**：把 plan 并入按 `goalId` 存储的 `SessionWorkState`，允许同一 Session 串行多个 Goal，拆分业务/执行状态，增加 epoch、operation ledger、outbox 与原子命令网关；
2. **幂等改造**：HTTP `Idempotency-Key`、core toolCallId、Decision 回答、Delegation boundary、Submission/review 去重和 Session JSONL `eventId` 去重；
3. **Recovery Coordinator**：启动扫描、孤儿收割后对账、resume lease、Manager safe-auto 唤醒与 direct 人工恢复；
4. **Manager Harness + WorkItem**：core tools、Goal/WorkPlan context、DAG、Submission/验收和 completion review 幂等化；
5. **统一抽屉**：依赖图、中断/恢复节点、新旧 Delegation 尝试、副作用不明对账入口；
6. **故障注入测试**：在原子写前后、reviewer 返回前后、outbox 投影前后、Worker 副作用后回调前分别 kill 进程。

不要求 Connector/Worker 为 WorkPlan 做额外适配；只有想提供更丰富执行细节的 Connector，才继续按现有 SPI 发送 `WorkerActivity`。

## 12. 验收标准

- solo/group Goal 的 Manager 能显式创建带依赖的 WorkItem DAG；环和跨 Goal 引用被拒绝；
- 一项 WorkItem 能关联多次 Delegation，且 `parentDelegationId` 因果链保持独立可读；
- Delegation completed 后 WorkItem 是 submitted，不会自动 accepted；
- 只有 accepted 解锁下游，Goal resolved 仍需现有 completion review；
- solo/group/direct Goal 都有统一入口；普通 Session 不常驻显示 Goal 控件；direct 不伪造 Manager Todo；
- WorkItem DAG 的分叉、汇合和阻塞边可直接从图上读取，不依赖“依赖 W1”文字才能理解；
- 在 Goal 状态落盘后、HTTP/toolResult 返回前崩溃，用原 operationId 重试不会增加 revision、Decision、Submission 或 review；
- 同一启动中断指纹只增加一次 epoch，两个实例只有一个获得 resume lease；旧 epoch 回调不改当前 Goal；
- 孤儿 Delegation 保留 `failed(server_restart)` 审计记录，恢复在同一 WorkItem 下创建新尝试，已验收上游不重做；
- Decision 答案、Goal resume 和 completion review 在重复请求/重启下只应用一次，outbox 最终会唤醒 Manager；
- 外部副作用结果不明时不自动重放，Goal 进入可见 `effect_unknown/waiting_human` 状态；
- 点击 WorkItem/尝试能复用现有 pi Session 回放或 delegation timeline，实时订阅不丢事件；
- Worker 私有 Todo 不进入 WorkPlan，HITL 审批与交付验收在 UI 上不会混淆；
- 关闭、刷新、重启后，WorkPlan、Submission、验收结论与选中的 Delegation 均能从对应事实源恢复。
