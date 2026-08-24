# PuddingTeams

PuddingTeams 是一个面向持续工程工作的多 Agent 协作系统。它用房间保存共同目标、执行状态与交付，通过 Connector 接入不同 Agent，并让人的审批发生在同一条可恢复的协作链上。

## Documents

- 在线文档：<https://teams.puddingai.com/docs/>
- 本地文档：`pnpm docs:dev`，默认访问 <http://localhost:8936/docs/>
- 文档源码：[`apps/docs`](apps/docs)

项目定位、当前版本、安装入口与最短上手路径维护在本 README；架构、协议、部署、Harness、Session Goal 与 Extension 开发细节维护在 Documents，并与代码一起版本化。

## 本地开发

```bash
pnpm install
pnpm dev
```

单独启动服务、Web 或文档：

```bash
pnpm dev:server
pnpm dev:web
pnpm docs:dev
```

## 验证

```bash
pnpm typecheck
pnpm docs:build
```

更细的模块边界、构建命令和工程约定见 [`AGENTS.md`](AGENTS.md)。
