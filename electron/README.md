# PuddingTeams Electron 客户端

Electron 只是桌面宿主：它启动与 npm CLI 同源的生产 server bundle，并用
`BrowserWindow` 加载 server 同源托管的 Next.js 静态前端。房间、Session、
Delegation、Goal、Extension 等业务逻辑不在 Electron 内复制。

macOS 使用 `hiddenInset` 原生标题栏：系统红黄绿窗口按钮嵌入左侧导航顶部，
页面头部与导航空白区域可拖动窗口；浏览器与 Windows 保持各自原生窗口框架。

## 本地配置继承

- PuddingTeams 业务数据继续使用 `PUDDINGTEAMS_HOME`，缺省为
  `~/.puddingteams`。安装客户端后会直接看到 CLI/Web 已有的房间、Agent、
  Session、Workspace、Provider 与 Extension 配置。
- pi global 继续由 pi SDK 从 `~/.pi/agent`（或显式
  `PI_CODING_AGENT_DIR`）读取。客户端不复制或迁移该目录。
- Electron `userData` 仅保存桌面日志、窗口与更新器状态，不保存第二份业务
  数据。
- 客户端会读取登录 shell 的 PATH，并合并 Homebrew、pnpm、bun、cargo、volta
  等常见目录，解决从 Finder 启动时找不到已安装 Agent CLI 的问题。

同一数据目录实行单后端写入。若 `puddingteams start` 已经启动 server，客户端
会验证数据目录指纹并复用它；客户端自己启动的 server 会在退出应用时关闭。

## 开发

```bash
pnpm dev:electron
```

该命令启动 server `:8933`、Next dev server `:8934` 和 Electron 窗口，仍使用
当前用户的 `~/.puddingteams`。需要隔离开发数据时显式设置绝对路径：

```bash
PUDDINGTEAMS_HOME=/tmp/puddingteams-dev pnpm dev:electron
```

## macOS 构建、签名与公证

arm64 单架构：

```bash
APPLE_KEYCHAIN_PROFILE=puddingclaw-notary pnpm build:electron:arm64
```

arm64 + x64：

```bash
APPLE_KEYCHAIN_PROFILE=puddingclaw-notary pnpm build:electron
```

构建配置要求登录 Keychain 中存在有效的 `Developer ID Application` 证书，
并启用 Hardened Runtime。`electron-builder` 使用
`APPLE_KEYCHAIN_PROFILE` 指定的 `notarytool` Keychain profile 公证应用；仓库
不保存 Apple ID、密码、`.p8` 私钥或证书密码。

产物位于 `electron/release/`。正式交付前继续执行：

```bash
xcrun stapler validate electron/release/mac-arm64/PuddingTeams.app
codesign --verify --deep --strict --verbose=2 electron/release/mac-arm64/PuddingTeams.app
spctl --assess --type execute --verbose=2 electron/release/mac-arm64/PuddingTeams.app
```

## Windows x64 安装器

```bash
pnpm build:electron:win:x64
```

产物位于 `electron/release/PuddingTeams-<version>-x64.exe`，使用 NSIS
辅助安装模式，允许选择安装目录，并创建开始菜单和桌面快捷方式。Windows 版
同样直接使用用户目录下的 `.puddingteams` 与 `.pi/agent`，卸载客户端不会删除
这些业务数据。

默认 Windows 构建不强制代码签名。正式对外发布前应配置受信任的 Windows
代码签名证书，否则 SmartScreen 可能显示“未知发布者”。
