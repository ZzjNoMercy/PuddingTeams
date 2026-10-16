# Agent 会话收敛：P1–P4 开发与验证进度

更新：2026-10-15。实现基线：main `f2e5fc4`（Pi SDK 1.2.0、pi-mcp-adapter 5.3.0）。本文随本次实现提交入库；详细接力报告与截图按仓库约定仅保留在本地 `.pudding/handoff/`。

## 当前状态

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| P1 | Manager 原生能力、执行证据、群聊 Worker 范围 | 已完成并验收 |
| P2 | 单次统一 delegation、审批、结果投递、过程查询 | 已完成并验收 |
| P3 | Worker 原生单聊、followUp、steer、不可变快照 Fork | 已完成并验收 |
| P4 | 旧入口清理、统一 UI/诊断、事实源与公开文档 | 开发及本轮验证完成，证据分层记录 |

## 已实现的行为

- Manager 保留 Pi SDK 的 Agent Loop、原生工具、上下文压缩与 JSONL；平台增加 delegation、Goal 和 Workspace 执行证据，不重写 SDK。
- delegation 是一次工具调用，Worker 每次使用独立上下文。结果只投递回 owner 会话，执行过程通过 delegationId 查询，不作为可连续输入的用户会话。
- 群聊至少两位 Worker，用于缩小 Manager 可用 Worker 范围；Workspace 仍是项目 cwd，Goal 是会话执行契约。
- Pi Worker 单聊具有持久的 owner 身份，使用自己的模型、指令、工具、MCP 与知识配置，不暴露 Manager delegation 工具。其他 Connector 保留既有直派通道，不宣称具备原生忙碌输入或快照导入能力。
- followUp 与 steer 使用 Pi SDK 队列。运行中发送的消息区分受理、落盘与终态；SDK 受理不等于已消费，同文匹配歧义保留未知，冷启动不自动重放未消费输入。steer 在 SDK 处理边界生效，不强制终止正在执行的命令。
- Fork 冻结已落盘的对话分支、附件及平台外置结果，创建独立 Worker 原生会话。目标使用自己的配置，保留来源追溯，支持幂等与故障恢复；不自动执行、不重放历史工具、不复制活动 Goal 或审批权限。项目工作文件仍共享 cwd，不属于冻结快照。
- windows.json 使用 v3 身份结构。未上线项目不迁移旧状态；开发验收使用隔离数据，不删除用户已有运行数据。

## 验收证据

P3 最终 e2e 验收报告记录：

| 检查 | 结果 |
| --- | --- |
| `pnpm verify:baseline` | exit 0；server 1119/1119、server/web typecheck、web lint/build、golden smoke 通过 |
| Web 单元测试全量 | 174/174 |
| tgz 打包、隔离安装后的完整脚本矩阵 | 33/33 |
| 原生会话专项 | 快照附件冻结、Fork 幂等与来源追溯、无自动执行、Worker 工具/MCP 隔离、followUp/steer、运行中模型变更 409、冷重启消息 ID 稳定通过 |

此前 P3 开发阶段还执行了 docs typecheck/lint/build 与安装态浏览器验证：Fork 不自动执行，390px 空闲/运行中控制无重叠，手动上翻后完成的阅读位置偏移为 0。最终 33 项验收未再次运行 browser-hold，也未运行真实外部 Codex 模型用例；不能将 fixture 验证写成所有外部提供商验证。

遗留失败收口：`interrupted-model` 是标题与主请求计数竞态的 fixture 修正，并未证实标题阻塞主调用。`first-work-crash/drop` 除精确 user 落盘断言外，还在 P3 前修复了真实冷恢复门禁：SDK setup 或明确零用量空 error 不再误判为用户工作已执行；真实回复、工具与未知执行证据仍阻止重发。最终 Web 测试修正了附件指纹 JSON 元组的陈旧断言。

证据来源：本地 `2026-10-14-pre-p3-message-recovery-fixes.md`、`2026-10-14-phase3-development-verification.md`、`2026-10-14-p3-native-conversation-e2e.md` 与 `phase3-verification-summary.json`。此次提交前只做差异格式与提交范围检查，未重新执行完整验收。

## P4 落地（2026-10-15）

删除委派输入队列、执行会话管理/聊天路由、双分组/workerView/查看指针与旧内联显示；只读过程独立到 worker-process-session。新增基于来源会话的执行索引、全局执行搜索和旧数据元信息诊断。保留 Driver 的真实执行/审批/连续性和审计事实；非 Pi 单聊适配仍有实际用途，不为清理而破坏它。用户旧数据不自动迁移、读取补投或删除。

本轮 verify:release exit0（server1122/1122、Electron12/12、Web/docs检查与runtime构建），Web全量175/175。33项安装矩阵首轮32/33，新增DELETE检查请求体修正后单项通过。UI收尾修复搜索详情被卸载和阅读位置被卸载几何覆盖，后续前端检查/构建及真实浏览器复验通过；阅读位置切换、刷新、任务完成均2050→2050。最后受影响路由与server类型检查另行复验。

A01–A25逐项记录T1/T2/T3与沿用P3证据；不把fixture解释为真实外部模型验证，不声称每个故障点都有SIGKILL或T3覆盖。完整矩阵早于末次UI修复，后者按影响面复验，未写成最终包全33项重跑。

P4改动尚未提交、推送或发版；P1–P3的210b152保持不变。详细报告和证据位于本地 `.pudding/handoff/2026-10-15-p4-development-verification.md`、`2026-10-15-p4-acceptance-evidence-index.md` 与 `p4-verification/`。
