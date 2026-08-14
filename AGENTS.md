# PuddingTeams 开发约定

## 定位（贯穿整个开发周期）

Connector/Capability Extension 的本质是**给 pi 扩充连接其他 Agent 的能力**：每个 Extension 包都是可发布到 pi 社区、`pi install` 可装的独立产物（双宿主包，见设计文档 §9.5）。**完整的房间能力（manager-worker 编排、HITL 审批闭环、workspace 交接）只有 PuddingTeams 提供**——pi 入口是包的门面，Driver SPI 才是 Connector 的本体。开发任何 Extension 相关功能时都要保持这个边界：pi 适配层只用 `ExtensionAPI`，Driver 适配层只用 Driver SPI，共享核心不依赖任何宿主。

## 事实源

- 通用 Agent 接入方案（Runtime/Driver/Extension/PWCP）：`docs/2026-08-06-通用-agent-接入-底层与扩展方案.md`——改了行为必须同步对应章节。
- 房间即群聊产品模型：`docs/2026-08-05-房间即群聊-产品模型方案.md`。
- 会话记录格式与 harness 消费：`docs/2026-08-14-会话记录格式与Harness消费.md`——session JSONL 条目全集、`pudding:*` 自定义卡清单；新增 customType 或改落盘结构必须同步。

## 目录

- `apps/server`：Fastify + pi SDK 后端（Runtime、DriverRegistry、ExtensionRegistry、pi-bridge）。
- `apps/web`：Next.js 前端（`output: "export"` 静态导出；动态路由一律用查询参数，如 `/agents/config?name=`，不能用 `[param]` 动态段）。
- `extensions/`：所有插件的唯一落点——`connectors/`（Connector 包）、`capabilities/`（Capability 包）、`shared/`（共享核心 @puddingteams/pwcp 与 init 模板）。新增包必须更新 `extensions/README.md` 索引。
- `packages/puddingteams-cli`：发行 CLI（npm 包，当前 private 不发布）。零依赖 bin + `runtime/`（构建产物，gitignored）。

## 构建与验证

- server：`cd apps/server && pnpm test && pnpm typecheck`（测试用 tsx --test，不是 vitest）。
- web：`cd apps/web && pnpm typecheck && pnpm lint && pnpm build`。
- 发行打包：`pnpm build:runtime`（esbuild 单文件 bundle server/CLI + web 静态产物 + 第一方 extensions 预编译，组装到 `packages/puddingteams-cli/runtime/`）；`pnpm pack:cli` 额外产出 tgz。安装链路：`npm install -g <tgz>` → `puddingteams init` → `puddingteams start` → `puddingteams open`。发行态 server 同源托管 web 静态产物，单进程单端口。
- 不做任何 git 提交/变更，除非用户明确要求。
- 未上线项目，不做历史数据兼容：结构变化直接替换，不留兼容适配层。
