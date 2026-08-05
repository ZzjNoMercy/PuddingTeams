# DeerFlow 2.0 与 PuddingClaw Harness 对比与借鉴分析

> 文档定位：外部开源项目架构调研记录，为 PuddingClaw Harness 演进提供借鉴清单。
> 调研时间：2026-08-03。
> 调研对象：deer-flow 最新源码（本地路径 `/Users/pet/Code/AI/Agent/源码合集/deer-flow`，backend `packages/harness/deerflow/` 约 431 个 Python 文件）。
> 权威顺序：本文是对比记录与建议，**不构成产品契约**；PuddingClaw 自身契约以 `docs/puddingclaw-harness-engineering.md` 与当前代码为准。

## 0. 调研背景

deer-flow 最新版（2.0，与 1.x 深度研究框架无代码关系，完全重写）自我定位为 "open-source super agent **harness**"。它把 agent 基座抽成独立可发布包 `backend/packages/harness/deerflow/`（import 路径 `deerflow.*`），上层仅盖薄应用层 `backend/app/{gateway,channels,scheduler}`，依赖方向 app→harness 单向，由 `tests/test_harness_boundary.py` 在 CI 强制。这与 PuddingClaw "Agent = Model + Harness" 的提法同构，且双方同属 LangChain/LangGraph 技术栈，对比价值高。

## 1. 核心架构差异一览

| 维度 | DeerFlow 2.0 | PuddingClaw |
|---|---|---|
| 主循环 | `langchain.agents.create_agent`（langchain 1.x 原生抽象，middleware 驱动） | `create_deep_agent`（deepagents），`backend/graph/deepagents_manager.py` 装配 |
| 治理方式 | **35 个严格排序 middleware**，全局编号 1–35 钉死在 AGENTS.md，CI 依赖方向测试守卫 | **外层三控制面**（Action / Completion / Lifecycle），20+ middleware，顺序治理相对松散 |
| 权限哲学 | 装配时过滤工具集 + 执行时 RBAC Guardrail 逐调用评估（fail-closed），**无逐工具人工审批**，唯一 HITL 是 `ask_clarification` | deny > ask > allow 管线 + 灰区 reviewer + **逐工具 HITL**，未注册 descriptor fail-closed |
| 持久化权威 | LangGraph checkpoint（full/delta 双模式）+ SQL 仓储；run 级 cancel-with-rollback | **Session JSON 为唯一跨 Run 权威**；InMemorySaver 只管活动 Run 内 HITL |
| 交付形态 | harness 为独立可发布包，app→harness 单向依赖（CI 强制） | harness 是 `backend/` 内目录；`deepagents_manager.py`（9043 行）等单文件过大 |
| 沙箱 | `Sandbox` 抽象 + Provider acquire/release（Local/Aio/E2E 可插拔） | Docker 项目沙箱（默认断网、lease 事务），默认比其 LocalSandbox 严格 |
| 完成判定 | 无 completion gate 概念 | 确定性检查先于 Rubric Grader，不接受模型自报完成 |
| 多入口 | gateway（FastAPI）+ channels（7 个 IM）+ scheduler（cron），**共享同一 run 生命周期** | Electron 壳 + HTTP/SSE 单入口 |

## 2. 逐维度对比

### 2.1 Middleware 治理

DeerFlow 的 35 个 middleware 有全局编号（InputSanitization=1 … Clarification=35 必须最后），新增 middleware 必须先确定插入序号。分工细且成对设计：

- ToolProgress（结果质量停滞）与 LoopDetection（重复 tool_call 剥除、强制收尾、记 `loop_capped`）分工明确；
- ReadBeforeWrite：读-写哈希门，未读不允许写；
- DanglingToolCallMiddleware：为被中断的 tool_call 补占位 ToolMessage，保证协议完整；
- DynamicContextMiddleware：日期/记忆等动态内容放尾部注入，system prompt 保持静态吃 prefix cache；
- ToolResultSanitization：防远程内容注入伪造工具结果。

PuddingClaw 的 20+ middleware 中不少职能对应：ToolProtocolIntegrityMiddleware ≈ DanglingToolCall；`patch_file` 的 expected_sha256 ≈ ReadBeforeWrite（我方做在工具层，对方做在 middleware 层）。差距在**顺序的显式编号与测试钉死机制**。

### 2.2 配置体系

DeerFlow 有四十多个 `config/*_config.py` 子模型聚合成 `AppConfig`，`get_app_config()` 按内容签名自动重载；哪些字段热更新、哪些必须重启由 `reload_boundary.py::STARTUP_ONLY_FIELDS` 单点声明（database/checkpointer/sandbox/channels/scheduler 等），漂移由测试钉死。PuddingClaw 的 config.json 体系功能类似，但热更边界缺少"单点声明 + 测试守卫"的纪律。

### 2.3 声明式装配与扩展点

DeerFlow 的模型（`models[].use`）、工具（`tools[].use`）、沙箱（`sandbox.use`）、MCP、middleware（`extensions.middlewares: module.Class`）全部反射加载，harness 不改代码即可被其他产品复用。PuddingClaw 工具走 `tools/toolsets.py` 硬编码注册——产品内合理，但若 harness 要沉淀为平台能力，声明式装配是分水岭。

### 2.4 子代理

双方均经原生 `task` 工具委派。DeerFlow 的工程细节更厚：

- `subagents/status_contract.py`：子代理结果做成 ToolMessage `additional_kwargs` 结构化契约（status/stop_reason/error/brief+sha256），**有 JSON fixture 保证前后端对齐**；
- `step_events.py`：从流尾部捕获子代理步骤批量持久化为 `subagent.step` 事件；
- `token_collector.py`：按子代理收集 LLM token 回调，汇总回父 Run；
- `SubagentLimitMiddleware`：并发截断（per-response 1–4，per-run 默认 6）；turn/token/loop 三轴 cap 经 `consume_stop_reason` 上报。

PuddingClaw 目前仅 `image_analyzer` 一个实例（子代理继承父 Run 冻结的 Backend 与权限上下文、能力只能收缩的设计是对的），子代理体系化时上述契约可直接参考。

### 2.5 Skills 渐进暴露

DeerFlow 两种注入模式：默认全量 `<available_skills>` 元数据进 prompt；`deferred_discovery: true` 时**只注入 `<skill_index>` 名字列表 + `describe_skill` 工具按需取 body**。另有：

- `skillscan`：确定性静态安全扫描，CRITICAL 直接阻断；
- `skill_evolution`：agent 经 `skill_manage` 工具自建/修改 custom skills，写前过安全 moderation，fail-closed；
- `SkillToolPolicyMiddleware`：按 frontmatter `allowed-tools` 动态裁剪可见工具。

PuddingClaw 有 50+ skills，走 ToolsetMiddleware 读完 SKILL.md 才激活 business toolset。索引模式省的是常驻元数据 token（量级有限且静态前缀已被 prompt cache 覆盖），主要价值在百级 skill 或不可信 skill 源场景；skillscan 与 skill 受管安装流程可互相对照。

### 2.6 上下文工程

PuddingClaw：历史 ToolMessage 后台压缩（保留最近 12 条）+ 超大结果落盘 `/large_tool_results/` + SQL result_id 分页 store。DeerFlow：Summarization 把摘要写进 `ThreadState.summary_text`（**非 messages**），由 DurableContextMiddleware 以隐藏 HumanMessage 数据块投影回请求；另有 Gateway 手动 compaction。其 DynamicContext（动态段尾部注入、system prompt 静态）正是 PuddingClaw prompt cache 前缀稳定性方案（P0 已落地，P1/P2 未完成）同向的现成参照。

### 2.7 持久化与恢复

DeerFlow 一个 `database` 配置段同时决定 LangGraph checkpointer、Store 与应用 SQL 仓储（memory/sqlite/postgres），SQLAlchemy + alembic 自动迁移（Postgres advisory lock）；run 级 cancel-with-rollback、delta 模式 fork 线性化（`_linearize_delta_checkpoint_resume`）。PuddingClaw 刻意选择 Session JSON 重建路线（跨 run 上下文投影已落地并过 E2E），不必回头；其**统一 DB 配置 + 迁移自动化**对后续 postgres 化是直接工程参考。

### 2.8 可观测性

PuddingClaw 的白盒 Trace（span 覆盖 model/tool/middleware/permission/verification/subagent）+ 前端 TraceViewer 产品化程度高于 DeerFlow 内部能力，但 `backend/observability.py` 仅 30 行结构化 metric helper，**外部 metrics/tracing 后端是空白**。DeerFlow 提供 LangSmith/Langfuse/monocle(OTel) 三 provider，且 `trace_context.py` + Gateway TraceMiddleware 用 `X-Trace-Id` ContextVar 贯通日志 `trace_id` 与 Langfuse trace——是补空白的现成模板。

### 2.9 沙箱

PuddingClaw 的 Docker 项目沙箱（默认断网、临时联网授权、lease stage/commit 事务）比 DeerFlow 默认 LocalSandbox 严格。可借鉴其抽象面：

- `env_policy.py`：**scrub 宿主机密钥环境变量**，防泄漏进沙箱；
- `/mnt/user-data/{workspace,uploads,outputs}` 虚拟路径契约，sandbox 内外路径映射统一；
- Provider acquire/release 生命周期 + per-thread LRU 复用。

### 2.10 多入口复用 run 生命周期

DeerFlow 的 channels（feishu/slack/telegram/dingtalk/wechat/wecom/discord + github webhook）经 message bus 通过 langgraph-sdk HTTP client 回连 Gateway 创建 thread/run；scheduler（cron + 租约 claim + `overlap_policy=skip` 唯一索引）**复用 Gateway run 生命周期派发，不另建执行栈**。PuddingClaw 目前是 Electron 壳 + HTTP/SSE 单入口，将来接 IM 或定时任务时这是正确姿势的样板。

## 3. PuddingClaw 更强的维度

以下为 DeerFlow 不具备或明显弱于我方的能力，对比中不应动摇：

- **逐工具 HITL 审批 + 灰区智能 reviewer**：DeerFlow 完全没有人工审批层，唯一 HITL 是 `ask_clarification`；
- **Completion/Goal 验收控制面**：确定性检查先于单 Rubric Grader、不接受模型自报完成、Goal 跨 Run 预算与验收；
- **文件编辑事务协议**：`inspect_file_version → patch_file(expected_sha256)`、外部文件 lease stage/commit 事务，比 ReadBeforeWrite 更严谨；
- **内部白盒 Trace 产品化**：span 类型覆盖 + 前端 TraceViewer；
- **Session JSON 单一权威账本**：跨 Run 上下文"原始事实完整保存、按需投影、历史证据不授予当前能力"已过 E2E。

## 4. 借鉴清单（按优先级）

| # | 借鉴项 | 来源（deer-flow） | 落点（PuddingClaw） | 成本/收益 |
|---|---|---|---|---|
| 1 | Middleware 全局顺序编号 + 顺序/依赖方向 CI 测试 | AGENTS.md 编号 1–35、`tests/test_harness_boundary.py` | 20+ middleware 排序写进 AGENTS.md；钉住 `harness/` 不反向依赖 `graph/` | 成本极低，收益直接 |
| 2 | 单文件拆分 + harness 包化目录结构（middlewares/tools/subagents/config/sandbox 平铺） | `packages/harness/deerflow/`（431 文件仍可读的核心原因） | 拆 `deepagents_manager.py`（9043 行）/`session_manager.py`（约 8000 行）/`tool_execution.py`（约 4000 行） | 中期工程，偿还最大技术债 |
| 3 | ~~Skill 索引模式（`<skill_index>` + `describe_skill` 按需取）~~ **降级为可选项**：skill 元数据（name+description，50 个约 3–5K token）是静态内容，prompt cache 前缀稳定（P0 已落地）已将其每轮边际成本压到近零；真正贵的 tool schema 与 SKILL.md 正文由 ToolsetMiddleware 渐进暴露解决。索引模式额外引入一轮工具调用延迟与"模型不知道就不去搜"的漏检风险 | `deferred_discovery` | 仅当 skill 数量增长到元数据本身成为前缀负担（百级）或接入外部不可信 skill 源时再评估 | 当前规模收益低，暂不做 |
| 4 | 子代理结构化结果契约 + step 事件持久化 + token 汇总 | `status_contract.py` / `step_events.py` / `token_collector.py` | 子代理体系化之前先立契约（含前后端对齐 fixture） | 体系化前置项 |
| 5 | trace_id ContextVar 贯通日志 + 外部 tracing（Langfuse/OTel） | `trace_context.py`、`tracing/` | 填补 `observability.py` 之外的外部可观测性空白 | 中等成本 |
| 6 | 配置热更边界单点声明 + 测试守卫 | `reload_boundary.py::STARTUP_ONLY_FIELDS` | config.json 热更边界显性化 | 低成本 |
| 7 | 沙箱 env scrub（剥离宿主机密钥环境变量） | `sandbox/env_policy.py` | 检查 DockerWorkspaceBackend 是否泄漏，缺则补 | 低成本安全项 |
| 8 | 统一 database 配置段 + alembic 自动迁移 | `database_config.py`、`persistence/bootstrap.py` | 后续 postgres 化时参考 | 随 postgres 化顺带 |
| 9 | channels/scheduler 复用同一 run 生命周期 | `app/channels/`、`app/scheduler/` | 将来接 IM/定时任务时的架构样板 | 远期参考 |
| 10 | 声明式反射装配（`use: module.Class` 模型/工具/沙箱/middleware） | `config.example.yaml`、`extensions_config.example.json` | harness 平台化时的分水岭，当前产品阶段不必提前做 | 远期，与"第二个真实产品出现后再抽取基座"的边界一致 |

## 5. 明确不借鉴的部分

- **无人工审批层的权限模型**：与 PuddingClaw 权限整体方案（项目外资源默认不可读、消息流内授权卡片）方向冲突；
- **checkpoint 作为跨 Run 权威**：PuddingClaw Session JSON 权威路线已落地并过 E2E，不回头；
- **langchain `create_agent` 替代 deepagents**：PuddingClaw 已在 deepagents 上沉淀大量 middleware 与状态 schema（39 键联合），无切换收益。
