# 可证明协作协议与 Teams HITL 全量测试报告

> 执行日期：2026-08-31  
> 测试依据：`docs/2026-08-30-可证明协作与Teams-HITL全量测试Prompt.md`  
> 测试方式：Google Chrome + Computer Use，辅以本地状态文件/API/日志取证  
> 数据隔离：`PUDDINGTEAMS_HOME=/Users/pet/.puddingteams-e2e-test`  
> 恢复崩溃后的续测目录：`PUDDINGTEAMS_HOME=/Users/pet/.puddingteams-e2e-test-2`（仅复制连接/认证/Worker 配置，状态从空白开始）  
> 停止/重启专项续测目录：`PUDDINGTEAMS_HOME=/Users/pet/.puddingteams-e2e-test-3`（仅复制连接/认证/Worker 配置，状态从空白开始）  
> 修复后重新执行目录：`PUDDINGTEAMS_HOME=/Users/pet/.puddingteams-e2e-fixes-fresh`（独立状态，R01–R09）  
> R03/R05 最终收口目录：`PUDDINGTEAMS_HOME=/private/tmp/puddingteams-e2e-r03-r05`（独立状态，最终回归）  
> 测试工作区：`/Users/pet/Code/AI/Agent/PuddingTeams-e2e-target`

## 执行环境

- 分支：`codex/e2e-pcp-persistent`
- 前端：`http://localhost:8934`
- 后端：`http://127.0.0.1:8933`
- Manager 默认模型：`deepseek/deepseek-v4-flash`（UI：DeepSeek V4 Flash）；独立证据 Reviewer 同样改为该模型
- 结果状态：修复前全量基线已完成并保留；修复后 R01–R09 最终均已收口为 PASS。R03/R05 的最后一轮通过本地真实服务/API 驱动，并用 Session 消息、WorkState、Delegation timeline 和目标文件交叉取证。

## 修复后 R01–R09 重新执行状态（2026-08-31）

本报告下方的 **9 PASS、17 FAIL、1 SKIP 是修复前基线**，必须保留作缺陷发现证据，但不能据此声称当前代码已经通过。修复后采用 `docs/2026-08-30-可证明协作与Teams-HITL全量测试Prompt.md` 的 R01–R09 在 fresh Home 上重新执行；只有真实 GUI、持久化状态和文件系统证据同时成立才记 PASS。

| 场景 | 当前结果 | 权威证据/未完成项 |
| --- | --- | --- |
| R01 Goal→WorkPlan→动态 Worker→验收 | PASS | 同一 Manager Session 紧接创建 Goal/WorkPlan；新建 `e2e-dynamic` 后立即可调用；两项 Submission 经 manager evidence 接受，Goal revision 14 完成。截图：`evidence/R01-goal-workplan-dynamic-worker-complete.jpeg` |
| R02 isolated commit/Receipt/promotion | PASS | fresh Home 中真实 isolated checkout 写入、Git commit、Artifact/hash、sealed Receipt、验收和受控 promotion 全部闭环；Worker 未直接写目标 checkout。截图：`evidence/R02-isolated-worktree-receipt-promotion.jpeg` |
| R03 auto_on_submission 唯一 Verification | PASS | 最终 Session `01a057bc-77f1-733a-99ae-c0a3041026ab`、Goal `21b5de9a-6435-49ba-80ea-c9f1fcd813ec`。Submission `1ab0e41a-4ad8-4d8f-8489-19860bbf7222` 后平台自动创建且仅创建 1 条 VerificationRecord `verification:1ab0e41a-…:auto-verification:1ab0e41a-…`，状态 `passed/clean`，Reviewer 为 `deepseek/deepseek-v4-flash`；证据引用同一 Submission、Delegation `b022d2e6-…`、change-set `7e7ab75e-…` 和只读 observations。Manager 被稳定事件自动唤醒并把 Settlement 置为 `accepted`；Goal 终验引用 `prepared-final-report:21b5…:1` 后 `passed`，Goal revision 9 为 `resolved`，最终消息真实发出三轴汇总。旧截图 `evidence/R03-auto-verification-single-run.jpeg` 保留为修复前失败证据。 |
| R04 admission 取消/继续/改派及重启恢复 | PASS | 取消：原 Worker 从未启动且 `admission_rejected`；继续：`workerStarted=true`、`readOnlyAssessment=unverified_user_accepted` 并完成；改派：卡片待决时重启后端，恢复同一 Interaction，原 codex `workerStarted=false`/cancelled，仅创建一个 `parentDelegationId` 指向原任务的 Codex Verifier replacement，`readOnlyAssessment=verified` 并完成。截图：`evidence/R04-admission-continue.jpeg`、`evidence/R04-admission-restart-replace.jpeg` |
| R05 Worker 原生业务 HITL A/B | PASS | 最终 Session `01a057af-cca4-7f78-9d1e-a629db301268`、Goal `c419c0b8-83a4-440f-91d8-da491256cdf1`。平台只创建 1 个 WorkItem、1 个 Delegation `d0305a2c-9c55-4f6e-9370-b100431c1dee` 和同一上游 Run；Interaction `943a7f0f-70c3-42ad-872a-c16fa1ccb911` 为 `kind=question`，保留业务选项原值 A/B。提交 B 后以同一 Delegation/Run 结构化 respond 续跑，没有 permission scope、followup 或 replacement；目标 Workspace 文件 `docs/e2e-regression-hitl.md` 内容为 `所选值: B`。唯一 Submission 由 manager review 接受，Goal revision 11 为 `resolved`。旧的三张截图继续保留为修复前缺陷证据。 |
| R06 Stop/epoch fence | PASS | GUI 中真实启动约 60 秒 Worker，并在运行时点击 Manager“停止”。Goal `5de35609-2d19-43c4-9be4-8e80bf38b77e` 的 epoch 从 1 推进为 2，状态持久化为 `interrupted/manager_interrupted`；旧 epoch Delegation `39f6b5be-0dc4-4da9-b0a3-d8185ccbe41a` 被取消，后续 `wi-2` 保持 planned 且无 Delegation。等待迟到结果后，Goal 未复活、下游未启动。由于 PuddingClaw 不支持远端 reconcile，停止后的安全租约按设计 fenced；再通过 UI“重新对账原 Run”并输入理由完成“确认终止并人工接管”，租约最终 released。截图：`evidence/R06-stop-epoch-fence.jpeg` |
| R07 外部目录错误与草稿保留 | PASS | UI 显示 Workspace 越界错误，输入框保留原始草稿。截图：`evidence/R07-external-directory-error-draft-preserved.jpeg` |
| R08 返工追加已有草稿 | PASS | 追加 Worker 名与 delegationId，不自动发送，焦点留在 composer。截图：`evidence/R08-rework-appends-existing-draft.jpeg` |
| R09 公共边界递归脱敏 | PASS | 普通文本、嵌套对象、数组、JSON 字符串均保留结构且只将假 secret 替换为 `[redacted]`；state/timeline/result 无输出泄漏。截图：`evidence/R09-redaction-final-pass.jpeg` |

当前自动证据：最新 `apps/server pnpm test` **430/430 PASS**，`apps/server pnpm typecheck` PASS；PuddingClaw backend 定向测试 **48/48 PASS**，部署 CLI 全量 **63/63 PASS**。此前 server/web/docs typecheck、两套 lint、web/docs production build 与 `git diff --check` 均 PASS。新增回归覆盖平台执行快照/Observation/change-set 作为独立证据、自动复验稳定唤醒、旧 `reviewMode` 推导、PuddingClaw 结构化业务问答和待发送最终报告证据。

| 缺陷 | 修复结果 | 回归证据 |
| --- | --- | --- |
| D01 | 默认 Worker 创建时写入 `extensionRevision: 1` | Teams/agent route 测试、最新 423 项 server 全量测试 |
| D02 | nested Git 检查跳过 Git ignored 目录/符号链接 | `workspace-execution.test.ts` 新增 ignored `node_modules` 用例 |
| D03 | 测试环境已解锁 | Computer Use GUI 回归正常执行 |
| D04 | timeline 在持久化边界递归脱敏敏感 key、Bearer、`sk-*` 与嵌套文本 | timeline store 测试直接检查原始 JSONL 不含 secret |
| D05 | Agent 新建/更新响应等待 Session 工具注册同步，旧 Session 下次打开按新 revision 重建 | agent route/session 回归与全量测试 |
| D06 | Artifact/Receipt 从 Delegation 的 `executionCwd` 采集；observe 同时比较任务前 dirty 集与 `baseline HEAD..HEAD`，提交后 clean 也不会漏 Artifact | runtime workspace/observe 定向回归；R02 fresh GUI 已闭环 |
| D07 | Manager Session 永久排除 `bash/edit/write`；Solo 仅保留有界只读工具 | `session-store.manager.test.ts` 断言实际工具面 |
| D08 | Goal 创建前即冻结暴露完整 Goal 工具 schema，handler 再按状态守卫；同一 tool chain 可紧接创建 WorkPlan | agent extension/session 测试；提示词事实源同步 |
| D09 | Submission 后由串行 observer 调度 `auto_on_submission`，使用 Submission ID 派生稳定 operationId 防重；复核输入加入平台 executor snapshot、不可变 observations、workspace change-set 和自动调度证明；复核完成后以稳定事件唤醒 Manager 验收。Goal revision 漂移不重复运行 reviewer，record-only 冲突只重试落盘。最终报告类条件使用冻结 `prepared_final_report` 消除完成前必须先发送的时序悖论 | 最新 R03：唯一自动 Verification `passed`、Settlement `accepted`、Goal 独立终验 `passed`、Goal `resolved`；server 430/430 |
| D10 | `isolated_worktree` 改为共享对象库的独立 Git checkout；Runtime 明示不得嵌套 clone；Codex 仅对平台签发的 isolated checkout 使用 `workspace-write + --approve-for-me` 写受保护 Git 元数据 | 真实 checkout commit 成功；定向回归和 R02 Receipt/promotion GUI 全闭环 |
| D11 | Manager 提示词强制 Goal 后下一动作必须是持久化工具调用，禁止重复自然语言规划；配合 D08 消除工具不可用循环 | Manager tool-surface/提示词回归；原循环根因路径已关闭 |
| D12 | 正式 Goal 激活时拒绝任何缺少 `workItemId` 的 Delegation，不再允许孤儿副作用 | `agent-extensions.test.ts` 断言 Runtime 无孤儿 Delegation |
| D13 | InteractionCard 从 `GET /api/interactions/:id` 的权威 Delegation 补回 `goalId`，所有提交/取消都携带 `expectedGoalId` | GUI 历史卡“继续使用”成功并完成 Worker；另一卡 API/同 UI 路径取消成功；改派 E2E CAS 测试通过 |
| D14 | 启动对账排除 `purpose=verification` 的执行重放，并向直接 Worker 会话补终态回执 | 含原始崩溃数据的 E2E Home 启动成功；startup reconciliation 测试通过 |
| D15 | Stop 先把活跃 Goal 写成 interrupted 并推进 epoch；所有 Manager 写工具执行 epoch fence | chat route 测试断言旧 epoch 写入被拒绝 |
| D16 | 发送失败重新抛给 composer，展示 `role=alert` 且不清空输入 | GUI 显示“目录不属于当前 Workspace”，输入仍为原文；截图 `evidence/T22-D16-external-directory-error-draft-preserved.jpeg` |
| D17 | Worker 快捷操作统一使用 `trimEnd + 换行 + 新草稿` | GUI 已有“已有草稿”时正确追加包含原 delegationId 的返工文本 |
| D18 | permission scope 与 question/confirmation 业务值分离；PuddingClaw headless 对外发出 `user_input_required/resolved`，external interaction mode 同时等待 permission 与 user-input registry；Teams 保留 interaction/request/question/option ID，并用结构化 answer payload 对同一 Run respond；HTTP/spawn 的 run/continue/respond 全部传入冻结 Workspace | 最新 R05：A/B question、真人选择 B、同一 Delegation/Run 续跑、目标 Workspace 精确写入、Goal resolved；PuddingClaw backend 48/48、CLI 63/63；Teams server 430/430 |

阶段结论：**修复前的 17 个 FAIL 没有被忽略，也没有被批量改写成 PASS。** 它们仍完整保留在下方基线和证据中。修复后 R01–R09 已全部执行并最终收口为 **9/9 PASS**；其中 R03、R05 在进一步修复后使用全新 Session 重新取证，旧失败证据没有删除或覆盖。

## 前置检查

| 项目 | 结果 | 证据/备注 |
| --- | --- | --- |
| 独立测试数据目录 | PASS | 使用持久隔离目录 `/Users/pet/.puddingteams-e2e-test`，仅复用本机认证与扩展注册信息 |
| 后端启动 | PASS | 前端已从 `Failed to fetch` 恢复为默认 Manager 新会话 |
| Workspace | PASS | composer 显示 `/Users/pet/Code/AI/Agent/PuddingTeams-e2e-target`，干净分支 `codex/e2e-pcp-persistent` |
| Worker 配置 | PASS | Computer Use 创建 `codex-writer`、`codex-readonly` 与 `codex-verifier`，均绑定直接会话；持久 Workspace Verifier probe 正常。证据：`evidence/preflight-verifier-persistent-probe.png` |
| Harness 基线 | PASS | `manager_review`、Goal 独立复核、`manager_request`、`isolated_copy`、`codex-verifier`、`isolated_worktree`；安全项均禁用。证据：`evidence/preflight-harness-*.png` |
| 临时可写 Worker | PASS | Computer Use 创建 `codex-writer`；新建记录带 `extensionRevision: 1`，委托已越过 revision 门禁并进入执行准备 |
| 自动化回归 | PASS | `apps/server` 全量 `pnpm test`：408/408 通过，0 failed，耗时约 16.0s；`apps/web/src/lib/events.test.ts`：7/7 通过 |
| 静态检查/构建 | PASS | `apps/server pnpm typecheck`、`apps/web pnpm typecheck`、`apps/web pnpm lint`、`apps/web pnpm build` 均为 exit 0；静态导出 6 个路由成功 |
| 文档站 | PASS | `pnpm docs:typecheck`、docs lint、`pnpm docs:build` 均为 exit 0；静态生成 16 个页面 |
| 发行组装 | PASS | `pnpm build:runtime` 完成 server/CLI bundle、Web 静态导出、第一方 extensions 预编译；产物 405 个文件、35.3 MB |

## 场景结果

| ID | 场景 | 结果 | 关键证据 | 缺陷/备注 |
| --- | --- | --- | --- | --- |
| T01 | 无 Goal 普通 Run | PASS | UI 返回分支 `provable-collaboration-protocol` 和最近 commit，并明确未创建 Goal/未改文件；测试 home 中不存在 `work-states.json`。截图：`evidence/T01-pass.png` | Manager 结束态快捷操作也已出现，留待 T26 专测 |
| T02 | 完整可信协作主链路 | FAIL（阻断于 Verification/Settlement） | 在持久干净 Workspace `codex/e2e-pcp-persistent` 重建 `codex-writer`、`codex-verifier`、`codex-readonly` 并绑定三个直接会话。新 Manager Session 成功建立 Goal/两项 WorkPlan，`write-file` 由 Codex Writer 在真实 `isolated_worktree` 执行，最终 `reported_completed`、Receipt `sealed`、自动 Submission #1、pending change-set 均可见。Codex Verifier 通过 `isolated_copy` 实读文件，标题、分支名、isolated_worktree 三项均 satisfied；但 Receipt 收集提前对目标 Workspace 文件做 `realpath`，得到 ENOENT，使 `collectionStatus=failed`、`integrity=suspect`；同时“验收后提升”尚未发生，promotionState=pending，第四项 unsatisfied，environment_verified 最终 failed，Settlement 保持 submitted，未错误 accepted。截图：`evidence/T02-isolated-worktree-running.png`、`evidence/T02-verification-circular-block.png`；安全摘要：`evidence/T02-clean-worktree-state.json` | Fail-closed 行为正确，但 happy path 被 D05、D06 阻断；未进入下游 `read-evidence` 与 Goal 最终独立复核 |
| T03 | environment_verified | FAIL（复验通过但无法 Settlement） | 唯一写项按要求冻结为 `environment_verified · auto_on_submission`、`isolated_worktree · git_tree`；Codex Writer 完成并产生 sealed Receipt、自动 Submission #1。平台实际签发 Codex Verifier fresh Session，在 `isolated_copy` 中执行只读检查，文件存在、首行、唯一标记三项均形成 satisfied observation，Verification=`passed`、integrity=`clean`。但写任务 Receipt 的 Artifact collector 仍提前对目标 Workspace 路径 `realpath`，得到 ENOENT，导致 `collectionStatus=failed`、Receipt integrity=`suspect`、change-set=`pending`，接受按钮禁用，Settlement 保持 submitted。截图：`evidence/T03-environment-verification.png` | 环境复验机制本身满足 fresh Session/isolated_copy/命令 observation 要求；D06 使“复验通过且环境 clean 后 accepted”仍无法闭环。Manager 随后重复发起了两次复验并陷入寻找 evidenceRefs 的推理循环，人工停止；未误接受 |
| T04 | Manager 自执行写门禁 | FAIL（Manager 写工具可绕过） | 平台状态机两次正确拒绝 Manager WorkItem，明确报错“WorkItem wi-mgr-direct-write 需要写入或副作用，必须走 Worker Delegation”；但 Manager 随后绕过 WorkItem，直接调用自身写工具。目标 Workspace 实际出现未跟踪文件 `docs/e2e-pcp-manager-write-bypass.md`，内容精确为 `manager-direct-write`。Manager 无法把该项推进为 Submission/accepted，Goal 未完成。截图：`evidence/T04-manager-write-bypass.png`；本地 `test -f` exit 0、`git status` 为 `??` | 状态机 fail-closed，但底层 Manager 工具暴露未实施同等写门禁，违反“文件必须不存在”的预期，见 D07 |
| T05 | 缺少必需 Artifact | PASS | Codex Writer 在 isolated_worktree 实际创建 Markdown，并如实报告 `e2e-pcp-proof.png` 与 SHA-256 均缺失；Execution=`reported_completed`，sealed Receipt 与自动 Submission #1 可见。Receipt evidence collection=`failed`、integrity=`suspect`，自动 environment verification 对缺失截图/hash 不通过，WorkItem 转 blocked，Settlement 未 accepted，Goal 保持未完成。截图：`evidence/T05-missing-artifact.png` | 正确保留执行事实并 fail closed；同时再次命中 D06 的目标 Workspace `realpath` ENOENT，但不影响本场景预期 |
| T06 | 无命令证据的测试声明 | PASS（但自动复验未启动） | 用可直接准入的 Codex Read Only 执行后，Worker 最终正文只有“测试已经通过”，未运行任何测试命令。Execution=`reported_completed`，原始声明、sealed Receipt、Submission #1 均保留；Receipt evidence collection=`partial`、integrity=`suspect`，两条命令 evidence requirement 均未结算，Settlement 保持 submitted，接受按钮禁用。截图：`evidence/T06-no-command-observation.png` | 纯文字声明未解锁验收，核心 fail-closed 通过；WorkItem 冻结为 `independent_evidence_review · auto_on_submission`，但提交后仍显示“尚无复验记录”，待 T08 专门判定自动触发缺陷 |
| T07 | 策略冻结 | FAIL（WorkPlan 无法建立） | 原 Prompt 与一次简化重试均已发送。Manager 最终调用 `create_session_goal` 成功，Goal 采用 Harness 默认且 revision=0；但随后反复明确表示当前函数清单没有 `update_work_plan`，即使在新一轮消息要求“只调用 update_work_plan”后仍无法调用，因而未建立 W1、未形成可比较的冻结 WorkItem 策略，第二阶段修改 Harness 后的旧/新策略对比无法安全执行。截图：`evidence/T07-workplan-tool-unavailable.png` | 被 D08 阻断；未伪造策略冻结结论 |
| T08 | auto_on_submission | FAIL | 先在 Harness 设置把“复验触发”从“Manager 请求时”改为“提交时自动触发”并保存，再新建 Session。W1 明确冻结为 `independent_evidence_review · auto_on_submission`，Codex Writer 完成、sealed Receipt 与 Submission #1 已产生；随后长期保持 Verification=`未复验`、详情“尚无复验记录”，没有 Verifier Run。Manager 未调用手工复验，并明确报告自动触发未发生。截图：`evidence/T08-auto-verification-not-triggered.png` | D09；没有重复 Verification Run，因为一次都未创建 |
| T09 | worktree 提升冲突 | FAIL（安全未覆盖，但提升链路未到达） | Codex Writer 在 isolated worktree 写出 `worker-version` 与完整 diff；Git commit 因公共 Git 元数据目录 `index.lock: Operation not permitted` 失败，Receipt 又因目标 Workspace 文件当时不存在而 `collectionStatus=failed` / integrity=`suspect`。随后在目标 Workspace 注入同路径 `external-version` 并发送“继续验收”；Manager 重新探测后准确识别 `external-version` vs `worker-version` 为 baseline conflict，明确计划标记 blocked、保留 worktree/diff，但长时间推理未实际调用状态转换，人工停止。目标 Workspace 最终仍为 `external-version`，隔离 worktree 仍保留。截图：`evidence/T09-promotion-conflict.png` | 冲突识别和不覆盖安全边界有效；D06、D10 阻断真实 commit/promotion，WorkItem 未落为 blocked，因此整体不通过 |
| T10 | dirty baseline | PASS（Settlement 被已知缺陷阻断） | 测试前目标 Workspace 精确存在 `A  baseline-staged`、` A baseline-unstaged`、`?? baseline-untracked`。Worker 的 frozen workspace change-set 仅含 `docs/e2e-pcp-dirty-baseline-worker.md`；自动 Codex Verifier 在 isolated_copy 形成 3 条平台观测/6 个 evidence refs，四项条件全部 satisfied，并逐一确认三个既有 dirty 文件仍存在、内容不变、未进入 Worker change-set。目标 Workspace 最终仍保持三类原状态且不存在 Worker 文件。截图：`evidence/T10-dirty-baseline-isolated.png` | 核心归因与保护通过；Receipt 因 D06 为 suspect，故 Verification 总体 failed、Settlement 未 accepted。T10 也证明 auto_on_submission 在另一新 Session 可正常启动，D09 为间歇性/Session 相关而非全局失效 |
| T11 | 写所有权与 Lease | FAIL（未进入并发执行） | 原 Prompt 与一次极简强制指令均已发送。Manager 能识别 `codex-writer` 可写、`codex-readonly` 只读，也能准确复述期望的 Lease/isolated_worktree 行为；但连续多分钟只反复讨论 completionCriteria、verificationPolicy、WorkItem ID 和调用顺序，没有创建 Goal/WorkPlan，也没有发出任何 Delegation，人工停止。截图：`evidence/T11-manager-planning-loop.png` | D11；由于没有 Run，无法对真实 Lease 竞争下结论，未伪造“已隔离”结果 |
| T12 | follow-up scope | PASS（commit 仍被环境阻断） | 同一 Goal、同一 `wi-write-followup`、同一 `codex-writer` 形成 2 次执行。Submission #1 被 Manager 明确标记“需返修/revision、不提升”；随后 D2 以 continue 方式在同一 isolated worktree `/Users/pet/.puddingteams-e2e-test/runtime/worktrees/9732bc10-481a-4706-8544-5c9cd895e012` 将内容改为 `revision-2`，Execution cwd 与 isolated worktree 完全相同，目标 checkout 未被写入。UI 显示“2 次执行”、Submission #2 待验收、Submission #1 需返修。截图：`evidence/T12-followup-same-scope.png` | 因果链与 scope 不漂移通过；D10 导致两次均无法 git commit，D06 使 Receipt suspect，故未接受/提升 |
| T13 | stale Verification | FAIL（前置 VerificationRecord 无法建立） | Manager 创建 Goal 后先在没有 WorkPlan/WorkItem 的情况下调用 `codex-writer` Delegation；Worker 直接在目标 checkout 写出未跟踪的 `docs/e2e-pcp-stale-verification.md`（16 bytes），但 Delegation 没有 workItemId，因而没有关联 Submission/Receipt/Verification。Manager 随后长时间反复分析如何事后补 WorkPlan 并承认“delegation had no workItemId”，未能创建 environment_verified Record，人工停止。截图：`evidence/T13-orphan-delegation-no-verification.png` | D12；没有 passed Record 可供 stale 测试，故未伪造第二阶段结论 |
| T14 | 只读能力直接准入 | PASS | `codex-readonly` 的 W1 冻结为 `read_only_shared · git_tree`，Delegation 未出现 capability-gap/admission，直接进入 running 并执行只读 Git 命令；返回分支、HEAD 与完整 dirty 分类，Workspace Change-set=`not_required · 无文件变化`。截图：`evidence/T14-readonly-direct-admission.png` | 核心准入通过；Receipt 对命令证据仅 `partial/suspect`、接受按钮禁用，是另一个证据采集问题，但不影响“能力足够直接启动”判定 |
| T15 | admission 取消 | FAIL | 新建 `claude-admission-e2e`（extensionRevision=1）后，W1 正确进入 `waiting_admission`，审批卡明确“Worker 尚未启动”、无法验证只读、继续不代表权限变化。点击“取消任务”却返回 toast：`处理 Goal 审批需要 expectedGoalId`，Interaction 保持 pending、Worker 未启动，无法进入 cancelled/封存 Receipt。截图：`evidence/T15-admission-card.png`、`evidence/T15-cancel-expectedGoalId-error.png` | D13 |
| T16 | admission 继续 | FAIL | 在同一 pending 卡点击“继续使用”，同样返回 `处理 Goal 审批需要 expectedGoalId`；Worker 仍未启动，无法验证 `unverified_user_accepted` 及后续契约不变。截图：`evidence/T16-continue-expectedGoalId-error.png` | D13 |
| T17 | admission 换 Worker | FAIL（候选筛选通过） | “换 Worker”正确只列出具备只读沙箱的 `Codex Read Only` 与 `Codex Verifier`；选择 Codex Read Only 并“确认改派”后仍报 `处理 Goal 审批需要 expectedGoalId`，没有 replacement Delegation。截图：`evidence/T17-replace-expectedGoalId-error.png` | 服务端候选筛选通过；状态变更被 D13 阻断 |
| T18 | pending admission 恢复 | FAIL（刷新恢复通过，进程恢复崩溃） | 页面刷新后同一 Interaction、Claude 单聊、`waiting_admission` 与审批卡完整恢复，Worker 仍未启动；随后停止并重启后端，进程在 startup reconciliation 直接崩溃：`ExecutionReceipt taskContractHash 不匹配当前 WorkItem 契约`。最小诊断定位为历史 T10 verification Delegation `539e944b-...` 的 Receipt `taskContractHash=undefined` 被错误按执行 Submission 重放。原测试 home 保留，后续改用空状态的 `~/.puddingteams-e2e-test-2`。最终审批动作本就被 D13 阻断 | D14；不是 toast 丢失，而是整个 server 无法恢复 |
| T19 | capability 漂移 | FAIL（前置审批错误阻断 drift 判定） | 在 pending 期间把 `claude-admission-e2e.systemPrompt` 改为 `T19 capability drift probe 2026-08-31`，保存后 `extensionRevision` 从 1 升到 2，重新 probe 通过；旧卡仍存在且 Worker 未启动。点击“继续使用”在 capability fingerprint 校验前返回 `处理 Goal 审批需要 expectedGoalId`。截图：`evidence/T19-capability-drift-before-continue.png`、`evidence/T19-capability-drift-after-continue.png` | D13；不能据此声称 stale/conflict 已验证，也没有静默沿用旧批准 |
| T20 | 并发响应幂等 | FAIL（CAS 决策未到达） | 在两个 Chrome 标签打开同一 pending Session，近同时提交“取消”与“继续”；两个动作均返回 `处理 Goal 审批需要 expectedGoalId`，Interaction 仍为 pending，Worker 未启动。截图：`evidence/T20-two-tabs-conflicting-actions.png` | D13 在 CAS/idempotency 层之前统一拒绝请求，无法验证“一成功一冲突” |
| T21 | Worker-originated HITL | FAIL | 新 Goal/W1 成功建立，`puddingclaw` 使用 `isolated_worktree` 启动并产生来源为 Worker 的原生 permission 卡，WorkItem/Delegation 保持同一执行记录；但卡片只有授权范围“仅本次/本次会话”与“允许/拒绝/取消”，没有任务要求的 A/B 业务选项。选择“仅本次”并点击“允许”又返回 `处理 Goal 审批需要 expectedGoalId`，未能 respond/续接原 Run，也没有写文件。截图：`evidence/T21-native-permission-card-no-AB-choice.png`、`evidence/T21-native-permission-expectedGoalId-error.png` | 原生卡来源与写前暂停成立；D13 阻断响应，D18 表明业务选择没有被投影到 UI |
| T22 | 双工具故障/停止/刷新 | FAIL（工具调用前阻断） | 原 Prompt 含外部绝对目录 `/Users/pet/puddingteams`，消息路由按本地路径冻结规则在进入 Manager 前拒绝外部目录；composer 被清空但 UI 没有展示 API 错误。改用不含绝对路径 token 的语义等价 Prompt 后，Manager 长时间反复讨论 WorkPlan/tool call 顺序，未创建两张工具卡、未保留目标 stderr/exit 128，人工停止成功。截图：`evidence/T22-external-directory-prompt-silently-rejected.png`、`evidence/T22-manager-planning-loop-stop.png` | D11、D16；没有伪造 callId 独立性结论 |
| T23 | 长任务停止 | PASS（通过直接 Worker 单聊验证核心停止语义） | `Codex Read Only` 运行 60 秒只读计时任务时显示“执行中/终止任务”；点击终止后快速收敛为 `已取消`，按钮从 DOM 移除，重复点击窗口随之关闭；刷新后仍为 cancelled，并保留唯一 Worker 结果与过程入口。截图：`evidence/T23-long-worker-running.png`、`evidence/T23-worker-cancelled.png`、`evidence/T23-worker-cancelled-after-refresh.png` | 由于状态在约 120ms 内已确认，未观察到长期 `stopping`；Manager Goal 版受 D11 影响，核心 Driver/Direct Window 路径已覆盖 |
| T24 | 停止失败反馈 | PASS | 第二个 60 秒只读 Worker 运行中强制停止后端，再点击“终止任务”：UI 明确 toast `Failed to fetch`，卡片继续显示“执行中”，终止按钮恢复可重试，没有伪装成功。重启同一 Home 后，startup reconciliation 将任务收口为 `失败 (server_restart)`，说明“本地执行已终止”并保留交接目录，页面不再显示 running。截图：`evidence/T24-stop-backend-down.png`、`evidence/T24-after-backend-restart.png` | 满足网络错误可见、失败不伪装、重启可解释收口 |
| T25 | 远端 Run 对账/接管 | SKIP（可选前置不存在） | 当前可用 Worker 只有本地 spawn/sdk；唯一 HTTP Worker `puddingclaw-http` 被停用且 endpoint 为本机 `127.0.0.1:8888`，没有可断联、可 query_run/reconcile 的远端 Driver，也没有可安全执行人工接管的真实 remote Run | 对应 `observation_lost/effect_unknown`、late completed、人工接管等内部窗口已由 `runtime.reaper.test.ts` / `runtime.anchor.test.ts` 自动回归覆盖；未伪造 GUI 结果 |
| T26 | Manager 快捷操作 | PASS | Copy 按钮切换为“已复制”；“继续推进”正确预填；已有草稿后点“交给 Worker”按换行追加且输入框获得焦点；均未自动发送。截图：`evidence/T26-copy.png`、`evidence/T26-draft-append.png` | streaming 阶段未出现结束态操作，settled 后才出现 |
| T27 | Worker 快捷操作 | FAIL（大部分通过，草稿追加失败） | 成功 Worker 结果显示分支 `codex/e2e-pcp-persistent` 与 HEAD。复制按钮切为“已复制”，把剪贴板粘回 composer 后正文与可见结果一致；“继续追问”空草稿时预填 Worker 名与 `delegationId: c4b778ad-02f8-4f7e-8a76-675938789746`；“要求返工”空草稿时也正确预填；“查看执行过程”打开该 Worker 10:34 的同一 Delegation 时间线。截图：`evidence/T27-worker-result-actions.png`、`evidence/T27-correct-worker-process.png` | composer 已有“已有草稿”时点击“要求返工”两次均无任何变化，未按换行追加，见 D17；因此整体不通过 |

## 故障注入与自动化窗口

`apps/server` 全量自动测试已执行：408/408 PASS；Web 事件回放专项：7/7 PASS。第 8 节列出的 crash/CAS/TTL/乱序/重放/越权/旧 store 兼容窗口均有对应回归通过，重点包括：

- terminal journal 重启补封 Receipt、remote effect unknown/observation_lost、手工重挂与取消边界：`runtime.reaper.test.ts`、`runtime.anchor.test.ts`；
- admission 四阶段、TTL、旧 approved/application journal 缺口、能力漂移：`runtime.workspace-execution.test.ts`、`invoker.admission.test.ts`；
- idempotency/CAS/旧 epoch 与 late terminal fencing：`interaction-broker.idempotency.test.ts`、`work-state.test.ts`；
- delayed toolResult / stale HTTP snapshot：`routes/chat.test.ts`、`apps/web/src/lib/events.test.ts`（两侧均已执行通过）；
- Artifact 缺失/越界/hash 与 Verifier 受保护 Workspace：`artifacts.test.ts`、`execution-receipt.test.ts`、`verification-review.test.ts`；
- Store v2 缺省 `workerStarted/source`：`delegation-store.version.test.ts`。

## 缺陷清单（修复前基线）

1. **D01 / Blocker：默认 Worker 缺少 `extensionRevision`，所有 Delegation fail closed。** 隔离数据目录首次启动生成的 `codex`、`claude-code`、`puddingclaw` 记录均无 `extensionRevision`；Manager 重试、改派仍统一提示“agent 配置在委托创建时发生变化”。UI 新建 `codex-writer`（`extensionRevision: 1`）后可进入执行准备，证明不是 Connector 本身不可用。
2. **D02 / Blocker：常规 pnpm 仓库无法进入 `isolated_worktree`。** `WorkspaceExecutionCoordinator.assertNoNestedGit()` 递归扫描整个 Workspace（包括 Git ignored `node_modules`），遇到依赖目录内符号链接即抛 `unsupported_layout`。复现路径：`apps/docs/node_modules/@tailwindcss/postcss`。这阻断 T02/T03/T05/T07–T13 等依赖 isolated worktree 的 UI 主链路。
3. **D03 / Test-environment：Mac 自动锁屏会暂停 Computer Use。** 需人工解锁后继续 GUI 场景；不影响已持久化的会话、Goal 和自动测试结果。
4. **D04 / High：Worker timeline 持久化了未脱敏的环境变量值。** T02 干净 Workspace 的 `codex-writer` 执行 `env | rg ...` 后，Delegation timeline 的 `item.completed.content` 保存了敏感环境变量明文；报告不复制任何值。该行为与“工具负载脱敏”预期不符，测试数据目录在结束前应按敏感数据处理并清理。
5. **D05 / High：Manager Session 的动态 Worker 工具注册与系统清单不一致。** 在既有 Manager Session 内用 UI 新建并启用 `codex-writer` 后，系统清单显示 `agent_codex-writer__delegate（已激活）`，但实际调用返回 `Tool agent_codex-writer__delegate not found`；新建 Manager Session 后同一工具立即可用。证据：`evidence/T02-tool-registry-stale.png`。
6. **D06 / Blocker：isolated_worktree 的证据收集与“验收后提升”形成循环依赖。** Runtime 在提升前按目标 Workspace 路径采集 Artifact，目标文件尚不存在导致 ENOENT，并把 sealed Receipt 标为 `collectionStatus=failed`、`integrity=suspect`。T02 的环境复验因此 failed；T03 中 Verifier 已在 isolated copy 对三项条件形成 clean/satisfied observations 且总体 passed，但 suspect Receipt 仍让接受动作不可用、change-set 继续 pending。由于配置是 `promoteOnAcceptance=true`，提升只能由接受触发，而接受又受提升前失败的证据收集约束，happy path 无法闭环。证据：`evidence/T02-verification-circular-block.png`、`evidence/T03-environment-verification.png`。
7. **D07 / Critical：Manager 写门禁只覆盖 WorkItem 状态机，未覆盖 Manager 自身写工具。** T04 中 `advance_manager_work_item` 对 `git_write` 正确报“必须走 Worker Delegation”，但 Manager 随后仍直接调用自身写工具，在目标 Workspace 落下 `docs/e2e-pcp-manager-write-bypass.md`。因此攻击者可绕过 Delegation/Receipt/Submission/Lease/Workspace 隔离直接产生副作用；虽然无法把 WorkItem 伪造为 accepted，但写入已经发生。证据：`evidence/T04-manager-write-bypass.png`。
8. **D08 / High：Goal 管理工具在 Manager Session/turn 间动态暴露不一致。** T07 中同一 Manager 成功调用 `create_session_goal` 后，后续 turn 的工具清单只剩基础工具/Delegation，Manager 明确无法调用系统上下文要求的 `update_work_plan`；另一些 Session（T02/T03/T05/T06）同工具可用。重发新用户 turn 也未恢复，导致 Goal 孤立在无 WorkPlan 状态。证据：`evidence/T07-workplan-tool-unavailable.png`。
9. **D09 / High：`auto_on_submission` 触发存在 Session/时序不一致。** Harness 全局设置已切为“提交时自动触发”并保存；T08 的 W1 明确冻结为 `independent_evidence_review · auto_on_submission`，Worker 提交后仍长期“未复验/尚无复验记录”，没有 reviewer Run；T06 交叉复现。随后 T10 的新 Session（`environment_verified · auto_on_submission`）却能正常自动创建 Verifier Run 并完成复验，说明不是全局配置无效，而是触发在不同 Session/策略路径间不一致。证据：`evidence/T08-auto-verification-not-triggered.png`、`evidence/T10-dirty-baseline-isolated.png`。
10. **D10 / Blocker：isolated_worktree Worker 可改工作文件但无法写公共 Git 元数据。** T09 中 Worker 在平台创建的隔离 worktree 成功写出目标文件和 diff，但 `git commit` 创建主仓库 `.git/worktrees/<id>/index.lock` 时返回 `Operation not permitted`；结果只能上报未提交 change-set，无法进入可提升状态。这说明 Worker 的文件写权限与 Git worktree 公共元数据写权限不一致。
11. **D11 / High：默认 Manager 在多 WorkItem/冲突场景出现无界规划循环。** T09 冲突已被明确识别后，Manager 长时间重复推导 target Workspace 含义而未调用 blocked 状态转换；T11 在用户追加“不要再分析、立即调用”后仍持续重复讨论 Goal 参数和调用顺序，最终没有创建 Goal/Delegation。两场均需人工停止，导致流程不可操作。证据：`evidence/T09-promotion-conflict.png`、`evidence/T11-manager-planning-loop.png`。
12. **D12 / Critical：正式 Goal 激活时允许无 WorkItem 的写 Delegation，产生目标 checkout 孤儿副作用。** T13 中 Manager 在 WorkPlan 尚未建立时调用 `codex-writer`（未传 workItemId）；Worker 随后直接写入目标 Workspace 的 `docs/e2e-pcp-stale-verification.md`。该写入不属于任何 WorkItem，因此没有 frozen workspace policy、Receipt、Submission、Verification 或 Settlement 可追踪。平台未 fail closed，且 Manager 无法事后安全补链。证据：`evidence/T13-orphan-delegation-no-verification.png`。
13. **D13 / Blocker：Admission 审批卡所有动作缺少 `expectedGoalId`。** T15 取消、T16 继续、T17 确认改派均在 UI 调用时统一失败为 `处理 Goal 审批需要 expectedGoalId`，Interaction 永久停在 pending。风险文案、Worker 未启动标识与替代候选筛选均正确，但没有任何决策可提交。证据：`evidence/T15-cancel-expectedGoalId-error.png`、`evidence/T16-continue-expectedGoalId-error.png`、`evidence/T17-replace-expectedGoalId-error.png`。
14. **D14 / Critical：startup reconciliation 会把 Verification Delegation 当执行 Submission 重放并崩溃。** T18 重启时，`reported_completed` 的 verifier Delegation `539e944b-...`（`purpose=verification`）携带的 sealed Receipt 合法地没有 `taskContractHash`；启动恢复却调用 `noteDelegation` 的执行收口校验，把它与 T10 W1 当前契约比较并抛错，导致 server 进程退出。页面刷新可恢复 pending，但进程重启不可恢复。诊断用临时代码已完全回退，仓库无残留改动。
15. **D15 / High：Manager 停止请求在 Goal 工具链中不收敛。** T21 前置旧 Goal 清理阶段点击“停止”后，composer 长时间保持“正在停止并保存结果…/正在停止”，但 Manager 仍继续推理、取消 Worker、重试 `update_work_plan`、更新 Goal 并创建下一 Goal，持续超过 30 秒。相同按钮在纯推理阶段可快速停止，说明停止边界随 Goal/工具链路径不一致。证据：`evidence/T21-blocked-by-uncancellable-admission.png`。
16. **D16 / High：外部绝对目录触发的消息发送失败在聊天 UI 中被静默吞掉。** T22 原 Prompt 中的 `/Users/pet/puddingteams` 被服务端本地路径冻结规则拒绝（外部目录不允许进入 Agent）；发送后 composer 被清空、消息未落盘，页面没有展示“目录不属于当前 Workspace”等错误。安全拒绝本身合理，但用户看不到失败原因且草稿丢失。证据：`evidence/T22-external-directory-prompt-silently-rejected.png`。
17. **D17 / Medium：Worker“要求返工”快捷操作不支持已有草稿追加。** T27 在空 composer 下能正确预填 Worker 名、delegationId 和“修改要求”前缀；但 composer 已有“已有草稿”时连续点击两次均无变化，没有按规范追加到下一行。Manager 的 T26 同类追加路径正常，问题集中在 Worker action。证据：`evidence/T27-worker-result-actions.png`。
18. **D18 / High：PuddingClaw 原生 permission 卡无法承载任务要求的业务选项。** T21 明确要求写前让用户选择 A/B；Worker 的确在写入前进入 `waiting_human`，但 UI 仅显示授权范围“仅本次/本次会话”和“允许/拒绝/取消”，没有 A/B 请求内容或选项。即使 D13 修复，当前投影也不足以完成该业务选择，存在“批准权限但没有回答业务问题”的语义缺口。证据：`evidence/T21-native-permission-card-no-AB-choice.png`。

## 最终结论

修复前执行 T01–T27 的基线是 **9 PASS、17 FAIL、1 SKIP**；该数字只描述发现缺陷时的版本，17 个失败均保留在本报告的缺陷清单与原始证据中。

修复后 R01–R09 的最终结论为 **9/9 PASS**。R03 已证明 Submission 后只产生一次自动 Verification、Reviewer `passed/clean`、Settlement `accepted`、Goal 终验与用户三轴报告闭环；R05 已证明 A/B 业务问答以同一 Delegation/Run 完成，选择 B 被原样回传并写入目标 Workspace。所有最终 Manager 与 Reviewer 均使用 `DeepSeek V4 Flash`，未使用 V4 Pro。修复前 T01–T27 的 **9 PASS、17 FAIL、1 SKIP** 仍是缺陷发现时的历史基线；T25 仍要求真实远端 Worker 和可控断联环境，当前没有该前置时继续记条件性 SKIP。

## 测试残留与清理边界

- 目标 Workspace 有意保留 6 个测试脏文件：`docs/e2e-pcp-baseline-staged.md`、`docs/e2e-pcp-baseline-unstaged.md`、`docs/e2e-pcp-baseline-untracked.md`、`docs/e2e-pcp-manager-write-bypass.md`、`docs/e2e-pcp-promotion-conflict.md`、`docs/e2e-pcp-stale-verification.md`。
- `git worktree list` 仍有 8 个测试隔离 worktree，其中 7 个位于 `~/.puddingteams-e2e-test/runtime/worktrees/`，1 个 T21 pending worktree 位于 `~/.puddingteams-e2e-test-3/runtime/worktrees/0b50ec02-ffed-4905-a88e-a6c0f75c67c1`。
- 三个测试 Home 均保留以便复现；第一个 Home 含 D04 所述敏感 timeline，应按敏感测试数据处理。
- R03/R05 最终测试 Home 位于 `/private/tmp/puddingteams-e2e-r03-r05`；目标 Workspace 额外保留 `docs/e2e-regression-hitl.md`（内容 `所选值: B`）作为 R05 证据。
- 未执行第 11 节清理 Prompt：它要求先展示精确候选清单并由用户确认。本轮没有自动删除、覆盖或回退任何测试文件/worktree；D06 的实现缺陷已经修复，不再作为清理阻断理由。
