# 声明式 Connector Schema（connector.declarative 逐字段）

> 事实源：`docs/2026-08-06-通用-agent-接入-底层与扩展方案.md` §10.3（两级 Connector 实现模型第 1 级）。引用均指该方案章节号。
> 执行体：`apps/server/src/agent-runtime/declarative-driver.ts`（核心 DeclarativeDriver）；校验与解析：`apps/server/src/agent-runtime/extensions.ts`（`validateDeclarative` / `parseDeclarativeMappingRef`，单一事实源）。
> 完整样例：`extensions/connectors/echo`。

声明式 Connector 让用户**只写 manifest、不写代码**接入简单 CLI：spawn、超时、取消、stdin framing、JSON/JSONL 解码全部由核心执行，包内没有任何可执行模块（无 entry，无 pi 门面）。`connector.declarative` 与顶层 `entry` **互斥**——有代码走代码型 Connector（见 `connector-extension.md`）。

## 1. 整体形状

manifest（折叠在 `package.json` 的 `puddingteams` 字段）中：

```jsonc
"connector": {
  "id": "echo",
  "displayName": "Echo",
  "apiVersion": "1",
  "defaultTransport": "spawn",
  "supportedTransports": ["spawn"],
  "declarative": {
    "command": "node",
    "probe": { "args": ["{packageDir}/cli.mjs", "--version"], "versionRegex": "(\\d+\\.\\d+\\.\\d+)" },
    "operations": {
      "run":      { "args": ["{packageDir}/cli.mjs", "run", "{message}"] },
      "continue": { "args": ["{packageDir}/cli.mjs", "resume", "{sessionHandle}", "{message}"] }
    },
    "output": {
      "mode": "jsonl",
      "mapping": { "sessionHandle": "$.session_id@session.started", "...": "..." }
    },
    "capabilities": { "operations": ["run", "continue", "cancel"], "interactionKinds": [] }
  }
}
```

## 2. 逐字段

### 2.1 `declarative.command`

- 类型：`string`；**必填**。
- 语义：可执行文件名或路径（PATH 解析）。probe 与所有操作共用这个命令。

### 2.2 `declarative.probe`

- 类型：`{ args: string[], versionRegex?: string }`；可选。
- 语义：`probe()` 时执行 `command + args` 探测 CLI 可执行性；`versionRegex` 从 stdout 提取上游版本（取第一个捕获组，默认 `(\d+\.\d+\.\d+)`）。
- 省略时以 `["--version"]` 兜底探测。`args` 同样支持占位符（§3）。

### 2.3 `declarative.operations.run`

- 类型：`{ args: string[], stdin?: "none" | "json" }`；**必填**。
- 语义：新 Session 第一条 Run 的 argv 模板。`stdin` 默认 `none`（立即 EOF）；`json` = 向 stdin 写入 `{"message","sessionHandle","requestId"}` 一个 JSON 对象后 EOF。

### 2.4 `declarative.operations.continue`

- 类型：同 `run`；可选。
- 语义：续接 Session 的 argv 模板，通常引用 `{sessionHandle}`。
- 一致性约束：声明了 `continue` 才能在 `capabilities.operations` 里含 `"continue"`（防虚标，校验拒绝反之组合）。

### 2.5 `declarative.output.mode`

- 类型：`"jsonl" | "single-json"`；**必填**。
- 语义：stdout 解码方式。`jsonl` = 逐行 JSON 事件流（流式归约，progress 实时外送）；`single-json` = 整个 stdout 是一个 JSON 对象，进程退出后一次性按路径取值（mapping 必须省略 `@事件类型`，§4）。

### 2.6 `declarative.output.mapping`

- 类型：`Record<string, string>`；可选。
- 语义：上游事件 → PWCP 字段的映射 DSL，key 是 7 个目标键之一，value 是取路径表达式（§4）。省略时只有退出码定边界（completed 无 content/handle）。

### 2.7 `declarative.capabilities.operations`

- 类型：`Array<"run" | "continue" | "cancel">`；**必填**。
- 语义：诚实的能力声明，直接成为 Driver 的 `capabilities()`。必须含 `"run"`；**不得含 `"respond"`**（声明式不支持 HITL，校验直接拒绝）；`"cancel"` 表示接受运行时取消（AbortSignal → SIGTERM→SIGKILL，无上游取消命令）。

### 2.8 `declarative.capabilities.interactionKinds`

- 类型：`[]`；**必填且必须为空数组**。
- 语义：声明式 Connector 不产生任何交互请求。非空即校验失败（防虚标）。

## 3. argv 占位符

`args`（含 probe.args）逐项做模板替换，未命中的占位符替换为空串：

| 占位符 | 取值 |
| --- | --- |
| `{message}` | 本次 Run 的用户消息 |
| `{sessionHandle}` | 续接的 Session handle（run 时为空串） |
| `{requestId}` | 本次提交的幂等键 |
| `{packageDir}` | 包安装目录的绝对路径（引用包内脚本用，如 `{packageDir}/cli.mjs`） |

`validate` 会检查 `{packageDir}/xxx` 引用的文件真实存在，且不允许绝对路径/`..` 越界。

## 4. mapping DSL

### 4.1 语法

```text
$.<dot.path>[@<eventType>[<filterPath>=<filterValue>]]
```

- `$.` 后是从事件对象根出发的 dot.path（段名 `[A-Za-z0-9_]+`）；
- `@` 后是事件类型匹配（事件的 `type` 字段，段名 `[A-Za-z0-9_-]+`）；只有 `type` 相等的事件才命中；
- `[path=value]` 是可选过滤器：事件在 `filterPath` 上的值字符串化后等于 `filterValue` 才命中；
- `single-json` 模式对整个 stdout JSON 对象取路径，`@` 与过滤器**必须省略**。

示例：`"$.usage.input_tokens@done"` = 在 `type=="done"` 的事件上取 `usage.input_tokens`；`"$.text@message[role=assistant]"` = 在 `type=="message"` 且 `role=="assistant"` 的事件上取 `text`。

### 4.2 目标键（7 个，只实现这个子集）

| 目标键 | 取值类型 | 语义 |
| --- | --- | --- |
| `sessionHandle` | string | 写入边界事件的 `sessionHandle`（续接凭据，Driver 生成与消费，不透明） |
| `runHandle` | string | 写入边界事件的 `runHandle` |
| `content` | string | 累积进 `completed.content`（多次命中按 `\n\n` 拼接）；**不外送 progress**，避免与终态重复 |
| `progress` | string | 命中即经 `onUpdate` 实时外送流式进度（唯一外送的键） |
| `error` | string | 命中即以事件为准判 `failed`（`errorCode: "worker_failed"`，`recoverable: true`），优先于退出码判断 |
| `usage.inputTokens` | number | 汇入 `completed.usage.inputTokens` |
| `usage.outputTokens` | number | 汇入 `completed.usage.outputTokens` |

有没有 `progress` 键直接决定能力声明：`progress: "stream"`（有）或 `"coarse"`（无）。

## 5. 校验规则一览（validate / 安装共用）

- `declarative` 与顶层 `entry` 互斥；
- `command`、`operations.run` 必填；`args` 必须是非空字符串数组；
- `capabilities.operations` 必须含 `"run"`、不得含 `"respond"`；`interactionKinds` 必须空数组；
- 未声明 `operations.continue` 时 `capabilities.operations` 不得含 `"continue"`；
- mapping key 必须在 7 个目标键内，value 必须匹配 DSL 语法；`single-json` 模式不允许 `@`；
- `{packageDir}` 引用必须是包内相对路径且文件存在。

## 6. 限制（写声明式包前确认你的 CLI 符合）

- **无 HITL**：没有 respond，不支持跨进程审批/提问；需要交互的 Agent 必须走代码型 Connector。
- **单进程一问一答**：每次 run/continue 是一次独立 spawn，进程退出即边界；没有长驻连接、没有多轮协议。
- **stdin 只支持 `none` / `json`**：没有自定义 framing、没有交互式 stdin 对话。
- **transport 固定 `spawn`**；http/rpc/acp 走代码型。
- 错误归一与代码型一致：timeout / cancelled / startup_timeout / spawn_error / worker_failed 五种 failed；退出码 2（用法错误）标 `recoverable: false`，stderr 摘要截断 400 字符并脱敏。

## 7. 完整示例：echo 包逐行对照

`extensions/connectors/echo/cli.mjs`（零依赖 fixture）对 `node cli.mjs run "你好"` 输出 4 行 JSONL，与 manifest mapping 的逐行对照：

| cli.mjs 输出行 | 命中的 mapping | 效果 |
| --- | --- | --- |
| `{"type":"session.started","session_id":"echo-…","run_id":"run-…"}` | `sessionHandle: $.session_id@session.started`<br>`runHandle: $.run_id@session.started` | 边界事件带上 sessionHandle/runHandle，`continue` 时经 `{sessionHandle}` 回传 |
| `{"type":"progress","text":"echo 处理中"}` | `progress: $.text@progress` | 实时外送进度（`onUpdate`，streaming） |
| `{"type":"message.completed","text":"ECHO: 你好"}` | `content: $.text@message.completed` | 成为 `completed.content` |
| `{"type":"done","usage":{"input_tokens":10,"output_tokens":5}}` | `usage.inputTokens: $.usage.input_tokens@done`<br>`usage.outputTokens: $.usage.output_tokens@done` | 汇入 `completed.usage` |

进程退出码 0 → 恰好一个 `completed` 边界事件，四行各归其位。`node cli.mjs resume <sessionId> <msg>` 复用传入的 sessionId，即 `continue` 操作的 `{sessionHandle}` 回路。probe 走 `{packageDir}/cli.mjs --version`（输出 `echo-cli 0.1.0`，`versionRegex` 提取 `0.1.0`）。

生成同样的骨架：`puddingteams extension init --type connector --declarative --id <id> <dir>`（模板在 `extensions/shared/templates/connector-declarative/`）。
