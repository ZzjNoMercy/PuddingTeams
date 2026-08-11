# PuddingTeams 用户数据目录与 Workspace 上下文迁移方案

> 状态：Draft
>
> 日期：2026-08-11
>
> 核心范围：把 Session、Agent、窗口、Workspace Registry、Extension 安装、用户资源、附件、交付物与 Secret 从源码/安装目录中分离，统一到 `PUDDINGTEAMS_HOME`；同时修复“无显式 Workspace 仍加载 PuddingTeams 仓库 `AGENTS.md`”的问题。
>
> 默认用户目录：macOS/Linux 为 `~/.puddingteams`，原生 Windows 为 `C:\Users\<用户名>\.puddingteams`

## 1. 决策摘要

PuddingTeams 必须在 npm CLI/Electron 分发前完成用户目录迁移。当前 `apps/server/.sessions` 和 `apps/server/.teams` 都是用户运行态，不应继续依赖源码树；`process.cwd()` 也不能继续充当“未选择项目”时的隐式 Workspace。

本方案确立以下边界：

1. **用户事实状态归用户 Home**：Agent Profile、窗口、Session、Workspace 登记、Extension 安装、用户 Skill/Prompt、头像、附件、Artifact、Credential 与运行状态统一进入 `PUDDINGTEAMS_HOME`。
2. **发布资产归只读包目录**：第一方 Connector/Capability Extension、默认配置、Schema、内置提示词和静态资源继续随 PuddingTeams 发行物发布，不复制成用户事实源，也不允许运行时修改。
3. **项目内容归显式 Workspace**：项目自己的 `AGENTS.md`、`CLAUDE.md`、`.pi/skills`、`.pi/prompts` 继续跟随项目；只有用户显式选择并信任该 Workspace 后才可读取或注入。
4. **PuddingTeams 仓库不是默认 Workspace**：无显式 Workspace 时使用用户 Home 下的中性工作目录，强制关闭 Workspace Context/Skill/Prompt 发现；不得因为 Backend 从 `apps/server` 启动就读取本仓库 `AGENTS.md`。
5. **Agent 长期指令属于用户**：设置页编辑的系统提示词、职责、资源开关和启用名单属于 Agent Profile，事实源位于用户目录；不得写入项目 `AGENTS.md`，也不得把项目文件正文复制进 Agent Profile。
6. **不保留长期兼容层**：项目尚未上线，代码直接切换新路径，不实现旧目录双读。现有开发数据如需保留，使用一次性离线导入；导入完成后运行时代码不再读取 `.teams/.sessions`。

本方案不改变 Extension 的产品定位：pi 入口仍只使用 `ExtensionAPI`，Driver 入口仍只使用 Driver SPI，共享核心仍不依赖宿主；完整房间编排、HITL 和 Workspace 交接继续只属于 PuddingTeams。

## 2. 当前问题与源码证据

### 2.1 用户状态仍写在源码树

`apps/server/src/config.ts` 当前默认：

- `sessionDir = apps/server/.sessions`
- `teamsDir = apps/server/.teams`
- `secretsDir = ~/.puddingteams`
- `agentCwd = process.cwd()`

这形成了三个不同根：源码内 Session、源码内平台状态、用户 Home Secret。实际 `teamsDir` 同时承载：

| 当前内容 | 写入方 | 性质 |
|---|---|---|
| `teams.json` | `TeamsStore` | Agent Registry、Agent Profile、Connector/Capability 绑定 |
| `windows.json` | `TeamsStore` | 窗口、成员、Session 归属、worker binding、cwd 快照 |
| `workspaces.json`、`workspaces/` | `WorkspaceStore` | 外部项目登记、平台创建的受管工作目录 |
| `delegations.json`、`interactions.json` | `DelegationStore` | 委托与公开 HITL 状态 |
| `work-states.json` | `WorkStateStore` | Session Goal、进度与复核状态 |
| `artifacts.json`、`artifact-snapshots/` | `ArtifactStore` | Artifact Registry 与冻结副本 |
| `uploads/` | `UploadStore` | 用户附件 |
| `extensions.json` | `ExtensionRegistry` | Extension 安装、来源和版本记录 |
| `product-settings.json` | `ProductSettingsStore` | 产品设置、开发者模式 |
| `avatars/` | `TeamsStore` | 用户上传的 Agent 头像 |

源码目录被删除、切分支、重新安装 npm 包或 Electron 自动更新时，这些状态都可能丢失；正式发行物目录也可能只读。

### 2.2 无项目模式错误继承源码仓库上下文

当前默认 `agentCwd = process.cwd()`。开发态从 `apps/server` 启动时，Pi Resource Loader 会沿目录发现 Workspace context；`loadWorkspaceSkills`、`loadWorkspacePrompts` 和 `loadWorkspaceContext` 又采用“未显式关闭即开启”的语义。

因此界面即使显示“无显式 Workspace”，仍可能出现：

```text
运行目录：.../PuddingTeams/apps/server
workspace-context：.../PuddingTeams/AGENTS.md
```

这不是合理的用户默认值，而是启动目录泄漏进 Agent Prompt。它同时造成：

- PuddingTeams 自身开发约定误注入用户的 Pi Agent；
- 从不同目录启动 CLI 得到不同 Agent 行为；
- clone 下来的仓库可以在用户未信任前通过 Context/Skill/Prompt 影响模型；
- “无项目”与“选择了项目”在安全边界上没有真实区别。

### 2.3 用户资源与 Pi 外部资源边界混合

> **修订（2026-08-11，用户拍板）**：本节原结论（资源 API 改写 `PUDDINGTEAMS_HOME`、Pi global 只读）已推翻。定稿模型：pi global（`~/.pi/agent`）是 manager 与 pi worker 的**共享资源层**——skills/prompts 库（含创建/上传/zip 导入，CRUD 归 PuddingTeams）、全局 `AGENTS.md` 共享基底、pi 的 auth/models/settings（只读使用）；`PUDDINGTEAMS_HOME` 是**定制层**——每个 Agent 的 systemPrompt、`enabledSkills/enabledPrompts` 选用名单、模型配置、Session 与窗口状态。执行时装配合并：Pi base（含全局 AGENTS.md）→ Agent Profile → Window collaboration → 已信任 Workspace context；选用名单经 `skillsOverride/promptsOverride` 白名单过滤（`pi-resources.ts`）。该模型已在资源库与配置页落地（见 P3 计划文档 §6 回写），不随本次目录迁移改变。

当前资源管理 API 直接操作 `getAgentDir()` 下的 Pi 全局 `skills/` 与 `prompts/`。按定稿模型这是**有意为之**：这些目录位于用户 Home 而非代码仓，且与 pi CLI 共享同一份技能/模板，是 PuddingTeams 资源库的正式位置。

需要继续遵守的边界：

- PuddingTeams 只写 pi global 的 `skills/` 与 `prompts/` 两个子目录；pi 的 `settings.json`、auth、models 不由 PuddingTeams 改写（每次会话经 loader options 显式传参）。
- 项目 Workspace 资源（`.pi/*`、`AGENTS.md`）仍属项目，发现与注入受 §7 信任门约束，PuddingTeams 不修改项目文件。
- PuddingTeams 发行包内的 Capability/Connector 属 bundled 只读来源。

### 2.4 Extension 记录仍绑定仓库绝对路径

第一方 Codex、Claude Code 和示例 Capability 当前通过 `../../../extensions/...` 仓库路径预装，`extensions.json` 保存绝对 `sourcePath`。这适合开发态热更新，但不能用于 npm tarball、Electron 安装或跨机器恢复。

发行态必须从包内只读资源目录加载 bundled Extension；用户安装的 Extension 才进入用户 Home；开发者模式的本地源码链接必须单独标记，不能伪装成已复制安装包。

## 3. 所有权与来源模型

任何新路径先按“所有者、可变性、敏感性、事实源、可移植性”分类，不以当前物理位置决定目标。

| 来源 | 示例 | 所有者 | 可写性 | 目标 |
|---|---|---|---|---|
| `bundled` | 第一方 Connector、默认提示词、Schema | PuddingTeams 发行方 | 只读 | package resources |
| `user` | Agent Profile、用户 Skill/Prompt、窗口、Session | 当前 OS 用户 | 可写 | `PUDDINGTEAMS_HOME` |
| `pi-global` | 现有 Pi 全局 Skill/Prompt、模型与认证 | 当前 OS 用户，由 Pi 管理 | PuddingTeams 默认只读 | Pi `agentDir` |
| `workspace` | `AGENTS.md`、`CLAUDE.md`、`.pi/*` | 该项目 | 项目文件工作流可写 | 显式项目目录 |
| `external-link` | 开发者模式本地 Extension 源码 | 本机开发者 | 外部维护 | Registry 只保存受控引用 |
| `runtime` | Lease、临时文件、在途锁 | 当前 PuddingTeams 实例 | 可写、可回收 | `PUDDINGTEAMS_HOME/runtime` |

必须满足以下不变量：

- 发行包可以被整体删除和替换，用户内容不丢失。
- 无显式 Workspace 时，Workspace 来源候选集为空，而不是取 `process.cwd()`。
- 未受信 Workspace 的 Context、Skill、Prompt、项目 Extension/MCP 不进入扫描、预览正文或模型 Prompt。
- 用户 Agent Profile 不能修改项目文件；项目文件也不能修改 Agent Profile、Secret、Extension 授权或 Workspace 信任状态。
- PuddingTeams 管理 API 只能修改 `origin=user` 的资源。
- Secret 与普通状态分离，API 只允许设置、替换、测试和删除，不返回完整值。

## 4. 目标目录

```text
PuddingTeams package/source
├── dist/
├── extensions/                    # 开发源码；发行时变成 package 内只读资源
│   ├── connectors/
│   ├── capabilities/
│   └── shared/
├── docs/
└── ...                            # 不再产生 .sessions/.teams

PUDDINGTEAMS_HOME/
├── config/
│   └── product.json               # 用户显式产品设置，不保存默认值快照
├── state/
│   ├── agents.json                # Agent Registry + 用户 Agent Profile
│   ├── windows.json               # 窗口、成员与 Session 引用
│   ├── workspaces.json            # 项目书签、身份、信任与授权
│   ├── delegations.json
│   ├── interactions.json          # 不含 provider continuation secret
│   ├── work-states.json
│   └── artifacts.json
├── sessions/
│   ├── <pi-session>.jsonl
│   └── workers/                   # pi worker Session（原 <pi agentDir>/puddingteams-worker-sessions）
├── extensions/
│   ├── registry.json
│   └── packages/                  # 用户安装包；开发链接不复制到这里
├── assets/
│   └── avatars/
├── uploads/
│   └── <session-id>/
├── artifacts/
│   └── blobs/                     # Artifact 冻结副本
├── workspaces/
│   ├── managed/<workspace-id>/    # 用户显式创建的受管项目
│   └── unscoped/                  # 无项目模式的中性 cwd，不加载 context
├── secrets/
│   ├── credentials.json           # 密文
│   ├── credentials.key            # 0600
│   ├── interaction-secrets.json   # 密文
│   └── interactions.key           # 0600
├── runtime/
│   ├── backend.lease              # 单写者 Lease
│   ├── locks/
│   └── tmp/
├── logs/
└── migrations/                    # 一次性开发数据导入报告和冲突备份
```

目录职责：

- `state/` 只放必须恢复的结构化事实；所有写入继续采用同卷临时文件 + 原子 rename。
- `sessions/` 只放 Pi Session JSONL，不与 Trace、临时文件或目录混排。
- 用户资源库位于 pi global（`~/.pi/agent/skills|prompts`，修订口径见 §2.3）；`sessions/workers/` 放 pi worker Session（从 pi global 迁入）。
- `workspaces/managed` 是 PuddingTeams 真正拥有的项目目录；外部 Workspace 只在 Registry 中登记绝对路径。
- `workspaces/unscoped` 只是无项目文件工具的中性 cwd，永远不启用 Workspace 资源发现。
- `artifacts/blobs` 保存冻结副本；`state/artifacts.json` 只保存 Registry 和摘要。
- `runtime/tmp`、`logs` 可按保留策略回收，不属于备份必须项。

## 5. 统一路径契约

### 5.1 唯一根目录

新增 `PuddingTeamsPaths`，所有业务模块只接收具体目录或该路径对象，不再读取环境变量、`HOME`、`process.cwd()` 或相对源码路径。

解析顺序：

1. 非空 `PUDDINGTEAMS_HOME`；
2. `path.join(os.homedir(), ".puddingteams")`。

规则：

- `PUDDINGTEAMS_HOME` 必须是绝对路径；相对路径启动失败。
- 根目录解析为规范化绝对路径，启动时验证可创建、可读写且不是普通文件。
- 测试必须注入临时 Home，禁止写开发者真实 `~/.puddingteams`。
- 保留细粒度目录注入仅供测试；生产配置不再暴露互相独立的 `SESSION_DIR/TEAMS_DIR/SECRETS_DIR` 三套默认根。
- 同一 Home 采用单写者模型；第二个 Backend 不得依赖各 Store 的进程内 Promise queue 冒险并发写 JSON。

建议接口：

```ts
class PuddingTeamsPaths {
  readonly home: string;
  readonly config: string;
  readonly state: string;
  readonly sessions: string;
  readonly resources: string;
  readonly extensions: string;
  readonly uploads: string;
  readonly artifactBlobs: string;
  readonly managedWorkspaces: string;
  readonly unscopedWorkspace: string;
  readonly secrets: string;
  readonly runtime: string;
  readonly logs: string;
  readonly migrations: string;
}
```

### 5.2 平台默认值

| 环境 | 默认/要求 |
|---|---|
| macOS | `/Users/<user>/.puddingteams` |
| Linux | `/home/<user>/.puddingteams` |
| Windows | `C:\Users\<user>\.puddingteams` |
| 自定义盘 | 显式 `PUDDINGTEAMS_HOME=D:\PuddingTeamsData` |
| Docker | 容器内显式 `PUDDINGTEAMS_HOME=/app/.puddingteams`，宿主使用 bind/named volume |
| Electron | 主进程显式传入用户数据根；不得从安装目录或 Backend cwd 推导 |

Electron 的窗口尺寸、最近窗口和更新器状态可以留在 Electron `userData`；PuddingTeams 业务事实必须使用同一 `PUDDINGTEAMS_HOME` 格式。若 Electron 选择把 Home 放在 `userData` 子目录，CLI 必须能通过显式路径打开同一份数据，而不是维护第二套 Schema。

## 6. Agent Profile、用户资源与 `AGENTS.md`

提示词所有权与可见性的核心事实源是 `docs/2026-08-11-PuddingTeams核心提示词管理方案.md`；本节只讨论用户目录与 Workspace 的存储隔离。“Agent Profile”在既有字段/迁移描述中保留，产品文案统一改称“Agent/Worker 运行指令”，避免与给 manager 的责任 Profile 淆混。

### 6.1 三种“指令”不能混为一层

| 指令类型 | 事实源 | 生效范围 | 编辑入口 |
|---|---|---|---|
| Manager 路由信息 | `state/agents.json` 的 `description`、`responsibility` 等字段 | pi manager | PuddingTeams Agent 设置页 |
| Agent/Worker 运行指令 | `state/agents.json` 的 `piResources.systemPrompt` 等字段 | 该用户的该 Agent 自己 | PuddingTeams Agent 设置页 |
| Group collaboration prompt | `state/windows.json` | 单个 Group 的 manager | 群聊设置 |
| Pi global context | `~/.pi/agent/AGENTS.md` | 使用该 pi agentDir 的 manager/Pi Worker | pi 文件工作流，PuddingTeams 前端不编辑 |
| Workspace context | 项目 `AGENTS.md`、`CLAUDE.md` 等 | 已绑定且已信任的项目中的 manager/Worker | 项目文件工作流 |

有效 Prompt 顺序继续保持：

```text
Pi 原生 base（PuddingTeams 不覆盖）
→ Pi 原生 append + 当前 Agent 运行指令
→ Group collaboration prompt（仅 Group manager）
→ Pi global context
→ 已信任 Workspace context（受项目开关控制）
```

其中：

- PuddingTeams 设置页创建的 Agent 运行指令只写用户 Home，并只注入该 Agent 自己。
- `description + responsibility` 是给 manager 的路由信息，不得与 Agent 运行指令共用正文。
- Direct 不提供可编辑 Window Prompt，只保留平台固定 relay；Group 才有 collaboration prompt。
- 项目 `AGENTS.md` 不作为 Agent Profile 的存储格式，也不能被设置页自动覆盖。
- PuddingTeams 根目录现有 `AGENTS.md` 是本项目的开发约定，可以继续留在 Git；发行时不把它当用户配置，运行时也绝不能因启动目录而加载它。
- 若用户希望把某份 `AGENTS.md` 变成个人长期指令，应执行显式“导入到 Agent Profile”，保存的是用户 Profile 内容与来源记录，不建立对仓库文件的隐式长期依赖。

### 6.2 PuddingTeams 用户资源库

资源来源按以下优先级和权限处理：

| 来源 | 默认发现 | 默认启用 | 可由 PuddingTeams 修改 |
|---|---:|---:|---:|
| bundled Capability/默认资源 | 是 | 按发行策略 | 否 |
| Pi global `agentDir`（`skills/`、`prompts/`、全局 AGENTS.md） | 是 | 按 Agent 选用名单（白名单） | **是（限 `skills/`、`prompts/` 两子目录）** |
| Workspace `.pi/*` | 仅已选择且已信任 | 按 Agent 开关 ∧ 信任门 | 否；由项目文件工作流维护 |
| extra path | 仅显式配置并批准 | 按 Agent 开关 | 否；视为外部链接 |

资源 API 的创建、更新、重命名、删除只操作 pi global 的 `skills/` 与 `prompts/`（修订后口径，见 §2.3）；列表和预览必须返回 `origin`（global/workspace/extra）、真实生效状态与诊断，不能只返回文件名让前端猜来源。

Pi `agentDir` 的其余部分（settings.json、auth、models）仍归 Pi 自己管理，PuddingTeams 只读使用，避免破坏 Pi 自身认证与模型目录；每个 Agent 选用哪些技能/模板的名单存 `PUDDINGTEAMS_HOME/state/agents.json`，装配层经 `skillsOverride/promptsOverride` 执行来源过滤。

### 6.3 无显式 Workspace 的强制行为

当窗口没有 `workspaceId` 时：

- `cwdSnapshot` 指向 `PUDDINGTEAMS_HOME/workspaces/unscoped`，不再指向 `process.cwd()`；
- `loadWorkspaceContext = false`；
- `loadWorkspaceSkills = false`；
- `loadWorkspacePrompts = false`；
- Preview 返回 `workspace: null`、`contextFiles: []`，并明确显示“无 Workspace context”；
- 前端的 Workspace context 开关禁用，不能出现“已勾选但其实加载 Backend 仓库”的状态；
- Agent Profile 和明确启用的用户/Pi 全局资源仍可正常使用。

该约束由服务端根据 `workspaceId + trust_state` 计算，不能只依赖前端传入的布尔值。

## 7. Workspace 信任门

### 7.1 Registry Schema

`state/workspaces.json` 的项目记录增加：

```ts
interface WorkspaceTrust {
  state: "pending" | "trusted" | "denied";
  decidedAt?: string;
  policyVersion: number;
  canonicalPathAtDecision?: string;
  approvedResources?: Array<"context" | "skills" | "prompts">;
}
```

信任决定只保存在用户 Home，项目文件不能声明自己已受信。首期只信任规范化后的精确目录，不自动信任父目录、同名新路径或仓库内任意兄弟目录。

### 7.2 首次选择流程

1. 用户选择一个外部目录；服务端只做路径存在性、可读性、`realpath` 和 Git Root 元数据检查。
2. 若目录含可注入资源，返回信任卡所需的安全元数据：规范化路径、Git Root、资源类型和数量；未批准前不返回正文。
3. 用户选择信任、拒绝或暂不决定。
4. `trusted` 后，Agent 自己的资源开关才有资格进一步决定是否加载 Context/Skill/Prompt。
5. `denied/pending` 时仍允许用户通过普通文件选择器显式查看文件，但不得把内容自动注入 Prompt 或执行入口。

有效条件是：

```text
显式 workspaceId
AND 路径身份仍匹配
AND trust_state = trusted
AND 对应 Agent 资源开关 = true
```

任何一项不满足，Workspace 来源均不进入候选集。

### 7.3 路径变化与撤销

- `realpath` 与信任时记录不一致：立即退回 `pending`，不得自动沿用信任。
- 用户撤销信任：所有相关活跃 Session 标记 `runtimeDirty`；当前轮结束后重建或要求新建 Session。
- Workspace Resource 内容变化不撤销整个目录信任，但预览必须显示最新来源；未来若允许项目代码型 Extension/MCP，需要额外绑定内容 digest 并单独审批。
- 删除 Workspace Registry 不删除外部项目目录；删除 managed Workspace 必须单独确认并采用可恢复删除策略。

## 8. Extension 目录边界

Extension 分为三种物理来源：

### 8.1 Bundled

- 开发态：仓库 `extensions/`。
- npm/Electron 发行态：package 内只读 `resources/extensions/`。
- 每次启动从发行 manifest 建立目录投影，不把仓库绝对路径当跨版本事实源。
- `origin=bundled`、`mutable=false`，升级随 PuddingTeams 版本进行。

### 8.2 User installed

- 安装内容复制并校验到 `PUDDINGTEAMS_HOME/extensions/packages/<id>/<version>/`。
- Registry 保存 digest、版本、来源、权限批准、engine 兼容范围和当前激活版本。
- 更新先在 staging 校验，成功后原子切换 Registry；失败保留旧版本。
- 卸载受 Agent 绑定和 active/waiting Run 保护。

### 8.3 Developer link

- 只在开发者模式可用，`origin=local-link`。
- Registry 保存规范化绝对路径、目录身份和最近 digest，但不复制源码。
- UI 持续显示“本地代码、进程内执行”的风险。
- 关闭开发者模式立即停用，不静默回退到同名 bundled/user 包。

双宿主包目录结构、Driver SPI 与 ExtensionAPI 边界不因物理迁移而改变。

## 9. 现有开发数据的一次性迁移

项目尚未上线，因此正式运行时代码直接使用新目录，不实现自动旧目录发现或双读。本节只定义一次性离线导入工具/脚本，供保留当前开发数据时手动执行。

### 9.1 前置条件

- Backend、Web 和所有 Worker 已停止。
- 新旧目录均可读写，新 Home 不被另一个 Backend 持有 Lease。
- 先备份 `apps/server/.sessions`、`apps/server/.teams` 和现有 `~/.puddingteams`。
- 导入工具默认 dry-run，输出文件数、目标映射、冲突和将被丢弃的开发态记录。

### 9.2 映射表

| 旧位置 | 新位置 | 特殊处理 |
|---|---|---|
| `.sessions/*.jsonl` | `sessions/` | 校验文件名、JSONL 与 Session ID；无项目且 cwd 指向源码仓的旧 Session 默认归档，不自动恢复 |
| `.teams/teams.json` | `state/agents.json` | 只迁用户 Agent/Profile/绑定；内置默认项由新版本 seed 后按稳定 id 合并 |
| `.teams/windows.json` | `state/windows.json` | 校验 Session 引用；剔除无法恢复的旧无项目 Session |
| `.teams/workspaces.json` | `state/workspaces.json` | 外部路径保留；所有项目初始 `trust_state=pending` |
| `.teams/workspaces/*` | `workspaces/managed/*` | 复制后重算 `rootPath/canonicalPath`，同步改写引用它的 cwd 快照 |
| `.teams/delegations.json` | `state/delegations.json` | 终态记录可迁；running/waiting 统一标记为不可恢复/expired |
| `.teams/interactions.json` | `state/interactions.json` | 与加密 continuation state 对账；孤儿记录不激活 |
| `.teams/work-states.json` | `state/work-states.json` | 仅保留引用有效窗口/Session 的记录 |
| `.teams/artifacts.json` | `state/artifacts.json` | 配合 blob 复制重写 `snapshotPath`，重新校验 SHA-256 |
| `.teams/artifact-snapshots/*` | `artifacts/blobs/*` | 先复制校验，再发布 Registry |
| `.teams/uploads/*` | `uploads/*` | 校验相对路径与 Session 归属 |
| `.teams/avatars/*` | `assets/avatars/*` | 校验 magic bytes、大小和 Agent 引用 |
| `.teams/product-settings.json` | `config/product.json` | 只保存显式用户值；未知字段拒绝或记录冲突 |
| `.teams/extensions.json` | `extensions/registry.json` | bundled 记录不迁，由发行 manifest 重建；仅迁合法 local link/user 安装记录 |
| `~/.puddingteams/credentials.json` + `secret.key` | `secrets/credentials.json` + `credentials.key` | 密文与原密钥作为一组移动并读回验证 |
| `~/.puddingteams/interaction-secrets.json` + `interaction.key` | `secrets/interaction-secrets.json` + `interactions.key` | 与公开 Interaction Registry 对账 |

### 9.3 旧无项目 Session 的处理

旧 Session 可能在创建时已经把 PuddingTeams 仓库 `AGENTS.md` 注入 Prompt，且 JSONL 内的 cwd 仍指向源码目录。导入工具不得只改一个路径后假装上下文从未发生。

默认策略：

- 不把这类 Session 恢复为可继续对话的活跃 Session；
- 将原 JSONL 放入 `migrations/legacy-unscoped-sessions/` 供人工查看/导出；
- 对应窗口创建新的 unscoped Session；
- UI 可显示“旧开发会话因上下文来源不安全未恢复”，但运行时不再读取旧文件。

显式绑定到有效外部 Workspace 的 Session 可以迁移，但 Workspace 信任状态重置为 `pending`；批准前只能查看历史，不能继续触发带项目资源的新 Turn。

### 9.4 原子性与冲突

一次性导入遵循：

1. 在新 Home 的 `migrations/staging-<id>/` 生成完整候选树。
2. 校验 JSON Schema、引用完整性、Secret 可解密性、Artifact digest 和路径边界。
3. 目标不存在才直接发布；同名不同内容写入冲突报告，不覆盖现有用户事实。
4. 使用同卷 rename 原子发布各事实源。
5. 写 `migrations/user-home-v1.json`，记录来源、摘要、数量、冲突与时间。
6. 不自动删除旧目录；确认新版本验收通过后由开发者手动归档。

## 10. 配置与 API 调整

### 10.1 配置

删除生产默认路径的分裂语义：

```text
PUDDINGTEAMS_HOME                 # 唯一用户数据根
PUDDINGTEAMS_AGENT_CWD           # 不再作为默认 Workspace；仅保留诊断/测试时的显式覆盖
PUDDINGTEAMS_SESSION_DIR         # 仅测试注入，生产不推荐
PUDDINGTEAMS_TEAMS_DIR           # 删除生产用法
PUDDINGTEAMS_SECRETS_DIR         # 删除生产用法
```

CLI 增加：

```text
puddingteams doctor paths
puddingteams data import-legacy --from <repo>/apps/server [--dry-run]
```

`doctor paths` 只显示路径、来源和可写性，不显示 Secret；同时检查 package root 是否意外产生 `.teams/.sessions`。

### 10.2 API

- Workspace Preview API 必须以显式 `workspaceId` 为输入；缺失时返回无项目结果，不能回退默认 cwd 扫描。
- Workspace API 返回 `trust_state`、路径可用性和资源类型摘要。
- Agent Resource 列表返回 `origin`、`mutable`、`enabled` 和 `trustRequired`。
- 所有返回本机路径的管理 API 只在本机受信 UI 使用；普通聊天事件和 Worker ToolResult 不泄漏 PuddingTeams Home 绝对路径。
- Secret API 继续只返回已配置键名/状态，不新增 reveal。

## 11. 分阶段实施

### Phase 0：路径基础与失败回归

- 新增 `PuddingTeamsPaths` 和临时 Home 测试夹具。
- 写失败复现：无显式 Workspace 时 Preview 不得出现仓库 `AGENTS.md`。
- 写失败复现：从任意 cwd 启动得到同一 Home 和同一无项目语义。
- 增加根级单写者 Lease。

### Phase 1：状态与 Session 直接切换

- 各 Store 改为接收 `state/`、`assets/`、`uploads/`、`artifacts/` 等具体目录。
- Session 改写入 `sessions/`。
- Secret 改写入 `secrets/`，密钥与密文权限收紧到 0600。
- 删除源码路径默认值和 `.teams/.sessions` 运行时读取。

### Phase 2：无项目 cwd 与 Workspace 信任门

- 无项目窗口冻结 `workspaces/unscoped`，服务端强制关闭 Workspace 资源。
- Workspace Registry 增加 `pending/trusted/denied`。
- Preview、创建 Session、重开 Session 和 Delegation 统一走同一个有效资源判定函数。
- 信任撤销触发 Session runtime dirty/reopen 反馈。

### Phase 3：资源库分层

- PuddingTeams Resource API 改写 `resources/skills` 和 `resources/prompts`。
- Pi global 改为外部只读来源，可启用或显式导入。
- Workspace 资源只在显式选择并信任后发现。
- UI 展示来源、可写性和实际生效状态。

### Phase 4：Extension 分层与发行资源

- 第一方包从发行资源 manifest 加载，不保存仓库路径为用户事实。
- 用户安装包进入 `extensions/packages`。
- 本地源码链接改为独立 `origin=local-link` 和开发者模式闸门。
- npm pack 后在无仓库环境验证 Codex/Claude/Capability 预装。

### Phase 5：一次性开发数据导入与清理

- 提供 dry-run/import 工具或仓库脚本，不接入正常启动流程。
- 迁移需要保留的本机开发数据并生成报告。
- 验收后停止通过 `.gitignore` 掩盖新的源码树写入；CI 检查测试后 package/source root 未产生 `.teams/.sessions`。

## 12. 测试与验收

### 12.1 路径

- macOS/Linux/Windows 默认 Home 正确。
- 自定义绝对 `PUDDINGTEAMS_HOME` 正确；相对值失败。
- 用户名含空格、中文；Windows 自定义盘符；WSL 路径。
- package/source root 只读时，启动、聊天、上传、Artifact 和 Extension 目录查询正常。
- 两个 Backend 指向同一 Home 时，第二个写实例明确失败。

### 12.2 Workspace 与 Prompt

- 从仓库根、`apps/server`、`/tmp` 启动，未选 Workspace 的 Preview 完全一致。
- 未选 Workspace：`contextFiles=[]`，Workspace Skill/Prompt 均不发现。
- `pending/denied` Workspace 不返回 Context 正文、不加载 `.pi/*`。
- `trusted` 且开关开启后才加载项目 `AGENTS.md/CLAUDE.md`。
- 撤销信任后新 Turn 不继续使用旧 Workspace Runtime。
- Agent Profile、Window Prompt、Workspace Context 的组合顺序与 Preview 一致。

### 12.3 数据完整性

- Window 引用的 Session、Workspace、Agent 均存在。
- Managed Workspace 搬迁后所有 `cwdSnapshot` 和 canonical path 同步更新。
- Artifact blob SHA-256 与 Registry 一致。
- Secret 搬迁后可解密，密钥/密文权限正确，API 不返回完整值。
- 旧无项目 Session 只归档、不自动续接。

### 12.4 Extension 与资源

- npm tarball 不依赖仓库 `../../../extensions` 路径。
- bundled/user/local-link 三种来源不会静默互相覆盖。
- PuddingTeams Resource API 不修改 Pi global 目录或 Workspace 文件。
- 关闭开发者模式后 local-link 立即不可执行。

### 12.5 完成判据

在不含源码仓、pnpm workspace 和仓库 `node_modules` 的临时环境中：

```text
npm pack → clean install → 设置临时 PUDDINGTEAMS_HOME → 启动
→ 无项目 Preview 不含任何仓库 Context
→ 创建 Agent/窗口/Session → 上传附件 → 完成一次委托并登记 Artifact
→ 重启 → 状态完整恢复
→ 选择项目 → 信任前不注入，批准后才加载 Context
→ package root 保持只读且没有新增运行态文件
```

## 13. 文档同步要求

实现行为变更时必须同步：

- `docs/2026-08-06-通用-agent-接入-底层与扩展方案.md`
  - Extension 物理来源、Registry 路径、Workspace trust 与资源装配条件；
- `docs/2026-08-05-房间即群聊-产品模型方案.md`
  - Window/Session/Workspace 的目标存储路径、无项目 cwd 与信任状态；
- `docs/2026-08-10-P3-可安装产品与项目工作区开发计划.md`
  - P3-2 用户数据目录任务与验收项；
- `docs/puddingteams-platform-design.md`
  - 删除把 `apps/server/.teams` 描述为长期运行态目录的目标结构。

在代码尚未切换前，上述事实源中的“当前实现”描述仍可保留，但应链接本方案作为迁移目标；代码完成后再把旧 `.teams/.sessions` 路径改为历史说明，避免文档先于实现声称已完成。

## 14. 非目标

- 不在本次迁移中实现真正的多租户存储；一个 Home 对应一个本地可信用户。
- 不把 Pi 的模型认证和全部 `agentDir` 复制到 PuddingTeams Home。
- 不把项目 `AGENTS.md` 自动搬到用户 Home，也不让 Agent 设置页编辑项目文件。
- 不实现项目级代码 Extension/MCP 的自动信任；若未来支持，必须在目录信任之外增加 digest 审批。
- 不为了迁移引入 SQLite 或数据库重构；现有 JSON/JSONL Store 先完成路径与所有权纠偏。
- 不做长期旧目录兼容、启动时双读或自动删除开发者旧数据。
