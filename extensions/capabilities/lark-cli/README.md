# @puddingteams/capability-lark-cli

飞书工作台 Capability。官方 CLI 与同版本 Skills 用于 Agent Bash 操作；平台配置、授权、续期和连接检查直接走官方 HTTP，不依赖 CLI 安装。共享核心 `connection.ts` 不依赖 Pi 或 Driver；加密存储和二维码由宿主注入。

## 使用

1. 设置 → 飞书默认应用：已有连接优先点击「导入本机已有连接」，不发起新授权。macOS 导入只读官方加密文件和钥匙串，不降级、不改写原存储。
2. 没有应用时配置应用 ID 与密钥；密钥仅加密保存在后端。
3. 扩展 → 连接状态：查看共享连接；需要恢复或增权时授权。
4. Manager / Pi Worker 绑定插件即可，不重复登录或手动添加全部 Skills。缺少 CLI 时单独确认安装，不影响平台授权。

## 一套凭证、两个入口

共享记录位于 `<PUDDINGTEAMS_HOME>/secrets/connections/feishu/credentials.json`，应用密钥、用户访问/刷新令牌和应用令牌放在同一个 AES-256-GCM 加密记录。密钥文件 `credentials.key` 为 0600。这与平台 CredentialsStore 的本机文件保护边界一致，不是对拥有同一用户目录访问权的进程的安全隔离。

平台与 CLI 都可重新授权、续期，结果更新同一个记录。后端已有数据目录单写者 lease；共享核心以同一队列串行化轮换。刷新前持久化 pending 标记，新令牌落盘后再返回。崩溃、网络结果不确定或轮换后落盘失败时不重放旧刷新令牌，明确提示恢复。

后端使用官方 Device Flow，不需要网页 redirect 配置：

- `https://accounts.feishu.cn/oauth/v1/device_authorization`
- `https://accounts.feishu.cn/oauth/v3/token`
- `https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`
- `https://open.feishu.cn/open-apis/authen/v1/user_info`

授权弹窗本地生成二维码，展示后才开始有限时轮询。取消不撤销已有权限。重新授权复用既有范围；首次只申请基础身份与 `offline_access`，业务权限按需追加。开发者后台权限、用户授权和运行时增权仍是不同层次。

## CLI 执行入口

平台向绑定 Session 的 PATH 注入 `<capability-shared>/bin/lark-cli` 薄入口。业务命令原样交给官方二进制，不重写飞书业务 CLI。每次调用经随机密钥保护的私有 loopback broker 取得有效 Access Token，仅注入这一子进程的官方环境变量 Credential Provider。不向 Worker 长会话注入 App Secret、Refresh Token 或静态 Access Token。

```bash
lark-cli calendar +agenda --as user
lark-cli auth status --json --verify
lark-cli auth login --domain calendar --no-wait --json
lark-cli auth login --device-code <session-reference>
lark-cli auth refresh --as user
```

`--no-wait` 返回的 device_code 是平台随机会话引用，不是真实设备码。平台和 CLI 发起的流程都写回共享记录。`auth logout` 清除共享用户凭证，两边同时退出。用户调用默认不隐式切换 bot；只有显式 `--as bot` 才取得应用令牌。同一应用重新配置保留用户授权，切换应用需确认并清除不匹配凭证。

broker 不挂在公共 Web API，拒绝浏览器 Origin、无密钥请求和任意 URL。后端重启后，已有 Session 的 broker 引用需重建。平台外的原始全局 CLI 不会被覆写，不宣称自动连接平台；在平台内通过 PATH 入口调用才是共享连接。macOS 原有 DPoP 签名绑定不能伪装成 Bearer 导入，会明确拒绝并保留原授权。其他系统的本机授权导入尚未实现。

## CLI / Skills 与独立 Pi

探测只查 CLI 路径/版本，安装须显式确认。Session 创建时按六小时新鲜度调用官方更新，再通过 `skills list/read` 导出同版本资源到各绑定缓存。CLI 共享、Skills 按 Worker 保管、认证不再按绑定隔离。同步失败保留当前版本。

`pi install npm:@puddingteams/capability-lark-cli` 的独立 Pi 门面沿用官方本机认证与全局 Skills，不隐式启动平台。宿主服务注入不会让共享核心依赖宿主。

## 官方参考

- [令牌刷新 v3](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token-v3)
- [自研 Agent 接入官方 CLI](https://open.feishu.cn/document/mcp_open_tools/feishu-cli/embed-feishu-cli-in-agent)
