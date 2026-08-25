# PuddingTeams Extensions

> 定位（贯穿整个开发周期）：Extension 包的本质是**给 pi 扩充连接其他 Agent 的能力**——每个包都是可发布到 pi 社区、`pi install` 可装的独立产物；完整的房间能力（manager-worker 编排、HITL 审批闭环、workspace 交接）只有 PuddingTeams 提供。
> 设计事实源：`docs/2026-08-06-通用-agent-接入-底层与扩展方案.md` §9.5（双宿主包）、§10（manifest）。

## 目录约定

```text
extensions/
├── connectors/     # Connector 包：一个目录一个 Agent 接入（双宿主：pi 入口 + Driver 入口 + 共享核心）
├── capabilities/   # Capability 包：一个目录一项业务能力（绑定到具体 Agent，投影命名空间工具）
└── shared/         # 共享核心模板与公共库（协议翻译、事件归一化，不依赖任何宿主）
```

- 每个包一个目录，目录名 = 包 id；
- Connector 与 Capability 不混放，manifest 的 `kind` 与目录一致；
- 新增包时**必须同步更新下方索引**。

## 包索引

### Connectors（`connectors/`）

| 包 | 上游 Agent | pi 入口 | Driver 入口 | 状态 |
| --- | --- | --- | --- | --- |
| codex（`connectors/codex`，`@puddingteams/connector-codex`） | Codex CLI | `pi/index.ts`（codex_delegate） | `driver/index.ts`（createDriver，多实例） | 双宿主可用 |
| claude-code（`connectors/claude-code`，`@puddingteams/connector-claude-code`） | Claude Code CLI | `pi/index.ts`（claude_delegate） | `driver/index.ts`（createDriver，多实例） | 双宿主可用 |
| echo（`connectors/echo`，`@puddingteams/connector-echo`） | 本地 echo CLI（样例 fixture） | — | —（纯 manifest，核心 DeclarativeDriver 执行） | 声明式样例可用 |
| puddingclaw（内置基线，尚在 `apps/server/src/agent-runtime/puddingclaw-extension.ts`，后续迁入本目录） | PuddingClaw CLI | — | `createDriver` | 内置可用 |
| pi（内置，尚在 `apps/server/src/agent-runtime/pi-extension.ts` + `pi-driver.ts`，后续迁入本目录做双宿主包） | 本地 pi（进程内 SDK） | — | `createDriver`（factory，多实例） | 内置可用 |

### Capabilities（`capabilities/`）

| 包 | 绑定 Agent | 能力 | 状态 |
| --- | --- | --- | --- |
| lark-cli（`capabilities/lark-cli`，`@puddingteams/capability-lark-cli`） | pinned Manager / 本地 Pi Worker | 直接从飞书官方渠道自动同步 CLI 与内嵌 `lark-*` Skills，注入 binding 隔离认证目录 | 可用（双宿主，默认未绑定） |

### Shared（`shared/`）

| 包 | 内容 | 状态 |
| --- | --- | --- |
| pwcp（`shared/pwcp`，`@puddingteams/pwcp`） | PWCP 共享核心：Driver SPI 类型 + spawn/JSONL 与 HTTP/NDJSON transport + observe 机械收集（不依赖任何宿主） | 可用 |
| templates（`shared/templates/`，非包，`.tmpl` 骨架） | `puddingteams extension init` 的模板：`connector/`（代码型双宿主包）、`connector-declarative/`（纯 manifest 声明式包） | 可用（P2-d） |

## 脚手架与校验 CLI

`puddingteams extension`（`apps/server/bin/puddingteams.mjs`，路线图 P2-d）：

```bash
# 从模板生成 Connector 包骨架（--declarative 生成纯 manifest 声明式包）
puddingteams extension init --type connector [--declarative] --id <connectorId> [--name <pkg>] [--display <name>] <dir>
puddingteams extension init --type capability --id <capabilityId> [--name <pkg>] [--display <name>] <dir>
# 校验包的 manifest / entry / Driver 导出（声明式包检查 {packageDir} 引用文件）
puddingteams extension validate <path>
```

作者文档：`docs/extensions/connector-extension.md`（双宿主包与 Driver SPI）、`docs/extensions/connector-declarative-schema.md`（声明式 schema 逐字段）。
