<div align="center">
  <img src="apps/docs/public/assets/puddingteams-avatar.png" width="112" alt="PuddingTeams" />
  <h1>PuddingTeams</h1>
  <p><strong>把不同 Agent 拉进同一间房，让目标、过程与交付持续可见。</strong></p>
  <p>本地优先的多 Agent 协作 Harness。Manager 负责编排，Worker 专注执行，人保留决策权。</p>
  <p>
    <a href="https://github.com/ZzjNoMercy/PuddingTeams/releases/latest"><img src="https://img.shields.io/badge/下载桌面版-macOS_·_Windows-111827?style=for-the-badge&logo=github" alt="下载桌面版" /></a>
    <a href="#源码部署"><img src="https://img.shields.io/badge/源码部署-Node.js_22.19+-0F766E?style=for-the-badge&logo=nodedotjs" alt="源码部署" /></a>
  </p>
</div>

<p align="center">
  <img src="apps/docs/public/assets/puddingteams-connectivity.png" width="960" alt="PuddingTeams 把内置 Connector、Extension、远程运行时和用户自己的 Agent 接入同一个 Team Room" />
</p>

PuddingTeams 1.0 把一次次独立的 Agent 调用组织成可恢复的长期协作：共同目标、Manager 计划、Worker 委托、人的审批、Workspace 与最终产物都保存在同一条事实链上。Agent 可以更换，项目和协作状态仍归用户；进程可以中断，Session、证据与交付不会随之消失。

## 基于 pi 构建的 Teams 层

PuddingTeams 以 [pi](https://github.com/earendil-works/pi) 的 coding agent SDK 为上游基座，把 pi 的 Session、Model Runtime、工具和资源装配能力扩展成面向团队协作的产品：Rooms、Manager/Worker 编排、跨 Agent Connector、Goal/WorkPlan、HITL、Workspace、Artifact 与可信验收都由 PuddingTeams 提供。

1.0 主程序**精确固化** `@earendil-works/pi-coding-agent@0.84.4`，lockfile 中配套的 pi 核心包也解析到 `0.84.4`。这不是一个未声明的 pi fork，也不是 pi 官方发行版；pi 负责单 Agent Harness 基础，PuddingTeams 在应用层增加 Teams 控制面。升级 pi 时会显式修改固定版本，并重新通过发布门禁和真实 Connector 验证，不随依赖范围自动漂移。

## 不是更多聊天窗口，而是一间真正能工作的房间

| 普通多窗口工作流 | PuddingTeams |
| --- | --- |
| 上下文靠人复制粘贴 | Room、Session 与 Goal 持久化 |
| 每次调用都像第一次见面 | Worker session handle 可续接、可恢复 |
| 多 Agent 之间责任模糊 | Manager、Worker、Delegation 边界明确 |
| 长结果淹没聊天记录 | 结果外置、摘要回传、分页回读 |
| “完成了”缺少证据 | Artifact、sealed Receipt、环境复验与完成复核 |
| 人只能在最后返工 | input required、审批与 Decision 进入时间线 |

系统坚持一个简单边界：**协作状态属于平台，执行协议属于 Connector，具体 Agent 可以替换。**

## 三种协作方式

| 模式 | 消息首先交给谁 | 最适合 |
| --- | --- | --- |
| **Solo** | pi Manager | 只给目标，让系统选择 Agent、拆分并组队 |
| **单聊** | 唯一 Worker | 已明确执行者，希望与同一个 Agent 持续工作 |
| **群聊** | pi Manager | 多个专业角色共享 Goal，并行、接力和统一验收 |

群聊不是让模型假装共享同一份上下文。共同事实由 Goal、WorkPlan、Decision、Delegation、Workspace 和 Artifact 显式保存。

## 从 `completed` 到可信验收

PuddingTeams 不把 Agent 的“我完成了”直接当成事实。正式 Goal 使用一条可追溯的验收链：

```text
Task Contract → Delegation Run → sealed ExecutionReceipt
→ Submission → VerificationRecord → Manager acceptance → Goal resolved
```

执行结束、事实复验和管理验收是三个独立状态。Runtime 会把上游结果、产物和 Workspace 指纹封装为不可变 Receipt，再把平台实际观察写入 VerificationRecord；Verifier 只能按冻结的 criterion 判断，不能临时改写验收标准；Manager 最后决定接纳、返修或阻塞。

| 验收等级 | 能证明什么 |
| --- | --- |
| `manager_review` | Manager 查看结果和至少一条证据后验收 |
| `independent_evidence_review` | 新的隔离 Reviewer 按原始 criterion 复核既有证据 |
| `environment_verified` | 新的 Verifier 在平台签发并绑定的环境中重新运行命令、检查文件或搜索结果 |

默认 WorkItem 使用 Manager review，Goal 最终收口使用 Independent review；代码、测试、构建等高置信任务可提升为 Environment Verification。CLI/代码复验默认在 `isolated_copy` 中进行，Git 写任务默认在独立 worktree 执行并在验收后提升精确 change-set。1.0 只对平台能直接绑定环境的本地 SDK/spawn Driver 声明 `environment_verified`；远程 Driver、GUI/Computer Use 和无法安全执行的副作用会 fail closed 或转人工决策。

## 已连接的 Agent

| Connector | Transport | 1.0 状态 |
| --- | --- | --- |
| pi | SDK | 内置；可作为 Manager Harness 或本地 Worker |
| Codex | Spawn | 第一方预装 Connector |
| Claude Code | Spawn | 第一方预装 Connector |
| PuddingClaw | Spawn | 第一方预装 Connector |
| 自定义 Agent | Extension | 支持 manifest、Driver SPI 与 Connector contribution |

通用 HTTP/RPC/ACP Transport、隔离 Extension Host 与社区市场不属于 1.0 承诺；代码型 Extension 当前在 Server 进程内执行，只应安装可信来源。

## 下载桌面版

前往 [GitHub Releases](https://github.com/ZzjNoMercy/PuddingTeams/releases/latest) 下载：

- `PuddingTeams-1.0.0-arm64.dmg` — Apple Silicon Mac
- `PuddingTeams-1.0.0-x64.dmg` — Intel Mac
- `PuddingTeams-1.0.0-x64.exe` — Windows 10/11 x64

桌面版内置 PuddingTeams Runtime、Web 与第一方 Connector 代码，不需要 Node.js 或 pnpm。使用 Codex、Claude Code、PuddingClaw 时，仍需自行安装并登录对应上游 CLI；模型账号和凭据始终由对应服务提供。

建议同时下载 `SHA256SUMS.txt` 校验文件完整性。macOS 正式包经过 Developer ID 签名与 Apple notarization。1.0.0 的 Windows 安装包尚未进行 Authenticode 签名，Windows 可能显示“未知发布者”或 Microsoft Defender SmartScreen 提示；继续安装前请先核对 SHA-256。

## 源码部署

适合开发、审计、二次集成或自托管。要求 Node.js 22.19.0+ 与 pnpm 10.32.1：

```bash
git clone https://github.com/ZzjNoMercy/PuddingTeams.git
cd PuddingTeams
corepack enable
pnpm install --frozen-lockfile
pnpm build:runtime
node packages/puddingteams-cli/bin/puddingteams.js init
node packages/puddingteams-cli/bin/puddingteams.js start
```

默认数据目录为 `~/.puddingteams`，生产 Server 默认只监听 `127.0.0.1:8933`。打开界面或检查运行状态：

```bash
node packages/puddingteams-cli/bin/puddingteams.js open
node packages/puddingteams-cli/bin/puddingteams.js status
node packages/puddingteams-cli/bin/puddingteams.js doctor
```

本仓库的 CLI 包是源码部署与桌面 Runtime 的内部组装入口，**不是公共 npm 安装渠道**。

## 开发

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

开发态分别启动 Server `http://127.0.0.1:8933` 与 Next.js Web `http://127.0.0.1:8934`。提交前运行完整发布门禁：

```bash
pnpm verify:release
```

## 架构一览

```text
Electron / Next.js Web
        │ HTTP + WebSocket
        ▼
Fastify Server
  ├─ Window / Session / Goal / Workspace / Artifact
  ├─ ExecutionReceipt / Verification / Settlement
  ├─ pi Manager Harness
  ├─ Agent Runtime（幂等、超时、交互、恢复）
  └─ Extension Registry
          │ Driver SPI / PWCP
          ├─ sdk   → pi
          └─ spawn → Codex / Claude Code / PuddingClaw
```

生产态中，Next.js 导出静态页面，由 Fastify 同源托管；Electron 和源码 CLI 启动的是同一份 Server bundle 与同一套业务数据。

## 文档

- [产品与概念](https://zzjnomercy.github.io/PuddingTeams/docs/)
- [部署方式](https://zzjnomercy.github.io/PuddingTeams/docs/deployment/)
- [协作模式](https://zzjnomercy.github.io/PuddingTeams/docs/room/)
- [Harness 与长结果](https://zzjnomercy.github.io/PuddingTeams/docs/harness/)
- [可信验收与环境复验](https://zzjnomercy.github.io/PuddingTeams/docs/verification/)
- [Extension 机制](https://zzjnomercy.github.io/PuddingTeams/docs/connectors/)
- [Connector 开发参考](https://zzjnomercy.github.io/PuddingTeams/docs/connector-development/)
- [运行与排错](https://zzjnomercy.github.io/PuddingTeams/docs/operations/)

文档源码位于 [`apps/docs`](apps/docs)，本地用 `pnpm docs:dev` 启动，默认地址为 `http://127.0.0.1:8936/docs/`。

## 仓库结构

```text
apps/server/              Fastify API、Agent Runtime 与状态存储
apps/web/                 Next.js / React 协作界面
apps/docs/                独立公开文档站
electron/                 macOS / Windows 桌面宿主与发行构建
extensions/connectors/    第一方 Connector
extensions/capabilities/  可复用 Capability
extensions/shared/        PWCP、共享核心与脚手架模板
packages/puddingteams-cli 源码部署与发行 runtime 入口
docs/                     工程设计、协议与实现事实源
```

## 安全边界

- 默认安全模型是本机单用户与 loopback 访问；不要把 Server 端口直接暴露到公网。
- 外部 Agent CLI 使用各自的账号、权限与凭据，PuddingTeams 不代替其安全模型。
- Extension 开发者模式不是操作系统沙箱，只安装你信任并审查过的代码。
- 漏洞请按 [SECURITY.md](SECURITY.md) 私下报告，不要公开披露。

## 参与贡献

请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。行为变化需同步对应设计事实源和公开文档，并通过 `pnpm verify:release`。

PuddingTeams 使用 [MIT License](LICENSE)。版本变化见 [CHANGELOG.md](CHANGELOG.md)，发行流程见 [RELEASING.md](RELEASING.md)。
