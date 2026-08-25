# @puddingteams/capability-lark-cli

飞书/Lark 工作台 Capability。CLI 与 Skills 均直接来自飞书官方
`@larksuite/cli`，本包只负责 PuddingTeams 的 Agent 绑定、官方版本同步、
环境注入、登录目录隔离和探测。

## PuddingTeams

在 Manager 或本地 Pi Worker 的配置页添加“飞书 CLI”。平台会自动完成：

- 优先检测 `PATH` 中的本机官方 `lark-cli`，并通过 `lark-cli update` 定期同步；
- 未检测到时，在当前 binding 的平台运行目录通过官方 npm 包自动安装；
- 通过 `lark-cli skills list/read` 导出 CLI 内嵌的同版本 `lark-*` Skills；
- 探测和实际创建 Session 都会触发上述准备流程，用户不需要单独更新。

探测结果只显示 CLI 来源与版本、Skills 数量、登录状态和必要的登录命令。Token
由 `lark-cli` 自己读写；PuddingTeams 只向目标 Pi Session 注入 CLI 路径与
`LARKSUITE_CLI_CONFIG_DIR`，不会把 Token 写入 Agent 配置或会话记录。
自动登录方式在使用本机 CLI 时沿用本机登录状态；平台安装 CLI 时为当前
binding 使用独立认证目录。

## 纯 pi

```bash
pi install npm:@puddingteams/capability-lark-cli
```

纯 Pi 入口会调用飞书官方更新命令同步 CLI 与全局 Skills。首次安装后执行
`/reload`，让 Pi 重新发现官方 `lark-*` Skills。
