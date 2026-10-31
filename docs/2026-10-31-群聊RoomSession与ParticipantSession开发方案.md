# 群聊 RoomSession 与 ParticipantSession 开发方案

> 日期：2026-10-31
> 状态：产品模型、Q1–Q14 与三轮实现复审已回写，可进入垂直切片
> 范围：先改造 `group`；`solo/direct` 保持现有行为。Manager 现有 Delegation 机制不重写。
> 评审回写：第一轮 `.pudding/handoff/2026-10-31-群聊RoomSession方案评审.md`、第二轮 `.pudding/handoff/2026-10-31-群聊RoomSession方案评审-第二轮.md`、第三轮 `.pudding/handoff/2026-10-31-群聊RoomSession方案评审-第三轮.md` 的问题已逐项闭合。
> 关联文档：`2026-08-05-房间即群聊-产品模型方案.md`、`2026-08-06-通用-agent-接入-底层与扩展方案.md`、`2026-08-14-会话记录格式与Harness消费.md`、`2026-08-17-提示词体系完整介绍.md`

## 阅读约定（先读这一节）

本文分两部分，各自职责不重叠：

- **Part I · 设计（非规范，§0–§15）**：背景、决策、原则与约束目标。不定义 TypeScript 接口，不给出有序执行流程、路由清单或错误码表；需要这些事实时只指向 Part II。
- **Part II · 实现契约（规范，§16–§23）**：类型、状态机、有序流程、API/WS、错误码、持久 schema、事务与测试矩阵。**一个概念只在这里定义一次。**

两处表述冲突时，以 Part II 为准，并且必须修正 Part I，而不是保留两份；新增或修改契约只改 Part II，Part I 只允许增加指针。历史变更记录见文末。

## 0. 已确认的设计决策

1. **Manager 是特殊的 Worker，不是房间会话的容器。** 各成员的消息路由、ParticipantSession 续接和公共发言语义一致；Manager 的行为差异只是可以像原来一样 `delegate`。无 `@` 时默认路由到 Manager 是路由配置，不是另一套会话模型。
2. **RoomSession 是独立的房间公共会话。** 它有自己的 ID，不再由 Manager 的 Session ID 兼任，也不等于任何一个 Agent 的 SDK Session。
3. **每个参与者拥有自己的 ParticipantSession。** 同一 `(roomSessionId, agentId)` 至多一个 active binding，Manager 也包含在内；Manager PS 随 RoomSession 同步创建，Worker PS 首次被定向时懒创建，后续续接而不是每条消息新建。
4. **公共历史只包含面向房间的 final content、必要终态和显式发布的产物引用。** 不默认共享思考、流式过程、工具调用、原始 toolResult、命令输出、审批细节或其他私有执行上下文。
5. **给人看和给其他 Agent 看是两种投影。** 用户可以在房间 UI 查看委派卡和执行过程；卡片可见不代表其内容进入所有 Agent 的模型上下文。
6. **Manager 的现有 `manager_tool` Delegation 原来是什么就保持什么。** 每次 fresh、Worker `sessionHandle`、审批、取消、结果只回 Manager、内嵌卡片均不改变；不新增 `DelegationSession` 类型。群聊来源只需补充 `roomSessionId` 归属。非 Pi 公开回合另按 §20 复用 `direct_chat` 作为执行载体，其公共可见性只由 ParticipantTurn 决定。
7. **用户可以通过结构化 `@worker` 直接发起该 Worker 的公开回合。** 不经过 Manager 模型，不由 Manager 转述，Worker 的 final content 写回 RoomSession。

## 1. 第一性原理

### 1.1 共享的是沟通状态，不是模型运行时

群聊协作需要共享“谁对谁说了什么、最终得出了什么、产出了什么、是否成功”，不需要让所有 Agent 共用同一个模型上下文或 SDK `AgentSession`。

每个参与者——包括 Manager——都遵循同一输入输出模型：

```text
输入 = 自己的私有配置与 ParticipantSession + RoomSession 公共历史 + 当前消息
输出 = 面向房间的一段 final content，或一个必要终态
```

ParticipantSession 可以包含该参与者自己的工具历史、思考、模型状态和已消费的公共消息；RoomSession 只投影其中的公共结果，不能反向读取并共享完整 ParticipantSession。

### 1.2 执行的受众决定结果可见性

- 用户 `@WorkerA`：这是面向房间的公开回合，WorkerA 的 final content 面向房间，进入 RoomSession。
- Manager 调用 `delegate`：这是 Manager 的子任务，结果只返回 Manager 的 ParticipantSession。用户可以查看委派卡，但其他 Worker 默认看不到该结果。
- Manager 根据子任务形成的总结或结论，由 Manager 作为公共发言写入 RoomSession 后，其他成员才能看到。

因此，“子任务结果对用户可见”和“子任务结果进入房间公共模型上下文”必须分开实现。

### 1.3 执行过程是证据，不是默认协作输入

其他 Agent 通常需要结论、产物和终态，不需要另一个 Agent 的逐步推理与工具轨迹。默认共享完整过程会增加上下文噪声、敏感信息透出、错误因果和 Agent 间接话风险。

确需跨 Agent 调试或交接时，后续可以提供“分享产物”或“授权读取指定执行记录”的显式动作；不做默认广播。

## 2. 当前实现与目标模型的差异

当前代码已经具备大量可复用能力，但群聊领域身份仍是 Manager 中心：

- `apps/server/src/store/teams.ts` 的 `sessionRefs` 只有一个 `ownerAgentId`，group Session 固定归属 Manager；`workerBindings` 已体现“房间 Session + Worker”的连续绑定思路。
- `apps/server/src/routes/chat.ts` 对 group 普通消息直接打开 Manager 原生 Session；只有 direct 非 Pi Connector 走单独直派分支。
- `apps/server/src/agent-runtime/invoker.ts` 已提供成员范围复核、run/continue、审批和取消；Manager delegation 在 `apps/server/src/pi-bridge/agent-extensions.ts` 中保持 fresh。
- `apps/server/src/pi-bridge/session-read.ts` 已支持同窗口会话只读回读，但它是工具能力，不能保证定向 Worker 在正确时点读到确定历史。
- 当前大量执行归属以 `managerSessionId` 同时表示“Manager 私有会话”和“房间公共会话”。新模型必须拆开这两个身份。

本次不重写 Runtime/Driver SPI，不把多个 Agent 塞进同一个 Pi Session，也不靠动态切换 `ownerAgentId` 实现轮流发言。

## 3. 目标领域模型

```text
Window / Room R
└── RoomSession S（独立 ID，公共历史）
    ├── ParticipantSession PS(S, Manager)
    ├── ParticipantSession PS(S, WorkerA)
    └── ParticipantSession PS(S, WorkerB)

Manager 在 PS(S, Manager) 中发起一次现有 Delegation D
└── 沿用当前 DelegationRecord / Run / Worker sessionHandle
    仅补充 roomSessionId=S，不形成新的 Session 类型
```

### 3.1 RoomSession

RoomSession 是用户在房间中的一段公共对话；在 windows v4 中对应 group `roomSessionIds[]` 的一项，不进入用于 Agent Session 的 `window.sessions[]`：

- 有独立 `roomSessionId`，不属于 Manager 或任何 Worker；
- 保存公共消息、必要终态和公开产物引用；
- 是房间公共历史的唯一事实源；
- 不是 Pi `SessionManager` 可以发现和打开的 SDK Session；
- 新建 RoomSession 时公共历史为空，除非用户显式 Fork/引用；
- 删除、归档、重命名、深链和未读都以 RoomSession 为对象。

### 3.2 ParticipantSession

ParticipantSession 是某个 Agent 在特定 RoomSession 中的私有连续上下文。唯一键规则（`unique_active(roomSessionId, agentId)`，退役 binding 不占 active 键）与持久字段只在 §17.2、§17.4、§18.1 定义，本节不复述。

- Manager 与 Worker 使用同一套 active binding 规则；配置退役的历史 binding 不占用 active 唯一键；
- Manager PS 随 RoomSession 同步创建，保证空房间 timeline、Goal 和 work-state 始终有确定负责人；Worker PS 第一次被 `@` 时懒创建，避免启动 N+1 个 Worker 运行时；
- 后续在同一 RoomSession 中续接，不随每条消息 fresh；
- 同一 Agent 在不同 RoomSession、不同 Window 或不同 Workspace 中使用不同 ParticipantSession；
- Manager/Pi Worker 使用 `PiSessionStore` 原生会话，其 ID 为 `agentSessionId`；其他 Connector 使用现有 Driver `run/continue` 与不透明 `providerSessionHandle`。`PiDriver` 私有 sessionHandle 不作为 ParticipantSession；
- 私有上下文不进入其他参与者的 ParticipantSession，也不直接进入 RoomSession。

### 3.3 现有 Delegation 不变

群聊 Manager 的 `manager_tool` Delegation 保留当前字段和生命周期：

- `delegationId` 仍标识执行；
- `managerSessionId` 继续指向发起者的 Manager ParticipantSession；
- `windowId` 继续标识 Room，不重复增加 `roomId`；
- `managerToolCallId`、Worker `sessionHandle`、`runHandle`、Interaction、Receipt、Timeline 和取消逻辑不变；
- group 来源新增 `roomSessionId`，用于房间归属、UI 投影、查询与权限校验；其他来源可为空；
- `manager_tool` 结果仍只回 `managerSessionId` 对应的 Manager ParticipantSession，不因增加 `roomSessionId` 自动进入 RoomSession。非 Pi 公开回合的 `direct_chat` 结果归属按 §20 单独定义。

服务端通过 §17 的统一 resolver 从 `managerSessionId + roomSessionId` 解析 Manager 所属 Window/Workspace，不再要求 `managerSessionId` 本身必须出现在 `Window.sessions[]` 中。

## 4. 身份与持久化要求（定义见 §17/§18）

本节只列实现必须满足的约束；字段、状态与类型定义只在 Part II。

### 4.1 绑定身份

- `agentSessionId` 是平台逻辑 ID，`providerSessionHandle` 是 Connector 私有句柄，两者不能混用；Provider driver/handle/配置修订只存 `sessionRefs[agentSessionId].provider`，ParticipantBinding 不双写（§17.2）。
- 同一 `(roomSessionId, agentId)` 至多一个 active binding；Agent 配置修订创建新的 `agentSessionId`，把旧 binding 标为 retired，不复用旧句柄、不把旧权限带入新运行时（§17.5）。
- 成员移除或停用只阻止新回合，不删除已有历史，也不能擦除该成员已经获得的上下文（§17.4）。
- 新成员第一次参与时默认可以读取当前 RoomSession 的全部公共历史，但不能读取任何成员私有历史；邀请 UI 必须明示这一规则。

### 4.2 公共事件边界

公共历史是独立、追加式的事实源，不复用 Manager JSONL 的 `pudding:*` custom message；字段、附件、`seq` 与损坏语义见 §18.2、§18.3。两条不可让渡的边界：Manager 私有委派终态不自动写成 RoomEvent；artifact 事件只保存明确发布的引用，不复制执行记录或隐式开放额外目录。按项目约定不迁移旧开发数据，旧版本明确拒绝，不写兼容双读层。

### 4.3 ParticipantTurn 的定位

ParticipantTurn 是执行记录，不替代现有 Run/Delegation，也不新增 Session 类型：它只描述一次 ParticipantSession 的公开回合、冻结的输入范围和公共投影状态（定义见 §18.2，输入与水位规则见 §22.2）。`delegationIds` 只记录 Manager 在本公开回合内产生的既有 Delegation 关联，关联写在 ParticipantTurn 上，不要求给 Delegation 再增加一套回合身份。

## 5. 三种投影必须分开

| 投影 | 内容 | 消费者 |
| --- | --- | --- |
| RoomSession 公共历史 | 用户消息、参与者 final content、必要公开终态、公开产物引用 | 所有参与者，按各自水位消费 |
| 房间 UI 时间线 | RoomEvent + 当前运行状态 + Manager 委派卡 + 审批卡 + 执行过程入口 | 用户 |
| Participant/Delegation 私有执行记录 | 思考、工具、日志、完整 toolResult、审批细节和 Provider 状态 | 当前参与者、用户及显式授权者 |

Manager 委派卡通过 ParticipantTurn 的 `sourceRoomEventId + delegationIds` 投影到对应公开回合的 UI 位置，不写成 RoomEvent。这样既能保留当前内嵌卡片体验，又不会把子任务结果注入其他 Worker 的模型上下文。

`session_read` 面向 RoomSession 时只返回公共历史，不能借“同窗口自由读”读取其他 ParticipantSession。现有 Worker 执行过程仍按 delegationId/process API 查看，不新增默认公开入口。

## 6. 消息路由

### 6.1 结构化接收人

前端 `@` 选择器生成结构化 `mentions: string[]`，服务端不从自由文本猜测接收人：

| 输入 | 路由 |
| --- | --- |
| 无 mentions | 当前 RoomSession 的 Manager ParticipantSession |
| 一个 Worker mention | 目标 Worker 的 ParticipantSession，不调用 Manager 模型 |
| 显式 Manager mention | Manager ParticipantSession，与无 mentions 使用同一语义 |
| 多个 Worker mentions | 领域模型允许；首期不开放，后续共享同一 cutoff 并行执行 |

未知、非成员、停用或已失效的 mention 必须在附件冻结和公共事件写入前拒绝，不能回退给 Manager。Worker 或 Manager 的公共回复不自动触发其他成员，避免 Agent 循环接话。

### 6.2 公开回合语义

一次公开回合的输入是“目标 Participant 的私有上下文 + RoomSession 公共历史增量 + 当前用户消息（含附件）”，输出是面向房间的一段 final content 或一个必要终态。**有序步骤、写入前预算、幂等键和崩溃恢复只在 §21.2、§22.2 定义，本节不复述。**

必须保持的语义：

- 只有目标 Participant 被唤醒；其他参与者在下一次被定向时按各自水位补读公共历史。
- 用户消息、ParticipantTurn 和 ParticipantBinding 的持久顺序必须保证“任何已公开消息都能被恢复”，不能出现已公开但无法追溯的回合。
- 非 Pi Connector 的公开回合复用 `direct_chat` 执行载体（§20.1），它的执行归属与公共可见性由 ParticipantTurn 决定，不是 Manager 的 `manager_tool` 子任务。
- final content 指终态确定的面向用户回复，不包含流式中间文本、进度消息或工具间旁白；部分输出、截断、错误和取消必须按真实终态处理，不能伪装成 completed（§20.2）。

## 7. 公共上下文同步

ParticipantBinding 的 `lastRoomEntryId` 表示**已经以唯一组合 user/direct-chat 输入持久到该 Participant 执行链路的公共事件位置**，不是“模型已阅读”的回执。它只能在 ParticipantInput 已持久且组合输入确认落盘/接单后按 §22.2 推进，不能在 Turn 准入时提前推进。

同步规则：

- 新 ParticipantSession：读取当前 cutoff 前的全部 RoomSession 公共历史；
- 已续接 ParticipantSession：只补充 `lastRoomEntryId` 之后、当前 cutoff 之前的公共事件，并与当前用户消息合成一条输入；
- 同一 ParticipantTurn/ParticipantInput 重试：使用第一次持久化的上下文范围和输入摘要，不因后来新消息而改变；按 operationId/inputHash 判重，崩溃后只补水位，不重复注入；
- 启动失败、取消或结果未知：不能仅凭水位推进就声称模型已消费；恢复逻辑必须依据 ParticipantTurn、Agent user entry/Delegation 和 Provider 真实状态决定重试、重建或人工核对；
- Provider 句柄失效且必须新建：以 RoomSession 重新装配公共历史，旧 ParticipantSession 的私有内容不自动导入新运行时；
- 公共消息转换必须保留作者和 mentions，例如 `[房间消息｜用户 → @WorkerA]`、`[房间消息｜WorkerB]`，不能只保留裸文本。

不依赖 Worker 自主调用 `session_read` 来完成基础同步；`session_read` 可以继续作为按需回读工具。

上下文预算按目标参与者实际能力计算，并在用户 RoomEvent 写入前按 §21.2 做上界检查。超出预算返回 422 `room_context_too_large`，公开历史零写入，不静默截断；后续如增加公共摘要，必须记录来源事件范围和生成版本，不能把 Manager 私有 compaction summary 当作公共摘要。

## 8. 并发、幂等与生命周期

### 8.1 首期公开回合串行与同 Turn followUp

首期同一 RoomSession 同时只允许一个公开回合：Manager 或某个定向 Worker。Manager 等待审批/输入也算尚未完成。

- 新 normal 回合遇到活动 Turn 时被拒绝，前端保留草稿；错误码与响应行为见 §19.4；
- native Pi 允许同 Turn `followUp`，不创建新 Turn，保留 Manager 长 delegation 期间的输入能力；目标必须不变，非 Pi 忙碌时明确拒绝，steer 首期关闭（受理条件见 §19.2，输入与水位见 §22.2）；
- unknown/reconciling 不应形成永久锁：只有存在真实运行观察或有效等待输入的 Turn 才阻塞。恢复期间短暂显示 reconciling；确认无 live Run/Interaction 后由用户通过 `close-unknown` 明确解除，标记 `interrupted_unknown`，不宣称远端已停止；
- Manager 的 Delegate 子任务不是额外公开回合，不改变现有并行子任务能力；
- 后续多 `@` 和公开回合并行必须使用同一 cutoff，并按事件提交顺序处理回复，不能依赖完成时间伪造因果。

### 8.2 消息与公共投影幂等

- 消息操作摘要覆盖 `roomSessionId`、规范化去重后的 mentions、正文、附件、delivery 和 Workspace 身份；
- 同键改变接收人、正文或附件必须冲突；
- 用户 RoomEvent、ParticipantTurn 和 ParticipantSession 接单事实用于恢复已接受操作，不能只按相同文案推断；
- 公共 final content 以 `(roomSessionId, sourceParticipantTurnId)` 幂等发布，崩溃恢复只补尚未投影的确定终态；
- 不确定的外部副作用不自动重放，沿用现有 `message_delivery_unconfirmed` 保守恢复原则；
- RoomEvent 与 ParticipantBinding/ParticipantTurn 跨文件写入必须有操作账本和启动对账，不能把部分写入报告为完整成功。

### 8.3 停止、审批与配置变化

- 公开回合的 Stop 按执行载体分流（§20.1），两条路径都必须收敛 ParticipantTurn（§20.2）；
- Driver Interaction 恢复原 Run，不创建新的 ParticipantSession；
- 成员和 Agent 配置在接单时复核，已接单运行按现有冻结生命周期处理；
- RoomSession 删除、归档、切换 Workspace 和 Goal interrupt 必须能枚举并处理其 ParticipantTurn；Manager Delegation 继续走现有生命周期。

## 9. Goal、提示词与权限边界

- 现有 Goal/WorkPlan 语义不因本方案重写。Room UI 通过 `roomSessionId` 找到当前执行负责人及其 WorkState；不能再默认 RoomSession ID 就是 Manager Session ID。
- 用户 `@Worker` 是普通公开回合，不自动绑定 Manager WorkItem、不自动提交验收证据、不推进 Goal resolved。
- Manager 当前群聊协作提示词、roster 和 delegate 工具仍只装配给 Manager ParticipantSession；Worker 只获得自己的运行指令和公共 RoomEvent。
- Workspace、Attachment、Artifact 的现有授权边界不变。RoomEvent 中的引用本身不扩大文件访问范围。
- 成员可见性（新成员可读公共历史、不能读任何私有历史）按 §4.1；公开消息中已经写出的敏感内容仍属于公共历史，邀请 UI 要提示这一点。
- Fork RoomSession 时只复制公共历史；目标创建事务同步生成新的 Manager PS，Worker 首次被定向时再懒建，各参与者的私有上下文默认不复制。需要私有 Agent Session 快照导入时仍走独立的 direct Window 流程。

## 10. 后端改造点

### 10.1 新增房间公共会话服务

建议新增：

- `apps/server/src/rooms/room-session-store.ts`：RoomEvent 追加、快照、seq/cutoff、落盘与恢复；
- `apps/server/src/rooms/participant-session-service.ts`：ParticipantBinding（Manager 同步创建、Worker 懒创建）、Provider 续接、上下文水位和 ParticipantTurn；
- `apps/server/src/rooms/room-message-router.ts`：默认 Manager、定向 Worker、公开回合锁和公共结果投影；
- `apps/server/src/rooms/room-context.ts`：RoomEvent 到参与者输入的统一转换，保留作者、mentions 和 cutoff；
- `apps/server/src/rooms/room-execution-projection.ts`：按 §20.3 从既有执行事实派生 UI 卡片，不新建第四套事实源。

这些服务位于宿主业务层，不进入 Connector 包，不要求共享核心依赖 PuddingTeams 宿主。

### 10.2 改造现有入口

- `apps/server/src/store/teams.ts`：按 §17/§18 升级持久结构、统一 resolver、prune 与启动校验；保留现有 `workerBindings` 中可复用的修订与 Workspace 校验思路。
- `apps/server/src/routes/chat.ts`：27 条现有路径只处理 agentSessionId；group 公共发送不再落入 Manager 原生分支。
- `apps/server/src/routes/rooms.ts` 与新增 `routes/room-sessions.ts`：分别承担建房/摘要/既有房间操作和 §19 的公共消息、timeline、abort、WS、Fork。
- `apps/server/src/pi-bridge/session-store.ts`：Manager/Worker ParticipantSession 按各自 Agent 装配；Manager 才有 roster/delegate，公共消息保留作者信息。
- `apps/server/src/agent-runtime/invoker.ts`：group Manager Delegation 通过统一 resolver 解析归属；按 §17.5/§20.1 改造 `sessionHandleFor`、`rememberSession`、`rememberWorkerSession` 与 direct_chat handle 持久化；其余接单、成员复核和 Runtime 语义不变。
- `apps/server/src/agent-runtime/delegation-store.ts`：DelegationRecord 增加可选 `roomSessionId` 及校验，不引入新 DelegationSession。
- `apps/server/src/pi-bridge/session-read.ts`：同房间读取改为公共 RoomSession 投影，禁止借同窗口关系读取其他 ParticipantSession。
- 房间活动、未读、搜索、导航和深链改为索引 RoomSession，不再从 Manager 私有 JSONL 重建公共业务事实；其余跨切面文件按 §23.1 逐项改造，不以本节的代表文件列表为全部改动面。

### 10.3 API 与实时事件

现有深链 `/chats?room=<id>&session=<id>` 中的 `session` 对 group 指向 RoomSession ID。现有 `/api/sessions/:id/*` 只接受 `agentSessionId`。房间消息、timeline、abort、未知 Turn、WS、Fork 与错误码全部以 §19 为准，本节不复述契约。

当前代码没有可复用的房间频道：房间公共事件必须使用 §19.5 新增的房间 WS，不能把 RoomSession 塞进 `/api/sessions/:id/ws`。

## 11. 前端改造点

- `apps/web/src/components/chat/composer.tsx`：仅在 group 提供成员 `@` 自动补全，处理键盘、IME、删除和失效成员；发送结构化 mentions。
- `apps/web/src/hooks/useChat.ts`、`apps/web/src/lib/api.ts`：mentions 进入请求、草稿和操作摘要；未确认操作不能在前端悄悄换接收人重试。
- `apps/web/src/components/chat/chat-pane.tsx`：普通消息默认 Manager，定向消息显示真实目标；模型与 thinking 控件按 §22.4 编辑当前目标 ParticipantSession 的局部覆盖，不写 Agent 全局配置。
- `apps/web/src/components/chat/message.tsx`：RoomEvent 渲染普通用户/Manager/Worker 发言；Manager 委派卡继续使用现有卡片与执行过程入口，不把定向 Worker 回复渲染成 Manager 子任务。
- 草稿需同时保存正文与结构化 mentions；切换 RoomSession 时仍按现有作用域隔离。
- 历史、实时事件和房间未读以 RoomEvent 对账，执行卡以 delegationId/ParticipantTurn 对账，避免同一 final content 重复出现。

## 12. 分阶段实施

### P0：垂直切片、领域身份与持久事务

- 先按 §23.2 在测试夹具/实验分支验证显式 owner 的 PiSessionStore、direct_chat 和 final 投影，不先动生产 windows.json；
- 再实现 v4 的 RoomSessionStore、ParticipantBinding、ParticipantTurn、统一 resolver、prune 与启动校验；P0-B 同时交付 `/api/rooms` 新摘要和最小 timeline UI，禁止独立发布 v4 中间态；
- 实现建房/新建 RoomSession（含唯一 Manager PS）、公开消息/公共投影账本和启动对账；
- 不同时维护两套生产公共历史，不把垂直切片变成兼容层。

出口：垂直切片断言通过；active 唯一绑定、Worker 懒创建、新 RoomSession 隔离、重启回读和损坏文件拒绝均有测试；满足 §23.2 的 27 条路由、最小 UI 与建房事务出口条件。

### P1：单 Worker 定向与公共 final content 闭环

- 无 `@` 默认 Manager，`@一个 Worker` 直达对应 ParticipantSession；
- Manager/Worker ParticipantSession 持久续接与增量公共上下文；
- 公共 final content、必要终态、房间 UI 三种投影；
- 结构化 mention、普通成员消息渲染、模型控件目标提示；
- 单公开回合串行 + native Pi 同 Turn followUp、消息幂等、停止和审批恢复；
- Manager 原 Delegation 全量回归，仅增加 `roomSessionId` 归属。

出口：第 13.2 节黄金路径第 1–4 项在 Pi Worker 和至少一个非 Pi Connector 上通过；完整生命周期旅程在 P2 验收。

### P2：生命周期与长会话收口

- 完整崩溃对账、公共投影 outbox、附件/产物恢复；
- RoomSession Fork、归档、删除、搜索和未读全量接入；
- Agent 配置修订、成员移除/重新加入、Workspace 失效时的绑定恢复；
- 公共上下文预算与显式过大处理；
- 浏览器真实刷新、审批、取消和重连旅程。

### P3：增强能力，非首期阻塞项

- 多 Worker mentions，同 cutoff 并行公开回合；
- 定向消息持久排队和流式公开回复；
- 带来源事件范围的公共摘要；
- 显式分享指定执行记录或产物给其他参与者。

## 13. 测试与验收

### 13.1 领域与服务端测试

1. 同一 `(roomSessionId, agentId)` 至多一个 active ParticipantSession（退役 binding 可以并存，规则见 §17.4）；Manager 与 Worker 规则一致；新 RoomSession 不复用旧私有上下文。
2. 无 mention 只运行 Manager；`@WorkerA` 只运行 WorkerA，Manager 模型不被调用。
3. 非成员、停用、未知和失效 mention 在写公共事件前拒绝，不回退 Manager。
4. 用户和 Worker final content 进入 RoomSession；ParticipantSession 的思考、工具调用和 toolResult 不进入。
5. Manager delegate 的结果只回 Manager ParticipantSession；UI 可显示委派卡，其他 Worker 的公共输入不包含该 toolResult。
6. WorkerB 后续被定向时能读到 WorkerA 的公共 final content，但读不到 WorkerA 的私有执行过程。
7. 增量同步严格按 cutoff；同一 ParticipantTurn 重试不吸收后来消息；失败恢复不跳过未确定消费的公共事件。
8. 同键重试不重复 RoomEvent、ParticipantTurn 或 Run；改变 mentions、delivery、附件或预期 Turn 返回冲突；公共 final 投影幂等。
9. 停止、审批、成员变化、Agent 修订和 Workspace 失效都恢复到真实运行状态。
10. 现有 Manager Delegation 测试全部保持：fresh、结果回 owner、审批、取消、Receipt、Timeline 和群内范围不变。

### 13.2 前端与真实旅程

黄金路径：

1. 用户普通发言，Manager 回复并委派 WorkerA；用户能看到原内嵌委派卡。
2. 用户 `@WorkerB`，WorkerB 能看到用户消息和 Manager 的公共 final content，但看不到 Manager 的委派 toolResult 和 WorkerA 执行过程。
3. WorkerB 的 final content 出现在同一房间时间线，Manager 没有额外运行或转述。
4. 用户再 `@WorkerA` 或普通询问 Manager，目标能正确转述 WorkerB 的公开发言，且作者身份不混淆。
5. 新建另一个 RoomSession 后，不带入上一 RoomSession 的公共或私有上下文；显式 Fork 只复制公共历史。
6. 刷新、重连、审批、取消和同键重试不产生重复发言或错误运行态。

标准检查：

```bash
cd apps/server && pnpm test && pnpm typecheck
cd apps/web && pnpm typecheck && pnpm lint && pnpm build
pnpm build:runtime
```

## 14. 文档同步要求

行为落地后必须同步：

- `docs/2026-08-05-房间即群聊-产品模型方案.md`：group 不再描述为 Manager 单一会话，更新 RoomSession、ParticipantSession、路由和可见性；
- `docs/2026-08-06-通用-agent-接入-底层与扩展方案.md`：ParticipantBinding、非 Pi direct-chat 适配和 Delegation `roomSessionId`；
- `docs/2026-08-14-会话记录格式与Harness消费.md`：新增 RoomEvent/ParticipantTurn 格式，明确公共事件与私有 JSONL 的消费边界；
- `docs/2026-08-17-提示词体系完整介绍.md`：Manager 与 Worker 私有提示词、公共 RoomEvent 的装配边界；
- `docs/2026-10-15-工具装配与暴露清单及分级配置评估.md`：必须按 §22.1 记录 Manager/Worker ParticipantSession 的工具面、Workspace 授权和 Manager-only 边界；本方案不新增 Manager 工具并不等于工具装配不变。

## 15. 明确不采用的方案

- 多个 Agent 共写一个 SDK AgentSession，或按消息轮换 `ownerAgentId`；
- 把 Manager 私有 JSONL 直接作为所有 Worker 的共享上下文；
- 每条公开消息都 fresh 一个 ParticipantSession；
- 只给 Worker 一个 `session_read` 链接，依赖模型自行决定是否读取；
- 把执行过程、思考或完整 toolResult 默认广播给所有成员；
- 新造 DelegationSession，或为了房间模型改变现有 Delegation fresh/审批/取消语义；
- Worker 回复后自动唤醒 Manager 或其他 Worker，形成无明确用户路由的 Agent 循环。


---

## Part II · 实现契约（规范，§16–§23）

> 本节起为唯一规范部分。类型、状态机、有序流程、API/WS、错误码、持久 schema、事务与测试矩阵只在这里定义；Part I（§0–§15）只保留原则与指针。修改契约时先改本节，再修正 Part I 中受影响的指针。

## 16. Q1–Q14 实现决策

以下决定是直接开工的约束，不再是待决问题。它们与 §17–§23 一起构成实现契约。

| 编号 | 决定 | 对应章节 |
| --- | --- | --- |
| Q1 | Pi ParticipantSession 统一使用 `PiSessionStore` 原生会话，其平台 ID 命名为 `agentSessionId`；`PiDriver` 私有 `sessionHandle` 只用于既有 Delegation 执行，不用于 ParticipantSession。非 Pi 的 `agentSessionId` 是平台本地 ParticipantSession/准入记录 ID，真正的远端连续性另存 `providerSessionHandle`。 | §17、§20 |
| Q2 | 保留 `contextForSession/windowForSession/workspaceForSession` 的调用形状，让它们同时解析普通原生 Agent Session 与 ParticipantSession；另加 `contextForRoomSession`，不让 RoomSession 混入 `PiSessionStore.open()`。v4 用 `participantSessions` 注册，修改 prune 和启动校验，ParticipantSession 不进入 `window.sessions`。 | §17、§18 |
| Q3 | Pi 公开回合使用原生 Run + ParticipantTurn；非 Pi 公开回合复用 `DelegationRecord(invocationKind="direct_chat")`，`managerSessionId=目标 Worker agentSessionId`。Delegation 只是执行载体，不决定公共可见性；`manager_tool` 结果只回 Manager，`direct_chat` 结果只由 ParticipantTurn 投影到 RoomEvent。 | §20 |
| Q4 | `/api/sessions/:id/*` 永远只接受 `agentSessionId`。Room 公共消息、时间线、abort、WS、Fork 使用 `/api/rooms/:roomId/sessions/:roomSessionId/*`；27 条现有路由逐一按下表分流。 | §19 |
| Q5 | v4 拆出 `roomSessions` 与 `participantSessions`；RoomEvent、ParticipantTurn、RoomMessageOperation 分文件持久。先验证垂直切片，再切换 v4；每个 RoomSession 同步创建一个 Manager PS，但不创建任何 Worker SDK Session，空事件文件 + Manager 预留 ID + windows 原子写 + 创建账本构成新事务。 | §18、§21 |
| Q6 | RoomSession 永久绑定一个 `(workspaceId, cwdSnapshot)`。group 继续按项目创建独立 Window/RoomSession，不做同 ID 原地切换；未来即使增加原地切换，也必须 park 整个旧 RoomSession 并在目标上下文创建另一个 RoomSession。 | §17、§21 |
| Q7 | Worker ParticipantSession 工具面与当前 direct Worker 对齐：自己的运行指令、Skills/MCP/Capability、知识/联网授权和 Workspace 工具；没有 Manager roster/delegate/Goal 控制。Workspace 权限从 RoomSessionRef 解析。 | §22 |
| Q8 | RoomEvent 增加结构化 `attachments[]`，图片不存 base64；当前回合可把冻结图片作为原生 image input，历史图片以受控引用表达。公开消息支持 normal 与同 Turn followUp；steer 暂缓，非 Pi 忙碌时不提供 followUp，队列操作走房间路由。 | §19、§22 |
| Q9 | UI 执行投影由 `RoomExecutionProjectionService` 从 ParticipantTurn、DelegationStore、InteractionStore、WorkState/outbox 派生，不把卡片写成 RoomEvent，也不另建一套执行事实源。Pi Stop=abort(agentSessionId)，非 Pi Stop=cancel(delegationId)。 | §20 |
| Q10 | 活动/未读同时消费 RoomEvent 与需要用户处理的执行投影；搜索只索引公共 RoomEvent 和既有执行记录；pin/归档键改为 `roomSessionId`，ParticipantSession 不出现在主导航。 | §23 |
| Q11 | 删除 RoomSession 时先封锁新回合并收敛活动执行，再删公共文件、本 Room 独占的原生 Agent Session、Manager WorkState/Goal/Decision/outbox 与 roomSessionId 附件；非 Pi 远端句柄只废弃本地绑定，不虚称远端已删除。 | §21、§19.6 |
| Q12 | group 的 `session_read` 和 `/chats?...&session=` 都指向 RoomSession 公共历史；其他 ParticipantSession 不能借同窗口关系互读。分页使用公共 `seq`。 | §22 |
| Q13 | 模型/思考强度始终是“当前目标 ParticipantSession 的局部覆盖”，不写全局 Agent 配置。Pi 用现有 Session model/thinking API，非 Pi 用 worker-runtime-model API；composer 随 mentions 切换目标。 | §19、§22 |
| Q14 | 知识来源同时记录 RoomSession/origin event 与执行 AgentSession；worker-process 继续支持 managerAgentSessionId，并增加 roomSessionId 过滤；Goal outbox 仍写 Manager PS，另向房间 UI 发执行投影，不写公共 RoomEvent。 | §23 |

## 17. 身份、注册与统一解析

### 17.1 ID 生命周期与命名

| 名称 | 指向 | 创建时机 | 是否可被 `PiSessionStore.open()` | 是否进入主导航 |
| --- | --- | --- | --- | --- |
| `roomSessionId` | 一段房间公共对话 | 建房或新建房间会话 | 否 | 是 |
| `agentSessionId` | 某参与者的私有 ParticipantSession；solo/direct 也沿用现有原生 Session ID | Manager：随 RoomSession 创建；Worker：首次被定向时懒创建；solo/direct：现有原生会话创建时 | 是（非 Pi 也是可 open 的本地 Participant 容器 JSONL，用于准入与 worker-runtime-model） | 否，只从房间或执行详情进入 |
| `providerSessionHandle` | Connector 上游连续会话 | Driver 首次启动后 | 否 | 否 |
| `participantTurnId` | 一次公开回合及其公共投影状态 | 用户 RoomEvent 与 Turn 同批持久时 | 否 | 否 |
| `roomEventId` | 一条公共 final/terminal/artifact 事件 | 公共事件提交时 | 否 | 在时间线中定位 |
| `delegationId` | 既有 Runtime 执行 | Manager delegate 或非 Pi direct-chat 接单 | 否 | 只显示为执行记录 |

API 字段同步改名，禁止继续用无类型的 `id/sessionId` 传递两类对象：

- `RoomSessionSummary.id` → `roomSessionId`；
- `RoomSummary.activeSession` → `activeRoomSessionId`，`activitySessionId` → `activityRoomSessionId`；
- group 的 `RoomSummary` 增加 `managerParticipantSessionId`；Participant 摘要使用 `{agentId, agentSessionId, role}`；
- 前端 `RoomSession` 类型与 `setActiveRoomSession` 同步使用 `roomSessionId`；
- `session=` 深链参数保留，但它只是定位键：group 解析为 `roomSessionId`，solo/direct 解析为既有 `agentSessionId`。私有 ParticipantSession 不生成新的主导航链接。

### 17.2 注册位置

- group 的 `window.sessions/activeSession` 不再使用，改为 `roomSessionIds/activeRoomSessionId`；ParticipantSession 不放入这些数组，也不放入 `parkedContexts`。
- `roomSessions[roomSessionId]` 注册公共身份和不可变 Workspace。
- `participantSessions[agentSessionId]` 注册 active/retired ParticipantBinding；同一 `(roomSessionId, agentId)` 至多一个 active，允许多个 retired。
- `sessionRefs[agentSessionId]` 继续保存 owner 和 Provider 信息，但只登记 Agent Session，不登记 RoomSession。**非 Pi 续接 handle 的唯一运行时权威是 `sessionRefs[agentSessionId].provider.providerSessionHandle`；DelegationRecord.sessionHandle 只作执行审计快照与崩溃恢复证据，group 不再写 workerBindings。**
- 非 Pi 的 `agentSessionId` 也必须有可 `open()` 的本地 Participant 容器 JSONL，用于准入、`worker-runtime-model` 和审计；它不是合成空 ID，模型执行仍由 Driver 负责。
- 现有 `workerBindings` 只保留给 solo/direct 的 direct-chat 连续性；group 不再写两套绑定。

### 17.3 resolver 契约

```ts
contextForSession(agentSessionId): Promise<SessionContext | undefined>
windowForSession(agentSessionId): Promise<WindowConfig | undefined>
workspaceForSession(agentSessionId): Promise<string>
contextForRoomSession(roomSessionId): Promise<RoomSessionContext | undefined>
participantForRoomSession(roomSessionId, agentId): Promise<ParticipantBinding | undefined>
managerParticipantForRoomSession(roomSessionId): Promise<ParticipantBinding>
resolvePublicSessionReference(roomId, id): Promise<
  | { kind: "room"; context: RoomSessionContext }
  | { kind: "agent"; context: SessionContext }
  | undefined>
```

规则：

1. 现有三个 resolver 先查 solo/direct 的窗口 Session，再查 `participantSessions`，返回相同的 `window/workspaceId/cwdSnapshot/active/workerBindings` 形状，并增加可判别 `kind` 与 `roomSessionId`。因此 `PiSessionStore.windowContextOf`、`invoker.delegate`、respond 路径不必各自发明 Participant 解析。
2. 三个 resolver 收到 `roomSessionId` 必须返回 `undefined`；`PiSessionStore.open(roomSessionId)` 因找不到 Agent Session 而明确失败，不能静默创建 Manager Session。
3. `contextForRoomSession` 只从 group `roomSessions` 和窗口上下文解析，不调用 `open()`。
4. `managerParticipantForRoomSession` 是 work-state、Goal、worker-process 和 Goal outbox 的唯一 Manager ID 来源；Manager PS 已在 RoomSession 创建事务中注册，因此空房间也必须返回，不允许 optional。
5. `participantForRoomSession` 只返回 active binding；按 `agentSessionId` 直接打开 retired binding 仅允许只读审计，新执行返回 `participant_retired`。
6. `resolvePublicSessionReference` 只用于深链/API 边界，不进入 Runtime 内部代替类型明确的 resolver。

### 17.4 prune、列表与启动校验

`writeWindows()` 不再只按 `window.sessions` 计算 owned：

- `roomSessions` 只保留仍被 group `roomSessionIds` 引用的项；
- active 和 retired ParticipantBinding 都保留，只有显式 RoomSession 删除产生的 tombstone 才能进入清理流程；不能用 prune 抹掉配置退役的审计会话；
- `sessionRefs` 保留 solo/direct 窗口 Session，以及 active/retired ParticipantBinding 对应的 Agent Session；
- prune 只能在完整校验后的显式写盘中执行，启动读取不能先静默删除再修复；
- `PiSessionStore.list()` 的 owned 过滤同步改为 v4 resolver，不能继续展开 `window.sessions`。`GET /api/sessions` 只列 Agent Session，并用 `participantOf:{roomId,roomSessionId,agentId,state}` 标记 Participant；RoomSession 不列入。

启动时逐项断言：

- RoomSession 与 Agent Session ID 命名空间不相交；
- group 至少一个 RoomSession，`activeRoomSessionId` 存在且属于当前 Window；
- RoomSession 的 `roomId/workspaceId/cwdSnapshot` 与所属 group 上下文一致；
- ParticipantBinding 的 RoomSession 存在，`sessionRefs[agentSessionId].ownerAgentId === agentId`，同一 `(roomSessionId, agentId)` 至多一个 active；
- 每个 RoomSession 恰好一个 active `role="manager"` 的 pinned Manager；Worker 可以是当前或历史成员，新回合另查当前 members，不因移除成员破坏历史校验；
- ParticipantBinding 的 Workspace 与 RoomSession 完全一致；retired 记录只读，不得重新激活来绕过新配置校验；
- Provider handle 不跨 Binding 复用，Agent 配置修订只决定能否续接，不改变历史归属。

这替换当前 `teams.ts:710` 的“group owner 必须是 manager”和 `:1496` 的单数组 prune，而不是绕开它们。

### 17.5 Participant owner 创建与退役

`PiSessionStore.create()` 增加显式 owner 参数，禁止依赖 `ctx.type` 推断 Participant owner：

```ts
sessions.create(modelRef, window, agentSessionId, {
  ownerAgentId: agentId,
  participant: { roomId, roomSessionId, role }
})
```

实现约束：

- `agentSessionId` 在 RoomSession/Participant 创建账本 reserve 时生成并预留；`binding.sessionId` 在调用 `assembleSession` 前就为该值，不能等装配结束才回填。
- `sessionOwner()` 优先使用显式 `ownerAgentId`，随后才是已注册 ref；显式 owner 与 ref/ParticipantBinding 必须一致。group 缺少 owner 时直接 `session_owner_required`，不得回退 `getManager()`。
- `assembleSession/managerResourceLoader` 从同一次显式 owner 快照计算 role 和工具面。Worker ParticipantSession 不得拿到 roster、delegate、create_group/invite 或 Manager Goal 控制；该断言进入 P0-A 和 P0-B 测试。
- RoomMessageOperation/创建账本记录预留 `agentSessionId`。若原生 JSONL 已创建而 windows v4 尚未登记 ref/binding，启动只清理该账本指向的精确孤儿；已有用户消息或归属不确定时转 recovery required，不自动删除。
- Agent 配置修订需要新 Participant 运行时：在同一次 windows 写中把旧 binding 标为 `retired`、创建新 `agentSessionId` 的 active binding。旧 ref 与 JSONL 保留只读审计，prune 不得删除；新执行不得继续使用旧 handle。
- RoomSession 显式删除才允许把 active/retired binding 标为 tombstone 并按 §21.4 清理，配置退役不等于删除历史。

## 18. 持久化 schema 与启动对账

### 18.1 windows.json v4

```ts
interface WindowsFileV4 {
  version: 4;
  windows: Record<string, WindowConfigV4>;
  roomSessions: Record<string, RoomSessionRef>;
  sessionRefs: Record<string, WindowSessionRef>;
  participantSessions: Record<string, ParticipantBinding>;
  retiredCreationOperations?: Record<string, string>;
}

type WindowConfigV4 =
  | (ExistingWindowFields & {
      type: "solo" | "direct";
      sessions: string[];          // agentSessionIds
      activeSession: string;
      workerBindings?: SessionWorkerBindings;
      parkedContexts: Record<string, ParkedWindowContext>; // solo 使用；direct 仍为空
    })
  | (ExistingWindowFields & {
      type: "group";
      roomSessionIds: string[];    // newest first
      activeRoomSessionId: string;
      parkedContexts?: never;
      sessions?: never;
      activeSession?: never;
      workerBindings?: never;
    });

interface RoomSessionRef {
  roomSessionId: string;
  roomId: string;
  workspaceId?: string;
  cwdSnapshot: string;
  customName?: string;           // 仅用户显式改名
  generatedName?: string;        // 可选 LLM 标题；缺省取第一条 RoomEvent
  createdAt: string;
  sourceSnapshotId?: string;
}

interface ParticipantBinding {
  agentSessionId: string;
  roomId: string;
  roomSessionId: string;
  agentId: string;
  role: "manager" | "worker";
  state: "active" | "retired" | "tombstoned";
  workspaceId?: string;
  cwdSnapshot: string;
  lastRoomEntryId?: string;
  /** 每次 active 状态、水位或归属变更 +1；水位 CAS 的期望值。 */
  revision: number;
  createdAt: string;
  updatedAt: string;
  retiredAt?: string;
  retireReason?: "configuration_changed" | "room_session_deleted";
}
```

`ExistingWindowFields` 表示现有 `id/type/name/members/prompt/workspaceId/cwdSnapshot/createdAt/pinned` 等字段原样保留，不是再建一份 Window。v3 按项目约定明确拒绝，不做 v3/v4 双读。Provider driver、handle 与配置修订只在 `sessionRefs[agentSessionId].provider` 保存，ParticipantBinding 不复制第二份。

### 18.2 RoomSession 文件布局

```text
state/room-sessions/<roomSessionId>/
  events.jsonl          # 唯一公共历史事实源
  turns.json            # 原子整文件，ParticipantTurn 映射
  operations.json       # 原子整文件，创建/消息/投影操作账本
```

ParticipantBinding 在 windows v4，原生 Agent JSONL 仍在现有 sessionDir，非 Pi Provider handle 按现有 sessionRefs/Runtime 关联。执行卡不复制到 events.jsonl。

RoomEvent 的完整定义（Part I §4.2 只描述边界）：

```ts
interface RoomEvent {
  id: string;
  roomSessionId: string;
  seq: number;
  kind: "message" | "terminal" | "artifact";
  actor: { kind: "user" | "agent" | "system"; agentId?: string };
  content: string;
  mentions: string[];
  attachments?: Array<{
    name: string;
    path: string;
    mediaType: string;
    size: number;
    sha256: string;
    kind: "file" | "image";
  }>;
  artifactRefs?: Array<{ name: string; path: string; kind?: string }>;
  sourceParticipantTurnId?: string;
  replyToEventId?: string;
  createdAt: string;
}
```

附件只存冻结引用和字节摘要，不存 base64。`content` 是用户可见正文，执行时需要的冻结路径块由 RoomContext 根据 attachments 生成，不在正文里再藏一份 `executionText`。

ParticipantTurn 至少包含：

```ts
interface ParticipantTurn {
  id: string;
  agentSessionId: string;
  roomSessionId: string;
  sourceRoomEventId: string;
  contextFromAfterRoomEventId?: string;
  contextThroughRoomEventId: string;
  inputHash: string;
  operationId: string;
  inputs: ParticipantInput[];    // 首个为 initial input；followUp 追加独立子记录
  execution?: { kind: "native_pi" } | { kind: "direct_chat"; delegationId: string };
  delegationIds: string[];       // Manager 本回合的既有子任务；非 Pi 自身 execution 也加入
  status: "admitted" | "running" | "waiting_input" | "reconciling" | "unknown" | "interrupted_unknown" | "completed" | "failed" | "cancelled";
  finalContent?: string;
  terminalReason?: string;
  publicProjectionState: "pending" | "projected" | "not_applicable";
  createdAt: string;
  updatedAt: string;
}
```

### 18.3 seq、写锁与损坏语义

- 每个 RoomSession 只有一个追加写者；进程内按 roomSessionId 串行，跨进程继续依赖 Home 单写者门禁。
- 打开已有 events 文件时校验全文件、唯一 event ID 和连续 `seq=1..N`；追加时 `seq=N+1`，完整一行写入后 fsync。新建文件同时 fsync 父目录。
- cutoff 使用 `roomEventId`，其对应 seq 必须位于当前已提交尾部；增量读取按 seq，不能用消息数组下标或时间戳。
- 完整坏行、重复 seq/ID、非连续 seq 使该 RoomSession 进入 `recovery_required`，阻断其读写但不必拖垮其他 Room；保留原字节，不静默重置、截断或跳过。
- turns/operations 采用与 `SessionCreationOperations` 相同的 `0600 temp + fsync + rename + directory sync`。rename 后目录同步失败标记 persistence uncertain，重启回读，不继续写入。

### 18.4 操作账本状态机

新增 `RoomSessionCreationOperations` 与 `RoomMessageOperations`，复用 `SessionCreationOperations`/`MessageSubmissionOperations` 的原子写和恢复模式，但不复用“sessionId 一定是 Pi Session”的字段语义：

```text
Room 创建：reserved → event_file_created → manager_created → manager_bound → attached
公开消息：reserved → user_event_appended → participant_bound → participant_input_durable → accepted
公共投影：final_persisted → room_event_appended → projected
```

- `participant_bound → participant_input_durable → accepted` 只表示公开用户意图、执行归属和唯一组合输入已持久，不表示模型已生成或已消费。
- 每个操作保存 `key/kind/requestHash/roomSessionId/roomEventId?/participantTurnId?/agentSessionId?/phase`；同键不同 hash 冲突。
- `accepted` 的恢复必须同时找到唯一 user RoomEvent、ParticipantTurn、ParticipantBinding 和 ParticipantInput；不能只凭正文相同。已接受回放先于 active 锁判断。

启动顺序：

1. 读取并完整校验 windows v4；此步骤失败按现有 Windows 严重错误阻止开放路由。
2. 对账 RoomSession 创建账本：有有效 RoomSessionRef 和 Manager Binding 则保留并补 attached；只有账本、空事件文件和预留 Manager JSONL 则按精确 ID 清理；已有用户消息或归属不明则标记 recovery required，禁止自动清理。
3. 校验 RoomEvent 文件和 seq，隔离损坏房间。
4. 恢复现有 NativeInput、AgentRuntime/Delegation 与 Interaction，不重放外部副作用。
5. 对账 ParticipantTurn、ParticipantInput 与 ParticipantBinding：先按 operationId/inputHash 判重并补推进水位，再补 execution 关联；group direct_chat 仅在 sessionRefs 缺 handle 时按 §20.1 从匹配的审计 Delegation 恢复。Worker 原生 JSONL 已建但 binding 未写时按 §17.5 精确补登记或清理，不创建第二个 Manager/Worker Session。
6. 对 `finalContent` 已持久且终态确定的 ParticipantTurn，按 sourceParticipantTurnId 幂等补 RoomEvent，再标记 projected。
7. 恢复 Goal outbox 与 RoomExecutionProjectionService 投影，重建活动/未读索引。
8. 完成上述门禁后开放对应 Room 的消息写入和 WS。unknown/reconciling 只在真实运行观察存在时阻塞；无 live Run/Interaction 的 Turn 显示恢复提示，并可由用户按 §19.3 显式 close-unknown，不得永久占用 `room_turn_active`。

## 19. API 与实时事件契约

### 19.1 现有 27 条 `/api/sessions/:id/*`

总原则：`:id=agentSessionId`。group 前端不得把 `roomSessionId` 传给这些路径；调用前通过 ParticipantBinding 或 `managerParticipantSessionId` 取得正确 Agent Session。

**Participant 写路径 fail-closed：**只要 ID 关联到 group ParticipantBinding，`DELETE /:id`、`POST /:id/messages`、`POST /:id/abort`、`POST /:id/queued-inputs/:key` 必须在任何 `store.open()`、preflight、`store.remove()` 或 `workStates.removeSession()` 之前返回 409 `participant_session_managed`。只能由房间路由内部调用对应原生能力，避免绕过 RoomEvent/ParticipantTurn 或误删 Manager Goal/Decision/outbox。模型设置、Manager work-state 和显式私有快照导入不因该规则改变。

| 路由 | group 下的明确行为 |
| --- | --- |
| `GET /api/sessions` | 仅列 Agent Session，不列 RoomSession；Participant 项必须附 `participantOf:{roomId,roomSessionId,agentId,state}`，房间列表继续由 `/api/rooms` 提供。 |
| `GET /:id/commands` | 读取指定 ParticipantSession 的真实 Skill/模板命令；非 Pi 按其 capability 返回空或拒绝。 |
| `DELETE /:id` | Participant 一律 409 `participant_session_managed`；群聊删除只走 `/api/rooms/:roomId/sessions/:roomSessionId` 的级联事务。 |
| `GET/PUT /:id/worker-runtime-model`、`GET .../options` | 对非 Pi ParticipantSession 提供局部模型覆盖；`workerModelContext` 从 direct-only 扩展到有效 ParticipantBinding，读写本地 Participant 容器的 `pudding:worker-runtime-model`，不能写全局 Connector 配置。 |
| `POST /:id/model`、`POST /:id/thinking-level` | 设置指定 Manager/Pi Worker ParticipantSession 的局部模型与档位；沿用忙碌/待确认输入门禁。 |
| `POST /:id/messages` | Participant 一律 409；group 公共发送必须用 §19.2，私有 Participant 也不提供绕过房间的写入通道。 |
| `POST /:id/queued-inputs/:key` | Participant 一律 409；公开回合的 followUp 队列只能通过 §19.3 房间路由操作。 |
| `POST /:id/abort` | Participant 一律 409；Manager/Pi Worker 公开回合由房间 abort 路由解析后内部调用 abort。 |
| `GET /:id/messages` | 返回私有 Agent 历史，仅供授权的原生 Participant/执行详情使用；房间公共时间线不得调用。 |
| `GET /:id/ws` | 私有原生 Session 频道；房间公共频道使用 §19.5，不存在“复用房间频道”的说法。 |
| `GET/PUT /:id/work-state` | `:id=managerParticipantSessionId`；group UI 从 RoomSummary 解析后调用，WorkState 键不变。 |
| `GET/PUT /:id/work-plan` | 同上。 |
| `POST /:id/work-items/:workItemId/review` | 同上。 |
| `GET /:id/work-plan/summary` | 同上。 |
| `GET /:id/goal/recovery` | 同上。 |
| `POST /:id/goal/interrupt` | 同上；同时通过 roomSessionId 找到并处理当前公开回合。 |
| `POST /:id/goal/resume` | 同上。 |
| `POST /:id/goal/abandon` | 同上。 |
| `POST /:id/goal/supersede` | 同上。 |
| `POST /:id/decision-requests` | 同上；回答仍恢复 Manager 的既有流程，不路由给被 @ 的 Worker。 |
| `GET /:id/snapshot-origin` | 仅私有 Agent Session 的快照来源；RoomSession Fork 来源由 RoomSessionRef/新房间接口返回。 |
| `GET /:id/fork-targets` | 仅私有 Agent Session 的快照导入候选；群聊公共 Fork 不调用。 |
| `POST /:id/forks` | 沿用现有“快照导入目标 Worker direct Window”流程，不是房间内 Participant 复制；群聊公共 Fork 使用 §21.3。 |

### 19.2 房间公共消息与快照

```http
POST /api/rooms/:roomId/sessions/:roomSessionId/messages
Idempotency-Key: <key>
Content-Type: application/json

{
  "content": "@WorkerA 请检查这个方案",
  "mentions": ["worker-a"],
  "attachments": [],
  "delivery": "normal"
}
```

- `mentions` 必须是去重后的 Agent 内部 ID，不是显示名；首期最多一个。缺省 `[]` 或 `["manager"]` 路由 Manager。
- `delivery` 支持 `normal | followUp`。normal 在空闲时创建新 ParticipantTurn，忙碌时返回 `room_turn_active`；followUp 只追加到当前 activeTurn，mentions 必须解析到同一 Participant，不创建新 Turn。它保留 Manager 跑长 delegation 时的追加能力。
- followUp 仅在目标为 native Pi 且有真实活动/等待中的 ParticipantTurn 时受理，复用 NativeInput 的持久回执；非 Pi 忙碌时返回 409 `participant_delivery_unsupported`，不假装存在跨 Driver 的运行中输入队列。`steer` 首期不支持。
- 服务端先回放已接受操作，再判断 activeTurn；followUp 的目标、活动 Turn、delivery 能力任一不匹配都不写 RoomEvent。
- operationHash 覆盖规范化 `content + 排序后的 mentions + 有序附件摘要 + delivery`；contextHash 覆盖 `roomId + roomSessionId + workspaceId + cwdSnapshot`。followUp 请求体还必须带 `expectedParticipantTurnId` 并纳入 operationHash，不能迟到后追加到下一回合；normal 请求不得携带该字段。
- 成功响应在用户 RoomEvent、ParticipantTurn/追加输入记录和 ParticipantBinding 均持久后返回：

```json
{
  "accepted": true,
  "roomEventId": "event-...",
  "participantTurnId": "turn-...",
  "persistence": "durable"
}
```

`accepted` 不承诺模型已生成或排队输入已消费，执行状态由时间线/WS 提供。与原生 Agent 消息“等待模型准入”的契约刻意分开，避免 Worker 启动失败时把一条已经公开的消息伪装成从未发送。

房间列表中的公开摘要统一为：

```ts
interface RoomSessionSummary {
  roomSessionId: string;
  name: string;
  firstMessage: string;
  lastMessagePreview: string;
  modifiedAt: string;
  active: boolean;
  managerParticipantSessionId: string;
  participants: Array<{ agentId: string; agentSessionId: string; role: "manager" | "worker" }>;
  activityRevision: number;
  readRevision: number;
  hasUnreadActivity: boolean;
  sourceSnapshotId?: string;
}
```

`participants` 只列已绑定参与者：Manager 必有，Worker 首次被定向后出现；未绑定的成员通过 timeline 的 `capabilities.allowedMentions` 暴露，不伪造 `agentSessionId`。

```http
GET /api/rooms/:roomId/sessions/:roomSessionId/timeline
```

返回：

```ts
interface RoomTimelineSnapshot {
  roomId: string;
  roomSessionId: string;
  events: RoomEvent[];
  executionProjections: RoomExecutionProjection[];
  activeTurn?: PublicParticipantTurn;
  queuedInputs: Array<{ operationId: string; text: string; delivery: "followUp"; persistence: "pending" | "durable" }>;
  participants: Array<{
    agentId: string;
    agentSessionId: string;
    role: "manager" | "worker";
    nativePi: boolean;
    model?: string;
    thinkingLevel?: string;
  }>;
  managerParticipantSessionId: string;
  capabilities: {
    canSend: boolean;
    canStop: boolean;
    busyInputModes: Array<"followUp">;
    allowedMentions: string[];
    activeParticipantTurnId?: string;
    recoveryRequired: boolean;
  };
  lastEventSeq: number;
  activityRevision: number;
}
```

`participants` 与 `RoomSessionSummary.participants` 同义；`recoveryRequired=true` 时 `canSend=false`，只允许 close-unknown、查看过程或删除房间。

`PublicParticipantTurn` 是 ParticipantTurn 的 UI 安全投影，不含私有 tool trace、provider state 与完整错误：

```ts
interface PublicParticipantTurn {
  id: string;
  agentId: string;
  agentSessionId: string;
  status: ParticipantTurn["status"];
  startedAt: string;
  updatedAt: string;
}
```

前端 `useChat` 为 group 改消费该形状，不再读取 `wireMessages/sessionManager.branch`。忙碌时 composer 明确提供“追加到当前回合”而不是看似可发送却永远 409；非 Pi 忙碌或 steer 不可用时直接禁用对应选项并说明原因。

### 19.3 abort、queued-input、未知 Turn、命令与模型

- `POST /api/rooms/:roomId/sessions/:roomSessionId/abort`：只针对当前 activeTurn；native_pi 调 `abort(agentSessionId)`，direct_chat 调 Runtime cancel(delegationId)，并等待 ParticipantTurn 终态可投影。
- `POST /api/rooms/:roomId/sessions/:roomSessionId/queued-inputs/:operationId`：仅支持 `{action:"cancel"}` 且目标为当前 native Pi activeTurn 的待消费 followUp；内部调用 NativeInput dropQueued。房间路由不提供 steer，Participant 原 Agent queued-input HTTP 仍 409。
- `POST /api/rooms/:roomId/sessions/:roomSessionId/turns/:participantTurnId/close-unknown`：只用于 unknown/reconciling 且已无真实运行观察的 Turn。用户显式确认后将其标为 `interrupted_unknown` 并解除公开回合锁；不声称远端已停止、不伪造 cancelled，既有外部副作用审计和 Harness 阻塞仍保留。
- `/goal` 仍由 composer 打开 Goal 表单，随后用 `managerParticipantSessionId` 调现有 work-state API，不经过公开消息路由。
- 其他 commands 通过当前目标 `agentSessionId` 调 `/api/sessions/:id/commands`；非 Pi 不支持时前端不提供执行入口。
- 模型与 thinking 写入当前目标 `agentSessionId`。切换 mentions 只切换要编辑的 ParticipantSession，不改变 RoomSession，也不写 Agent 全局配置。

### 19.4 错误码

| HTTP | code | 含义与客户端动作 |
| --- | --- | --- |
| 400 | `invalid_message` / `invalid_mentions` | 内容为空、mentions 非内部 ID/重复/超过首期数量；发送前修正。 |
| 400 | `room_delivery_unsupported` | 请求 steer、followUp 缺/错 `expectedParticipantTurnId`，或 delivery 与当前目标/活动 Turn 不匹配；不静默降级。 |
| 404 | `room_session_not_found` | Room/RoomSession 不存在或不匹配；停止发送并重新定位。 |
| 409 | `participant_unavailable` / `participant_retired` | Worker 非成员、停用、配置失效或目标已退役；刷新参与者，不回退 Manager。 |
| 409 | `participant_session_managed` | 试图经 Agent HTTP 直接写/删/abort Participant；必须使用房间路由，服务端在副作用前拒绝。 |
| 409 | `participant_delivery_unsupported` | 非 Pi 忙碌时请求 followUp，或当前 native 能力不支持；不写用户事件。 |
| 409 | `room_turn_active` | normal 请求遇到已有公开回合；不写用户 RoomEvent，保留草稿并提示可 followUp/Stop。 |
| 409 | `session_context_inactive` | RoomSession 所在上下文未激活；先恢复项目。 |
| 409 | `message_operation_conflict` | 同键改变 mentions、正文、附件、delivery、预期 Turn 或上下文；禁止自动重发。 |
| 409 | `message_delivery_unconfirmed` | 已有部分持久事实但无法确认 accepted；先刷新时间线核对。 |
| 410 | `room_session_gone` | 已接受操作对应 RoomSession 后来删除；只能由用户明确发起新意图。 |
| 422 | `room_context_too_large` | §21.2 写入前预算检查失败；公开历史零写入，需新会话或后续公共摘要。HTTP 413 只保留给 Fastify bodyLimit。 |
| 428 | `message_operation_required` | 缺 Idempotency-Key。 |
| 503 | `room_recovery_required` / `room_persistence_uncertain` | 房间损坏或写盘结果不确定；封锁该房间写入并恢复，不重试副作用。 |

### 19.5 新房间 WebSocket

新增 `GET /api/rooms/:roomId/sessions/:roomSessionId/ws`，沿用现有同源校验、生命周期门禁和重连快照，不宣称已有房间频道。

```ts
type RoomSocketEvent =
  | { type: "room_ready"; roomId: string; roomSessionId: string; snapshot: RoomTimelineSnapshot }
  | { type: "room_event"; roomId: string; roomSessionId: string; event: RoomEvent; activityRevision: number }
  | { type: "participant_turn"; roomId: string; roomSessionId: string; turn: PublicParticipantTurn; progress?: { code: "starting" | "running" | "waiting_input" | "finalizing" | "reconciling"; at: string } }
  | { type: "execution_projection"; roomId: string; roomSessionId: string; projection: RoomExecutionProjection }
  | { type: "error"; roomId: string; roomSessionId: string; message: string };
```

房间频道不转发 Pi `message_start/update/end`，也不直接转发 assistant 流式文本、thinking 或 tool 参数。progress/summary 只允许服务端白名单的状态/阶段文案；公开 final content 只通过一次 `room_event` 进入历史。重连后以 timeline 快照对齐 event ID、turn ID、projection ID 和 revision。

### 19.6 现有 room 级路由在 v4 下的语义

这些路由不属于 `/api/sessions`，但会随 v4 字段变化，集中在这里定一次，避免各处各说一套。

| 路由 | v4 行为 |
| --- | --- |
| `GET /api/rooms` | 返回房间摘要；group 的 `sessions[]` 改为 `RoomSessionSummary[]`，`activeSession` 改为 `activeRoomSessionId`，`activitySessionId` 改为 `activityRoomSessionId`，新增 `managerParticipantSessionId`。 |
| `GET /api/rooms/:id` | 同上，单房间。 |
| `GET /api/rooms/:id/sessions` | 返回 `{ roomSessions: RoomSessionSummary[], activeRoomSessionId }`；不再返回 pi `sessions/activeSession`。 |
| `POST /api/rooms/:id/sessions` | 新建 RoomSession 走 §21.1（同时创建唯一 Manager PS）；`reuseEmpty` 按 §21.2 判定；Goal 建在已存在的 `managerAgentSessionId` 上。 |
| `DELETE /api/rooms/:id?onlySession=` | `onlySession` 解释为 `roomSessionId`；删除单个 RoomSession 走 §21.4。 |
| `DELETE /api/rooms/:id` | 整房删除：枚举该 Window 的全部 roomSessionIds，逐个执行 §21.4 级联，再删除 Window 与 `chat-navigation` 标记；整房删除不要求“保留最后一个 RoomSession”。 |
| `PUT /api/rooms/:id/read-watermark` | 请求体 `sessionId` 改为 `roomSessionId`；活动 revision 仍来自 §23.1 的投影。 |
| `GET /api/rooms/:id/delegation-processes` | `managerSessionId` 继续指向 Manager PS；新增可选 `roomSessionId` 过滤（§23.1）。 |
| `PATCH /api/chat-navigation/:roomId/:sessionId` | `:sessionId` 对 group 解释为 `roomSessionId`；solo/direct 仍为 `agentSessionId`。 |

## 20. 执行载体与 UI 投影

### 20.1 Pi 与非 Pi 对照

| 行为 | Manager / Pi Worker ParticipantSession | 非 Pi Worker ParticipantSession |
| --- | --- | --- |
| 私有载体 | `PiSessionStore` 原生 AgentSession，`agentSessionId` 可 open | 平台 ParticipantBinding + `providerSessionHandle`；本地 `agentSessionId` 用于归属/准入 |
| 公开回合执行 | 原生 prompt/followUp（内部既有唤醒）+ ParticipantTurn，`execution.kind=native_pi` | `invoker.delegate({invocationKind:"direct_chat", mode:"continue", managerSessionId:agentSessionId, roomSessionId})`，`execution.kind=direct_chat` |
| 私有 UI | 原生 messages/ws，可从房间成员/过程入口打开 | 现有 delegation timeline/process；不伪装原生 Session |
| Stop | `PiSessionStore.abort(agentSessionId)` | `runtime.cancel(delegationId)` |
| Driver 审批 | 保持当前原生 Participant 能力；不伪造 Interaction | `InteractionRecord.delegationId` 指向本次 direct_chat Delegation |
| final 来源 | ParticipantTurn 从原生终态提取 | DelegationRecord 确定终态交给 ParticipantTurn |
| `PiDriver.sessionHandle` | 不作为 ParticipantSession；只在 Manager 原有 delegate 子任务中出现 | Provider handle 可续接 ParticipantSession，但不是平台 agentSessionId |

非 Pi 连续 handle 的函数级权威固定如下：

- `invoker.sessionHandleFor()` 对 group 只读 `sessionRefs[agentSessionId].provider.providerSessionHandle`，并复核 active binding、Workspace、cwd 和 agentRunConfigRevision；不得回退读取 workerBindings 或任意最近 Delegation。
- 首次观察到 handle 时即通过新的 `teams.rememberParticipantSessionHandle()` 做 CAS 持久，不能等 Run completed 才写。现有 Driver 多数只在 boundary result 里返回 `sessionHandle`（`runtime.ts:1009` 的注释），因此顺序是 `started`（若带）→ `input_required`/`completed` 首个可用观测；取消早于观测到 handle 时续接会丢失，这是已知边界，不做补偿猜测。`invoker.rememberSession()` 对 group direct_chat 只能转调该函数，禁止调用 `teams.rememberWorkerSession()`。
- `teams.rememberWorkerSession()` 仅服务 solo/direct，并对 group 显式拒绝，避免 v4 无 `window.sessions` 时 TypeError 被 `.catch()` 吞掉后静默丢续接。
- `DelegationRecord.sessionHandle` 仅是审计快照。启动对账仅在 sessionRefs 缺少 handle 时，从同一 `(roomSessionId,agentSessionId,agentId)` 且 `invocationKind=direct_chat`、Workspace/revision 匹配的最新已启动记录补写；不得使用 manager_tool/verification handle，也不得在正常运行时绕过 sessionRefs。

`direct_chat` 的 `managerSessionId` 是历史字段名，此处表示执行结果所属的 ParticipantSession，不表示 Manager 参与路由。公共可见性统一表述为：

> `manager_tool` Delegation 的结果只回 Manager ParticipantSession；`direct_chat` Delegation 的结果只回目标 ParticipantTurn。任何结果是否进入 RoomSession，都只由 ParticipantTurn 的公共投影决定。

因此非 Pi direct-chat 不再自动执行“把 `pudding:task_result` 写回 Manager”的旧展示动作；私有适配记录可以保留，但房间 UI 和公共上下文只读投影结果。

### 20.2 停止、失败与 partial output

- native abort 或 Runtime cancel 只改变执行状态，不直接删除已经公开的 user RoomEvent。
- ParticipantTurn 先持久 `status=cancelled/failed` 与 `terminalReason`；只有终态明确是用户可读的 final content 才写 `kind=message`。
- partial streaming text 不自动作为 final。若现有 NormalizedResult 明确携带可公开部分正文，则可作为 finalContent 保存，但事件仍带真实 cancelled/failed 终态；否则只写简短 `kind=terminal`。
- `observation_lost/effect_unknown` 不自动重试、不伪造 cancelled，ParticipantTurn 进入需要人工对账状态并保留执行入口。

### 20.3 RoomExecutionProjectionService

这是派生服务，不是第四个事实源：

```ts
interface RoomExecutionProjection {
  projectionId: string;
  roomSessionId: string;
  participantTurnId: string;
  kind: "delegation" | "interaction" | "goal" | "participant_status";
  status: string;
  summary: string;
  delegationId?: string;
  interactionId?: string;
  processRef?: { kind: "agent_session" | "delegation_timeline"; id: string };
  revision: number;
}
```

来源：

- Manager 公开回合的 `ParticipantTurn.delegationIds` + DelegationStore/InteractionStore 生成既有内嵌委派卡与审批卡；delegate 接单时把 ID 关联到当前 activeTurn，不修改 Delegation 的 fresh/结果归属。
- 非 Pi 公开回合由 `ParticipantTurn.execution.delegationId` 生成运行/审批状态。
- Goal outbox 继续向 Manager PS 追加原有 `pudding:work_plan_update`；同一事件按 eventId 派生房间 UI 投影。重启由 WorkState/outbox 恢复，不把 Goal 卡写进 RoomEvent。
- ParticipantTurn 提供 native Pi 的状态和私有 `agentSessionId` 过程入口。

`summary` 只含 UI 安全字段；完整 toolResult、providerState、凭证和原始错误堆栈不进入投影。活动/未读服务可以消费这些稳定 projection ID，但模型上下文永远不能。

## 21. 建房、新建会话、首条消息、Fork 与删除事务

### 21.1 创建 group / 初始 RoomSession 与 Manager PS

每个 RoomSession 同步创建且只创建一个 Manager PS；不创建任何 Worker SDK Session，因此不会启动 N+1 个 Worker 运行时：

1. 校验 members、Workspace、Manager 可用性和创建 operation requestHash。
2. `RoomSessionCreationOperations.reserve()` 同时固定 `roomSessionId` 与 `managerAgentSessionId`，记录 `manager_created` 所需的精确清理身份。
3. 创建并同步空 `events.jsonl` 与父目录，记录 `event_file_created`。
4. 按 §17.5 以显式 `ownerAgentId=manager` 和预留 `managerAgentSessionId` 创建 Manager 原生 Session；此时仍不创建 Worker ParticipantSession。
5. 在一次 windows v4 原子写中创建/更新 Window、RoomSessionRef、`roomSessionIds/activeRoomSessionId`、Manager ParticipantBinding 和对应 sessionRef，记录 `manager_bound`。
6. 标记 attached。windows 写前确定失败只回滚账本对应的空事件目录和预留 Manager JSONL；rename/目录同步结果不确定时保留现场并启动对账，不盲目删除。
7. attached 后即使首条消息失败，空 RoomSession 与 Manager PS 也保留，用户可重试；不自动删房或重复建房。

若创建 RoomSession 时同时请求 Goal，在 attached 后直接使用已经存在的 `managerAgentSessionId` 调 `workStates.create({sessionId: managerAgentSessionId,...})`，Goal operation 单独幂等。Goal 创建失败不删除已 attached 的空房间；同键重试读取 Goal/WorkState 与创建账本，不新建第二个 RoomSession 或 Manager PS。空房间 timeline 的 `managerParticipantSessionId` 因而始终非空。

`create_group_window` 的可选 task 在 attached 后作为独立 RoomMessageOperation 发送，操作键由创建键派生。任务失败保留房间和草稿/错误状态，不触发房间补偿删除。

### 21.2 新建 RoomSession 与第一条公开消息

新建 RoomSession 同样执行 §21.1，包括新的 Manager PS。`reuseEmpty` 必须同时确认：无 RoomEvent、无 ParticipantTurn、无 Goal、无活动运行、未归档，不能只读 Pi messages。

第一条及后续公开消息按以下顺序，**已接受操作恢复先于 active 锁判断**，避免原键重试被 `room_turn_active` 误拒：

0. 以 operationKey 查询 RoomMessageOperation；若已 accepted，核对 user RoomEvent、ParticipantTurn 和 Binding 后直接回放，不检查当前 activeTurn，也不再次执行。
1. reserve RoomMessageOperation，校验目标、delivery 和上下文；新 normal 回合才检查 activeTurn，当前 Turn 的 followUp 按 §22.2 处理。**同一步为目标 Participant 预留 `agentSessionId`**：Manager 使用已有 binding；Worker 首次被定向时生成并写入消息账本（§17.5），后续步骤不再换 ID。
2. 按 roomSessionId 冻结附件，不使用 solo 的 `internalFirstWorkFreezeToken`；以原始用户正文/附件调用 `knowledgeIntakes.prepare`，`sessionId` 必须传 step 1 预留的 `agentSessionId`（intake 记录按它绑定并校验，见 `chat-intake.ts` 的 `prepare/bind`），operationId 与后续 `sourceRoomEventId` 绑定，不能用拼接后的房间上下文代替原始来源。
3. 用尚未提交的 prospective RoomEvent 生成“公共历史增量 + 当前用户消息”的唯一执行输入，并在任何 RoomEvent、ParticipantTurn、ParticipantBinding 写入前做上下文预算上界检查。超限返回 422 `room_context_too_large`，按操作账本清理未接受冻结附件，公开历史零写入。
4. 追加并同步 user RoomEvent，再持久 ParticipantTurn，固定 `participantTurnId/agentSessionId/context cutoff/inputHash`；两文件间的中断由消息账本恢复，不能生成第二个用户事件。
5. Manager 使用已存在 binding。Worker 首次被定向时，按 §17.5 以预留 agentSessionId 和显式 Worker owner 创建原生 Session（Pi）或本地 Participant 容器（非 Pi），再登记 ParticipantBinding/sessionRef；已有 binding 复核 revision 和续接资格。原生 JSONL 已建但 binding 未写的孤儿按 §17.5 和 §18.4 对账。
6. 按 §22.2 一次性写入/投递组合输入；只有确认输入已持久且 ParticipantTurn 已存在后才推进 binding 水位并标记 accepted，随后按真实 native/direct_chat 状态继续执行。
7. 原生 Provider 发送前保留 `armManager` 的同等准入 fence（泛化为 armParticipant）：核对本次组合输入、原始 sourceRefs、冻结字节和 JSONL 同步；非 Pi direct-chat 保留 `admitDirect`。准入失败按真实阶段恢复，不能跳过知识素材绑定。
8. 执行终态经 ParticipantTurn outbox 投影 final。

第 4–6 步失败可原键修复，不能新增第二条 user RoomEvent 或重复组合输入。Manager 配置在房间创建后损坏时，在 ParticipantTurn 上形成明确 failed 终态；用户消息已经公开，不能假装不存在。若预算复核因运行前配置变化再次超限，同样落 failed，而不是返回“公开历史零写入”的 422。

用户 RoomEvent 一旦落盘，第 4–6 步的任何确定性失败都返回 409 `message_delivery_unconfirmed` 并要求客户端刷新时间线核对，不得返回 `participant_unavailable` 之类让客户端误以为未发送、从而换键重发的错误；只有 step 1–3 的写入前校验可以使用 4xx 拒绝。

RoomSession 自动标题取第一条用户 RoomEvent 的可读正文；LLM 标题若保留，只能回写 RoomSessionRef.generatedName，不能写 Manager PS 的 sessionName。展示标题固定为 `customName ?? generatedName ?? 首条消息摘要`，自动标题不得覆盖用户改名。`firstMessage/modifiedAt/lastMessagePreview` 从 RoomEvent/活动投影派生。

### 21.3 RoomSession Fork

新增：

```http
GET  /api/rooms/:roomId/sessions/:roomSessionId/fork-targets
POST /api/rooms/:roomId/sessions/:roomSessionId/forks
```

- 只复制指定 cutoff 的公共 RoomEvent 和来源 manifest，生成新的 roomSessionId；附件字节进入带 SHA-256 校验的独立快照资产，目标不得继续引用可随源删除的活路径；
- 新 RoomSession 不复制既有 ParticipantBinding、ParticipantTurn 私有过程、活动 Goal、审批或 Provider handle；目标创建事务仍按 §21.1 同步创建新的 Manager PS，Worker 首次被定向时再懒建；
- 原 RoomSession 有活动公开回合时拒绝 Fork；
- Fork 操作沿用现有 `reserved → snapshot_saved → session_saved → attached` 账本模式，但 `session_saved` 此处指空目标 RoomSession 和新 Manager PS 已建立，不调用 SDK `forkFrom`；
- 私有 Agent Session 沿用现有“快照导入目标 Worker direct Window”流程，产物是独立单聊，不是原房间内 ParticipantSession 复制；与 RoomSession 公共 Fork 的入口和来源展示不得混用。

### 21.4 删除、归档与重命名

- 归档只改 ChatNavigation 的 roomSessionId 标记，不停止执行、不删除任何 Session。
- 重命名只写 RoomSessionRef.customName，不写 Participant JSONL，也不覆盖 generatedName。
- 删除先封锁新公开回合，复用现有 close/cancel 能力收敛 activeTurn、Manager Delegation、待审批和待确认输入；未知副作用保留恢复错误，不继续物理删除。
- 确认收敛后删除 events/turns/operations，并删除本 RoomSession 独占的 ParticipantBinding 与原生 Agent JSONL。共享或被其他 Room 引用的 Agent Session 不得删除。
- 非 Pi Driver SPI 没有 delete-session：只废弃本地 ParticipantBinding/provider handle 引用并保留必要审计，不能宣称远端会话已删除。
- 仅在这个显式 RoomSession 删除事务中，才对该 RoomSession 的 `managerAgentSessionId` 调用 `workStates.removeSession()`，级联删除其 Goal/Decision/outbox；Participant 的 Agent HTTP DELETE 永远不得触发此动作。
- 删除 UploadStore 以该 roomSessionId 为命名空间的冻结附件及不再被引用的本地副本；Fork 已生成的独立快照资产不受影响。附件或 WorkState 清理失败必须返回恢复错误并保留对账记录，不能报告完整删除成功。
- DelegationRecord、InteractionRecord、Receipt、ChangeSet 和 delegation timeline 保留为只读审计，写入 RoomSession 删除 tombstone，不能用于新接单；其来源 ParticipantSession/Provider handle 已删除或废弃时，过程 UI 明确显示来源已删除，不自动补建。
- group 最后一个 RoomSession 仍拒绝单独删除，需显式删除整个 Room。

## 22. Participant 装配、公共上下文与 session_read

### 22.1 工具与提示词清单

| 装配项 | Manager ParticipantSession | Worker ParticipantSession |
| --- | --- | --- |
| Agent 自身运行指令/piResources/Skills/templates | 是 | 是 |
| 当前 RoomSession 的 Workspace context/trust/cwd | 是，从 RoomSessionRef 解析 | 是，同一来源 |
| read/ls/grep/find/edit/write/bash 与 codeSearch | 按现有 Manager/Harness 配置 | 按现有 direct Worker/Connector/Harness 配置 |
| MCP / Capability / knowledge / web | 按 Manager 自身授权 | 按 Worker 自身授权，与 direct 对齐 |
| `session_read` | 读 RoomSession 公共历史及现有允许读取的非 Participant Agent Session；不能读其他 ParticipantSession | 读 RoomSession 公共历史及被明确授权的非 Participant 会话；不能读其他 ParticipantSession |
| roster、delegate、create_group/invite | 有，delegate 仍限当前群成员 | 无 |
| Goal/WorkPlan/Decision 控制 | 保持现有 Manager 能力 | 无 |
| 群聊协作 prompt | 保持 Manager 私有 | 不注入 |
| 其他 Participant 的私有历史/toolResult | 无 | 无 |

Worker 的写工具不是默认关闭的新特权面，而是与它在 direct 中相同的 Connector/Harness 配置；公开回合不会自动获得 Manager 的 Workspace 或知识授权。实现必须同步 `2026-10-15-工具装配与暴露清单及分级配置评估.md`，不能只写“不新增 Manager 工具”。

### 22.2 单次组合输入、注入幂等与水位

**选择“公共历史增量 + 当前用户消息合成一条 user message”方案，不另写独立 `pudding:room_context` custom_message。** Pi 通过一次 `prompt/followUp` 写入该组合输入；非 Pi 通过同一文本作为 direct-chat `message`。这样不存在“先写上下文、再写当前 user”两次写入之间的重复注入窗口，也不需要新增 customType。

组合输入模板如下，作者和 mentions 作为文本事实进入 user message，不覆盖 Agent system prompt，也不塞进 Manager roster：

```text
[房间公共历史｜roomSessionId=<id>｜through=<roomEventId/seq>]
仅包含面向房间的最终发言、必要终态和公开产物；不是任何成员的私有执行记录。

[房间消息｜用户 → @WorkerA｜event=<id>]
请检查当前方案。
附件：方案.pdf（application/pdf，sha256=<hash>）：<冻结路径>

[房间消息｜Manager｜event=<id>]
已形成综合方案如下：……

[房间消息｜WorkerB｜event=<id>]
风险主要有两点：……

[房间终态｜WorkerA｜event=<id>]
本次执行已取消；未发布最终回复。

[当前用户消息｜用户 → @你｜event=<id>]
请基于上述公开内容继续检查。
```

每个 `ParticipantTurn` 有一个 initial input；followUp 在同一个 Turn 下追加独立 `ParticipantInput` 子记录，而不是修改原始 inputHash：

```ts
interface ParticipantInput {
  operationId: string;
  sourceRoomEventId: string;
  contextFromAfterRoomEventId?: string;
  contextThroughRoomEventId: string;
  inputHash: string;
  delivery: "normal" | "followUp";
  agentUserEntryId?: string;
  persistence: "pending" | "durable";
}
```

幂等与水位按以下顺序执行：

1. ParticipantTurn/ParticipantInput 先持久，固定事件范围、组合文本、附件摘要和 inputHash。重试永远使用这份输入，不吸收后来事件。
2. Pi 使用 `ParticipantInput.operationId` 调用原生 prompt/followUp，并沿用 `pudding:message_admission{operationId,requestHash,contextHash,userEntryId}` 绑定唯一组合 user entry（marker 现要求 `contextHash`，房间取 `hash(roomId+roomSessionId+workspaceId+cwdSnapshot)`）；非 Pi 使用同一 operationId 创建/恢复唯一 direct_chat Delegation，其 requestHash 覆盖同一 inputHash。房间消息的公共事实以 `RoomMessageOperation` 为准，NativeInput/`MessageSubmissionOperations` 只作执行回执，两者按 `operationId` 关联；`accepted` 要求两者在各自阶段都 durable。
3. **只有组合 user entry 已在 Agent JSONL 落盘并确认，或 direct_chat 已持久接单后，才通过 windows v4 CAS 把 `lastRoomEntryId` 推进到本次 `contextThroughRoomEventId`。** ParticipantInput 必须已先持久；推进前复核 binding revision 未漂移。
4. 若崩溃发生在“输入已落盘、binding 水位未推进”之间，重试先按 operationId/inputHash/userEntryId 或 direct_chat operationId 找到既有输入，只补推进水位，禁止再次 prompt/delegate。水位更新失败不改变已经持久输入的事实，但也不得提前标记 accepted。
5. 注入/启动失败前没有持久输入时，binding 水位不动；失败不回滚已确认水位。后续新 Turn 从该位置重建增量，不会跳过未进入执行输入的公共事件。
6. 当前 sourceRoomEventId 随组合输入确认后自然成为新水位。自己的 final RoomEvent 只有在 final 已存在于原生 assistant/Provider 历史且公共投影落盘后才能推进到该 final event；失败/取消 terminal 未明确注入时不推进，留待下一回合补读。
7. followUp 使用新的 ParticipantInput/operationId 和独立 RoomEvent，复用 NativeInput 的 pending/durable 观察；只有该 followUp 的真实 user entry 落盘后才推进到 followUp event。不得用“SDK 已排队”冒充已消费，也不得重复追加到原 Turn 的 initial input。
8. **Turn 终态化条件**：native run 已空闲（prompt 全部 settle）且该 Turn 无 `pending`/`durable` 的 followUp 输入、无待处理 Interaction 时，才能按 completed/failed/cancelled 终态化并投影 final。仍有排队输入时 Turn 保持 active，`room_turn_active` 继续生效；不得先 completed 再接收 followUp。

当前目标的原生图片 input 从已验证冻结字节生成；历史图片只给受控路径/媒体信息，避免把整段 base64 反复注入。非 Pi 与 Pi 使用完全相同的组合文本，不能退化成只给 session_read 链接。上下文预算同时计算公共历史、当前附件说明、Agent 指令和保留输出空间；§21.2 的写入前检查超限返回 422 `room_context_too_large`。

final content 的原生提取规则固定为：取本次 ParticipantTurn 在工具/委派全部收敛后，**最后一条非空 assistant 文本**；工具间文本和中间进度不取。`stopReason=error/aborted`、输出截断、空最终文本或模型轮次不完整时按真实 failed/cancelled 处理，不得把最后一段中间文本包装成 completed final。非 Pi 使用 NormalizedResult 的同等终态文本。

### 22.3 session_read 与深链

`session_read` 对 group 的协议改为：

```ts
session_read({
  ref: "/chats?room=<roomId>&session=<roomSessionId>",
  afterSeq?: 0,
  limit?: 50
})
```

返回 `{roomId, roomSessionId, events, afterSeq, nextSeq?, throughSeq}`；每个 event 保留 actor、mentions、attachments/artifactRefs 和终态，不包含 Participant 私有 tool trace。

授权：

- 当前 Room 成员可读本 RoomSession 公共历史；跨 Workspace 仍拒绝；
- group 链接中的 `session=` 只表示 RoomSession；
- 其他 ParticipantSession 的 agentSessionId 不出现在授权扫描白名单中，Manager 也不能借“同窗口自由读”读取 Worker 私有历史；
- 对 solo/direct 的既有 Agent Session 授权规则不变；跨窗口“引用即授权”不自动扩展到 Participant 私有 Session；
- 需要共享执行过程时，后续使用显式 delegation/process 授权，而不是伪造一个 RoomSession 链接。

### 22.4 模型与思考强度

- composer 在无 mentions/Manager mention 时编辑 Manager ParticipantSession；定向 Worker 时编辑该 Worker ParticipantSession。
- Pi 使用现有 Session `model/thinking-level` 记录；非 Pi 使用 `worker-runtime-model`，由 ParticipantBinding 校验目标而不是 direct Window。
- 非 Pi 的 `agentSessionId` 必须对应已注册 sessionRef 且可 `PiSessionStore.open()` 的本地 Participant 容器，覆盖值持久为该 JSONL 中的 `pudding:worker-runtime-model` custom entry。`workerModelContext/workerRuntimeModel/setWorkerRuntimeModel` 经统一 resolver 找到 owner 和 ParticipantBinding，不得对合成 ID 直接 open，也不得把覆盖写进 ParticipantBinding 或全局 Connector config。
- 所有覆盖只影响当前 `agentSessionId` 的后续运行，不写 Agent 全局配置，也不改变其他成员。
- ParticipantBinding 不复制第二份模型真值；timeline participants 从对应 Agent Session/provider 设置投影。

## 23. 跨切面契约与实施顺序

### 23.1 活动、未读、搜索、导航与来源映射

| 切面 | 确定实现 |
| --- | --- |
| 活动/未读 | `RoomActivityProjector` 增加 RoomEvent + ExecutionProjection 输入。用户自己的消息/审批回答不制造未读；Agent final/terminal/artifact、待处理 interaction、Delegation 终态和 Goal 更新可推进活动/未读。`activityRevision` 仍由去重后的持久业务事实 digest 计算，而非只取 lastSeq；客户端呈现完整 timeline 后确认同一 revision。 |
| 房间摘要 | `buildWindowSummary` 对 group 改读 RoomSessionStore/投影，不再 `sessions.open(roomSessionId)`。返回 `roomSessionId/activeRoomSessionId/activityRoomSessionId/managerParticipantSessionId`；firstMessage、modifiedAt、preview 按 §21.2。 |
| 全局搜索 | 公共消息索引 RoomEvent 内容与作者，执行记录仍独立索引；Participant 私有内容不因加入房间进入公共搜索。结果深链定位 roomSessionId，可选 eventId。 |
| pin/归档/导航 | `ChatNavigationStore` 的 group 键统一改 roomSessionId；ParticipantSession 不生成独立侧栏项。路由恢复、草稿、阅读位置也按 roomSessionId，私有 inspector 另带 agentSessionId。 |
| 知识来源 origin | `ChatSourceRefs` 对 group 同时保存 `roomSessionId + sourceRoomEventId + agentSessionId + windowId`。来源页面链接指向公共 RoomEvent；`sessionAvailable` 对 group 查 RoomSessionStore。执行/素材绑定仍使用真实 agentSessionId，不能用 RoomSession 代替模型输入身份。 |
| worker-process | 继续接受 `managerSessionId=<managerParticipantSessionId>` 查询 Manager 子任务；另接受 `roomSessionId` 查询本房间公开 ParticipantTurn/direct_chat 执行。API 响应显式返回两类 ID，前端不靠名称猜。 |
| Goal outbox | Manager PS 仍是工作事实与私有卡接收者；`index.ts` 的 outbox drain 同步调用 RoomExecutionProjectionService，以同一 eventId 去重，不写 RoomEvent。 |
| 删除/重命名 | 按 §21.4 级联，不再调用 `sessions.remove(roomSessionId)` 或 `rename(roomSessionId)`。 |

### 23.2 先做垂直切片，再切 v4

不先改生产 windows.json。先在测试夹具/实验分支完成一个不承载历史兼容的垂直切片：

1. `RoomEventStore + RoomContext`：临时目录、seq/cutoff、附件渲染和 final 投影纯单元测试，不接生产路由。
2. 使用内存 ParticipantRegistry，不动 v3：Pi Worker 通过 §17.5 的显式 owner + 预留 agentSessionId 创建原生 ParticipantSession，验证原生历史可打开、abort、模型覆盖与 final 提取；`PiDriver.sessionHandle` 不参与。断言 Worker 工具面没有 roster/delegate/Goal 控制，不能退化成第二个 Manager。
3. 非 Pi 使用现有 mock Driver + `direct_chat` Delegation，验证 continue、Interaction、cancel 和 sessionRefs 单一 handle 权威；断言结果只经 ParticipantTurn 投影。
4. 只实现 `@WorkerA 直达 + final RoomEvent + 房间时间线`，Manager/Goal/未读仍走旧路径；不做生产双写，不把实验状态变成兼容层。
5. 可观测断言：Manager driver/prompt 调用计数为 0、Worker 收到指定 cutoff、私有 toolResult 不在 RoomEvent、同 operation 只有一次 final、组合输入重试不重复。

垂直切片验证 §17/§20 的载体选择后，按以下顺序实施：

```text
P0-A 垂直切片
→ P0-B v4 schema + resolver + prune/启动校验
         + /api/rooms 新摘要 + 最小 timeline UI（同一切换单元）
→ P0-C 创建/消息/投影账本与启动对账
→ P1 公共消息、Participant 续接、房间 API/WS、UI @、final 时间线与同 Turn followUp
→ P2 活动/搜索/导航/Fork/Goal/知识来源/删除与真实故障旅程
→ P3 多 @、非 Pi 持久排队、公共摘要、显式过程分享
```

P0-B/P0-C/P1 在同一集成分支推进，**P0-B 不允许作为独立可用构建合入或发布**。最小房间摘要和 timeline UI 必须与 v4 字段切换同时可用，不能接受 `window.sessions/activeSession` 已删除而前端仍读旧字段的中间态；P2 的搜索/未读等增强不能反向成为 P0-B 破坏现有页面的理由。

P0 出口除了 §12 原要求，还必须满足：

- 27 条现有 Session 路由在 group 下都有 §19.1 的明确调用方和 ID 类型，Participant 写路径 fail-closed 有真实反例；
- 前端不存在把 roomSessionId 传给 `PiSessionStore.open()`、`/api/sessions/:id/messages|ws|model` 的路径；房间摘要与最小 timeline 同构工作；
- 新建 group/RoomSession 同步创建唯一 Manager PS 且不创建任何 Worker SDK Session，空 timeline 的 managerParticipantSessionId 非空，Goal 创建后房间可用；
- 首条消息可原键修复且不重复 RoomEvent/组合输入，Worker owner 装配无 roster/delegate；
- v4 重启不丢 active/retired ParticipantBinding，prune 与 owner 校验有定向反例。

### 23.3 测试矩阵补充

- owner 与载体：显式 Worker owner + 预留 agentSessionId 创建时，工具面不含 roster/delegate/create_group/invite/Goal 控制；原生 messages/ws 可打开，Stop 调 abort；非 Pi Stop 调同一 direct_chat delegation cancel，Interaction 恢复不换 delegationId/agentSessionId。
- Manager 时序：空房间 timeline 的 managerParticipantSessionId 非空且唯一；Goal 创建后立即可读，未创建任何 Worker SDK Session；Manager 配置损坏有明确错误而非回退成另一个 Manager。
- handle 权威：Driver started 即 CAS 写 sessionRefs；group 不调 rememberWorkerSession、不写 workerBindings；正常运行只从 sessionRefs 续接，审计 Delegation 仅在启动对账中按同身份补写。
- Participant HTTP fail-closed：直接 DELETE/messages/abort/queued-input 均返回 409 且无 store/WorkState 副作用，特别断言 Manager Goal/Decision/outbox 仍存在。
- resolver/prune：82 处现有调用方保持原契约；Participant 可解析，RoomSession 被三个 Agent resolver 明确拒绝；v4 写盘/重启后 active/retired Binding 与 sessionRef 均存在，退役 JSONL 仍可按 owner 只读打开。
- 孤儿与事务：逐点注入 reserve、empty events、Manager JSONL 已建未 binding、Worker JSONL 已建未 binding、windows rename、ParticipantBinding、user event、组合输入、turn final、RoomEvent projection 前后的进程退出；同键恢复不重复、不虚构成功。
- 预算：422 在 RoomEvent/Turn/Binding 写入前返回且冻结附件按账本清理；HTTP 413 只来自 bodyLimit；运行前配置变化导致二次超限只能落 Turn failed。
- 注入与水位：ParticipantInput 先于水位；组合 user entry/direct_chat 已持久但水位未写时，重试只补水位不重复 prompt/delegate；失败不回滚已确认水位，也不提前推进。
- followUp：Manager 长 delegation 中可追加到同一 Turn；目标变化、非 Pi 忙碌和 steer 均拒绝且不写事件；已接受原键回放先于 active 锁，queued cancel 走房间路由。
- 未知 Turn：无 live Run/Interaction 时可由用户 close-unknown 解除 `room_turn_active`，状态为 interrupted_unknown，不能展示成远端 cancelled。
- API/摘要：27 条路由用 roomSessionId 调用不会误开 Agent Session；mentions/delivery/预期 Turn 进入 hash；房间摘要与最小 timeline 在 v4 切换同一步可用，空摘要字段完整。
- WS：无原生 message_start/update/end，也无 assistant 流式文本/thinking/tool 参数；progress 只有白名单状态码；final 只出现一次，重连与迟到事件不回滚终态。
- final 提取：多条 assistant 只取工具收敛后的最后一条非空文本；error/aborted/截断/空最终文本不得投影 completed。
- 非 Pi 模型：worker-runtime-model 写入本地 Participant JSONL，重启后可读且只影响对应 agentSessionId；ParticipantBinding 和全局 Connector config 无第二份覆盖。
- 工具/权限：Worker 无 roster/delegate/Goal 控制，Workspace/知识/MCP/web 与自己 direct 一致；其他 Participant 私有 JSONL 不可经 session_read 读取。
- 活动/来源：执行投影可产生未读但不进模型上下文；知识 prepare/armParticipant/admitDirect 均发生在正确边界，origin 能回跳公共 event，worker-process 区分 roomSessionId 与 managerParticipantSessionId。
- 删除级联：RoomSession 删除覆盖 events/turns/operations、Participant JSONL、Manager WorkState/Goal/Decision/outbox 和 roomSessionId 附件；保留 Delegation 审计与 tombstone，清理失败不报告成功。
- 使用 `invoker.fanout.test.ts` 的 mock Driver/group 夹具，不为非 Pi 路径另造测试框架；真实验收仍按 §13 的 server/web/runtime 命令执行。

文档同步清单在 §14 基础上增加：

- `docs/2026-10-16-会话深链交接方案.md`：group session_read 与深链新语义；
- `docs/2026-08-30-Teams内部HITL与Worker执行权限方案.md`：direct_chat 公开回合的 Interaction/取消归属；
- `docs/2026-10-27-速记收件箱与定期整理方案.md`：知识来源 origin 的 RoomEvent 身份；
- `docs/2026-10-15-工具装配与暴露清单及分级配置评估.md`：Participant 工具面是必改项，不再视为可选同步。

## 变更记录

| 日期 | 变更 | 说明 |
| --- | --- | --- |
| 2026-10-31 | 初版 | 产品模型与领域决策，§0–§15。 |
| 2026-10-31 | 第二轮回写 | 新增 §16–§23：Q1–Q14 实现决策、身份/解析、v4 schema、API/WS、执行载体、事务、装配、跨切面与测试矩阵。 |
| 2026-10-31 | 第三轮收敛 | 明确 Part I/Part II 职责；§4/§6.2/§8.1/§10.3 改为原则与指针；`ParticipantBinding` 增加 `revision`；`RoomMessageOperation` 与 NativeInput 的账本关系、intake 的 sessionId 顺序、followUp 的 Turn 终态条件、room 级路由语义补入 Part II；修正 §13.1 的唯一键表述。 |
