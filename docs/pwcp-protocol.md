# PWCP v1：操作语义快速参考

> 本文是 `docs/2026-08-06-通用-agent-接入-底层与扩展方案.md` §1–§5 的可执行落点。
> 代码位置：`apps/server/src/agent-runtime/`。

## 四种操作

| 操作 | 面向 | 前置条件 | 语义 |
| --- | --- | --- | --- |
| `run` | Session（新建） | 无 | 创建新 Session 并启动第一条 Run |
| `continue` | Session（空闲） | 前一条 Run 必须已结束 | 在已有 Session 中创建下一条 Run |
| `respond` | Run / Interaction | 当前 Run 处于 `waiting_input` | 给同一 Run 提交审批或回答，恢复原 runHandle |
| `cancel` | Run | 任意 | 取消当前 Run，不删除 Session |

禁止：`continue` 和 `respond` 合并为 `resume`；`waiting_input` 视为 failed 后重跑任务。

## 状态机

```text
无 Session ── run ──> running ───────────────> completed/failed/blocked
                         │
                         └──> waiting_input ── respond ──> running
                                     │                         │
                                     └── reject ───────────────┘

已有空闲 Session ── continue ──> 新 Run 的 running
```

约束（§1.3）：

- `continue` 只允许 Session 空闲时调用（Runtime 会话锁，`AgentRuntime.delegate`）；
- `respond` 必须携带服务端返回的 Interaction 句柄，并恢复原 `runHandle`；
- `waiting_input` 不是 `failed`，也不是“提示用户后重新运行”；
- 同一 Interaction 的重复提交必须幂等（`consumedRequestId`）；
- 用户拒绝也是合法响应，Run 进入可解释终态（`cancelled`）。

## 三个 handle（§1.2）

| 身份 | 生命周期 | 用途 |
| --- | --- | --- |
| `sessionHandle` | 多条 Run | 让下一条用户消息继承 Agent 历史 |
| `runHandle` | 一条 Run | 取消、追踪、定位错误 |
| `interactionHandle` | 一次或一组待输入 | 只用于恢复当前 Run；可能含 bearer token，不能进模型上下文 |

`requestId` 只标识一次 Interaction 中的某个具体问题；并行工具可能一次返回多个
`requestId`，必须完整回答当前集合。

## token 边界（决策 4）

- continuation token 只存在 `InteractionSecretStore`（AES-256-GCM，0600）；
- 不进 pi Session JSONL、不进 LLM 上下文、不下发浏览器；
- 浏览器只拿 PuddingTeams 生成的本地 `interaction.id`。

## 409 语义

`AgentRuntime.delegate` 在目标 `sessionHandle` 已被占用（active 或 waiting_input）
时抛 `SessionConflictError`（等价 PuddingClaw 的 `Session already has an active Run
or pending input`）。正确路径是 `respond`，不是重新 `run`/`continue`。
