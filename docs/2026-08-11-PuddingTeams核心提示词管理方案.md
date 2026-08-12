# PuddingTeams 核心提示词管理方案

> 日期：2026-08-11  
> 状态：**PuddingTeams 提示词管理核心事实源**；目标方案已落地（2026-08-11，见 §8）。  
> 适用范围：基于 Pi 的 Manager 提示词装配、Pi Worker 运行指令、Window 协作、Global/Workspace context，以及非 Pi Worker 向 Pi manager 暴露的路由信息。  
> 关联总设计：`2026-08-06-通用-agent-接入-底层与扩展方案.md`、`2026-08-05-房间即群聊-产品模型方案.md`。

## 1. 结论

本文是 PuddingTeams 核心提示词管理文档。**PuddingTeams 基于 Pi 构建，Pi 是核心 Agent Harness 与 manager 运行时；PuddingTeams 的提示词管理就是对 Pi ResourceLoader、Extension 生命周期和最终 system prompt 的产品化适配。**

本地 Pi Worker 可以复用同一套 Pi 资源装配；非 Pi Worker 仍由各自 Connector/Driver 运行，不自动继承本文的 Pi system prompt。它们只把 `description`、`responsibility`、能力事实和委托工具暴露给 Pi manager，并接收 manager 生成的具体任务文本。

PuddingTeams 是以 pi manager 为编排核心的产品，但“所有能力服务于 manager”不等于“所有提示词都发给 manager”。必须按接收者拆成两条控制面：

1. **Manager 路由控制面**：告诉 manager 有哪些 Worker、何时选择谁、责任边界和群聊如何协作。
2. **Worker 运行控制面**：告诉被选中的 Worker 接到任务后如何执行、验证和交付。

同一个字段不得同时承担这两个方向。尤其不能把 Worker 的长运行指令塞进 manager roster，也不能把 manager 的群聊调度规则重复发送给 Worker。

PuddingTeams 还必须遵守以下底线：

- 不替换、不复制、不持久化 pi 内嵌默认 system prompt；
- Agent/Worker 专属运行指令只能以追加方式注入；
- `AGENTS.md` / `CLAUDE.md` 由用户在文件系统中维护，前端不编辑其正文；
- `~/.pi/agent/AGENTS.md` 是 pi global context，不是 Workspace，也不是 Agent Profile；
- Direct 单聊不提供可编辑 Window Prompt；Group 群聊才有用户可编辑的协作提示词。

## 2. “Worker 专属提示词”必须拆成两个概念

“Worker 专属提示词”存在两种相反的可见性，不能再用一个含糊名称表达：

| 概念 | 回答的问题 | 接收者 | 当前数据来源 |
| --- | --- | --- | --- |
| Manager 路由信息 | 这个 Agent 是谁、何时选它、负责和不负责什么 | pi manager | `description`、`responsibility`、`capabilities`、委托工具描述 |
| Agent 运行指令 | 这个 Agent 接到任务后应如何工作、验证和交付 | 当前 Agent 自己 | Pi Agent 的 `piResources.systemPrompt`（目标语义为 append-only） |

### 2.1 `description` 保留原名

不把 `description` 改名为 `routingSummary`。`description` 是 Connector 无关的通用字段，同时承担卡片展示、搜索和 manager 路由摘要，改成路由专用名称反而会缩窄其产品语义。

但字段注释和前端帮助文案必须固定其边界：

```ts
/**
 * Agent 的简短描述。
 *
 * 主要提供给 pi manager，用于 roster 展示、工具检索和委托路由，
 * 说明该 Agent 适合处理什么任务；同时可用于通用 UI 展示。
 *
 * 它不是 Worker 自己的运行提示词，不替代 responsibility，
 * 也不构成能力或权限证明。
 */
description: string;
```

前端帮助文案：

> 提供给 Manager，用于识别、搜索和选择该 Agent；不会作为该 Worker 的运行提示词。

### 2.2 `responsibility` 是结构化路由与停止边界

`responsibility.domain/owns/excludes/escalateWhen` 只提供给 manager，辅助多 Agent 选择、任务拆分、拒绝越界和升级。它不授予权限，也不替代 Connector 的真实能力声明。

`description + responsibility + capabilities + delegate tool` 共同构成 Manager 看到的 Agent 路由卡，其中：

- `description`：简短自然语言摘要；
- `responsibility`：稳定的责任与停止边界；
- `capabilities` / Driver capabilities：技术能力事实；
- delegate tool：实际可执行入口与运行期授权边界。

这些字段不是只供管理页展示。PuddingTeams 必须在运行过程中按当前 Window 的候选 Worker 集合生成 **roster 路由段**，通过 Pi Extension 的 `before_agent_start` 追加到 pi manager 本轮 system prompt，供 manager 在调用委托工具之前完成选择：

| Window | 注入 pi manager 的 Worker 路由信息 |
| --- | --- |
| Solo | 全部已启用、当前可委托的 Worker 路由卡 |
| Direct | 当前唯一成员的最小路由信息（身份、委托工具、可用状态）；无需再次比较选择 |
| Group | 当前群聊全部已启用成员的完整路由卡 |

运行时投影规则：

- 在 manager 选择 Worker **之前**注入候选集合，不是选完后才追加；
- 成员、启用状态、description、responsibility 或能力变化后，下一个 manager 回合必须读取最新值；
- 非当前 Window 成员、已禁用或已撤权的 Worker 不得出现在该 Window 的 roster；
- 路由卡只进入 pi manager，不进入任何 Worker Session；
- delegate tool description 可以镜像必要摘要以支持工具搜索，但不得形成第二份可独立编辑的路由事实源。

### 2.3 Agent Profile 改称“Agent 运行指令”

“Agent Profile”容易与“责任 Profile”混淆，也无法说明接收者。产品文案改为：

- Worker 页面：**Worker 运行指令**；
- pinned manager 页面：**Manager 运行指令**；
- 需要统一称呼时：**Agent 专属追加指令**。

帮助文案：

> 追加到当前 Agent 自己的 system prompt；Manager 不会把某个 Worker 的运行指令当作路由描述读取。

该字段可包含执行流程、输出格式、验证要求和交付约定，但不能承载：

- Window 成员关系或群聊分工；
- 某个项目的开发约定；
- Manager 选择 Worker 所需的路由摘要；
- Connector 权限或能力声明。

## 3. 基于 Pi 的核心提示词装配

PuddingTeams 的 manager 提示词直接建立在 Pi 原生装配机制上。Pi 会把多个来源拼入同一条最终 system prompt，但 ResourceLoader 内部仍有不同输入槽；PuddingTeams 必须按 Pi 的真实语义使用这些槽位：

| 来源 | 维护者 | PuddingTeams 行为 |
| --- | --- | --- |
| pi 内嵌默认 system prompt | pi 源码 | 不覆盖、不复制、不写入用户配置 |
| `SYSTEM.md` | 用户通过 pi 原生文件维护 | 不创建、不编辑；若用户主动提供，沿用 pi 原生替换语义 |
| `APPEND_SYSTEM.md` | 用户通过 pi 原生文件维护 | 不创建、不编辑；保留 pi 原生发现结果 |
| `~/.pi/agent/AGENTS.md` | 用户在文件系统维护 | 作为 global context 加载，前端不编辑 |
| Workspace `AGENTS.md` / `CLAUDE.md` | 项目文件工作流 | 按显式 Workspace 与加载开关决定是否加载，前端不编辑正文 |
| Agent 运行指令 | PuddingTeams Agent 配置页 | 追加到当前 Agent，不写任何 pi/Workspace 文件 |
| Window collaboration | PuddingTeams 群聊设置 | 只追加到当前 Group 的 manager，不传给 Worker |

目标装配伪代码：

```ts
const customPrompt = piNativeSystemMd; // 没有则保持 undefined，由 pi 生成内嵌默认文本

const appendSystemPrompt = [
  ...piNativeAppendSystemPrompt,
  agentRuntimeInstructions,
  groupWindowCollaboration, // 仅 Group manager
].filter(Boolean);

const contextFiles = [
  piGlobalAgentsMd,
  ...(loadWorkspaceContext ? explicitWorkspaceContextFiles : []),
];
```

实现约束：

- Agent 运行指令和 Window collaboration 不得通过 `systemPromptOverride` 生成 `customPrompt`，否则会让 pi 跳过内嵌默认提示词；
- 应通过 `appendSystemPromptOverride` 合并，并保留 loader 已发现的 `APPEND_SYSTEM.md`；
- 关闭 Workspace context 不能简单设置 `noContextFiles: true`，因为这会同时关闭 `~/.pi/agent/AGENTS.md`；应通过 `agentsFilesOverride` 分离 global 与显式 Workspace 来源；
- PuddingTeams 不把 `APPEND_SYSTEM.md` 暴露为产品概念，只在底层保留 pi 原生行为。

## 4. Global context 与 Workspace context

### 4.1 Global 与项目文件不是同一作用域

```text
~/.pi/agent/AGENTS.md
= 所有使用同一 pi agentDir 的 Pi Session 的全局上下文
```

它会作用于 pi manager，也会作用于本地 Pi Worker。只想让 manager 看到的内容不能放在这里，应放在 Manager 运行指令、Manager 路由控制面或 Group collaboration。

```text
<Workspace>/AGENTS.md 或 CLAUDE.md
= 当前项目及其目录层级的上下文
```

具体项目的开发约定优先放在项目根目录，而不是 global 文件，避免污染其他项目。

### 4.2 输入栏“默认目录”的含义

输入栏中的“默认目录”表示 Window 当前没有绑定显式 Workspace，运行 cwd 使用平台的中立目录（缺省为 `~/.puddingteams/workspaces/unscoped`）；它不是 `~/.pi/agent`。

目标行为：

| 场景 | global `AGENTS.md` | Workspace context |
| --- | ---: | ---: |
| 默认目录、无显式 Workspace | 加载 | 无 |
| 显式 Workspace，开关开启 | 加载 | 加载 Workspace 及目录层级文件 |
| 显式 Workspace，开关关闭 | 加载 | 不加载 |

前端开关文案：

> 加载项目上下文（AGENTS.md / CLAUDE.md）  
> 加载当前聊天所选项目及其目录层级中的上下文文件；Pi global `~/.pi/agent/AGENTS.md` 不受此开关影响。

## 5. Window 类型与提示词

### 5.1 Solo

Solo 是用户与 pi manager 的自由对话：

- 使用 Manager 自己的运行指令；
- manager 通过完整 Agent 路由卡在全部启用 Worker 中选择；
- 不注入 Window collaboration。

### 5.2 Direct 单聊

Direct 已经绑定唯一 Worker，没有“选择谁”的问题，因此不展示、也不接受用户可编辑的 Window Prompt。

manager 仍恒定在场，平台必须提供不可编辑的 relay 协议：

```text
把用户消息委托给当前唯一 Worker；
manager 不自行执行；
收到结果后向用户转述；
需要追问或审批时保持原 Worker Session 连续性。
```

Direct 中：

- Worker 行为由 Worker 运行指令决定；
- manager 不应把 Worker 运行指令再读一遍；
- manager roster 可只保留目标 Worker 身份、委托工具和必要状态，不必重复注入完整多 Agent 路由材料。

### 5.3 Group 群聊

Group 才提供用户可编辑的 **群聊协作提示词**，只给当前群聊的 manager，描述多个 Worker 如何拆分、并行、交接、裁决和汇总。它不能替代每个 Worker 的运行指令，也不传给 Worker。

Group manager 同时读取成员的完整路由卡，在窗口成员集合内选择和组合 Worker。

## 6. 可见性矩阵

| 信息 | Solo manager | Direct manager | Group manager | Pi Worker |
| --- | ---: | ---: | ---: | ---: |
| pi 原生 base/append | 是 | 是 | 是 | 是 |
| Manager 运行指令 | 是 | 是 | 是 | 否 |
| Worker `description` / `responsibility` | 全部启用 Worker | 当前唯一 Worker（可精简） | 当前群聊成员 | 否 |
| Worker 运行指令 | 否 | 否 | 否 | 仅当前 Worker |
| Direct 固定 relay | 否 | 是 | 否 | 否 |
| Group collaboration | 否 | 否 | 是 | 否 |
| pi global `AGENTS.md` | 是 | 是 | 是 | 是 |
| 当前 Workspace context | 按开关 | 按开关 | 按开关 | 按同一 Delegation cwd 与开关 |
| Manager 委托的具体任务 | 不适用 | manager 生成 | manager 生成 | 是 |

## 7. 前端信息架构

Agent 配置页：

```text
概览
  ├─ 描述
  │    给 Manager 做识别、搜索和选择；同时用于通用 UI 展示
  └─ 责任边界
       给 Manager 做路由、停止和升级判断

提示词与资源（仅支持该资源模型的 Connector）
  ├─ Agent 运行指令
  │    追加给当前 Agent 自己
  ├─ 加载项目上下文
  │    只控制显式 Workspace；不控制 pi global AGENTS.md
  ├─ Skills
  └─ Prompt templates
```

Window 配置：

```text
Solo   不显示协作提示词
Direct 不显示协作提示词；平台使用固定 relay
Group  显示“群聊协作提示词”
```

本核心文档中的 Agent 运行指令装配只适用于 pinned Pi manager 与 Pi Worker。非 Pi Worker 不应因为存在 `description` 就被假定支持 Pi system prompt；它们的私有运行提示由各自 Connector/Driver 定义，不进入 PuddingTeams 的 Pi ResourceLoader。

## 8. 当前实现差距

> 实现状态（2026-08-11）：以下 5 项已全部落地并通过测试（server 222/222）。

1. ~~`piResources.systemPrompt` 和 Window guidance 通过 `systemPromptOverride` 注入~~ **已落地**：改经 `appendSystemPromptOverride` 追加（`pi-resources.ts appendPiPrompts`，manager 与 pi worker 三个装配点统一），pi 内嵌默认提示词与用户 `APPEND_SYSTEM.md` 均保留在前。
2. ~~`loadWorkspaceContext=false` 映射为 `noContextFiles=true`~~ **已落地**：改用 `agentsFilesOverride` 只剔除显式 Workspace 及目录层级文件，`~/.pi/agent/AGENTS.md` 始终保留（`piResourceLoaderOptions`）。
3. ~~Direct 数据模型/API 允许 `window.prompt`~~ **已落地**：`TeamsStore.createWindow`/`updateWindow` 对 Direct 非空 prompt 直接抛错（`""` 允许用于清除历史值）；`resolveGuidance` 对 Direct 恒定返回固定 relay；前端仅 Group 显示协作提示词入口。
4. ~~前端“系统提示词（Agent Profile）”命名相撞~~ **已落地**：统一改称「Manager/Worker 运行指令」与「责任边界」，并标注接收者（配置页 `prompt-section.tsx`/`overview-section.tsx`/`agent-manage-dialog.tsx`）。
5. ~~有效提示词预览为占位文案~~ **已落地**：preview 按最终真实顺序分段——pi-base、pi-native-append（APPEND_SYSTEM.md）、agent-instructions、window-collaboration、global-context、workspace-context（`previewPiResources`）。

## 9. 验收标准

1. 配置任意 Pi Worker 运行指令后，最终提示词仍包含 pi 内嵌默认文本。
2. 已有 `APPEND_SYSTEM.md` 时，保存 Worker 运行指令不会覆盖或丢弃其内容。
3. Manager roster 包含 `description` 与 `responsibility`，但不包含 Worker 运行指令正文。
4. Worker Session 包含自己的运行指令，但不包含 Group collaboration 或其他 Worker 的路由卡。
5. Direct 页面无 Window Prompt 编辑入口；服务端拒绝或清除 Direct 自定义 Window Prompt。
6. Group collaboration 只进入该 Group manager Session。
7. 关闭项目上下文后，显式 Workspace 文件消失，但 `~/.pi/agent/AGENTS.md` 仍保留。
8. “默认目录”不被解释或展示为 `~/.pi/agent`，且不意外加载 PuddingTeams 源码仓库上下文。
9. 前端所有提示词字段都明确标注接收者和作用范围。
