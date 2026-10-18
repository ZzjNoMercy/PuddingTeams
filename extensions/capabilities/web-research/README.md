# Web Research

独立的联网能力包：Tavily REST Search、DeepSeek 自研 Search/Fetch 裸 API、Grok Web/X Search，以及公开 HTTP(S) 网页正文抓取。无 Python、PuddingClaw Backend 或浏览器运行依赖。

- `core/`：无宿主依赖的网络、路由、供应商和工具工厂。
- `pi/index.mjs`：只使用 Pi ExtensionAPI 的门面，可以 `pi install <package>` 单独使用。
- Teams 宿主入口：`apps/server/src/network/web-research.ts`。作为平台设置级能力挂载，配置位于 **设置 → 联网**，不依赖每个 Agent 的 Capability binding。设置内「Worker 授权」按智能体分别开启搜索/网页阅读，默认关闭；未授权目标不装载工具。所有本地 Pi Worker（含 Wiki）和 Manager Solo 支持配置，第三方 Driver 使用上游自己的联网能力。Wiki 交互由宿主明确注入联网工具白名单，保留对 MCP、通用 Extension/Capability 和原生执行工具的限制；后台候选编译不会自动增加联网工具。

Teams 的设置、Worker 授权、密钥和探测记录保存在 `<PUDDINGTEAMS_HOME>/secrets/web-research/credentials.json` 的一个加密状态快照中。普通设置 API 只返回是否配置、凭据来源与测试状态。DeepSeek / Grok 可以沿用 Teams 模型页的 `deepseek` / `xai` API Key；单独配置的联网密钥优先。

搜索供应商必须启用并通过显式真实搜索测试。自动路由支持国内/全球优先顺序、最多三家回退和用户明确请求时的两源核验；X 和图片/视频搜索仅由 Grok 提供。核验只取得一家结果时显式标记未完成。修改密钥、搜索模型或代理使相应测试失效。每次工具调用读取最新配置。

DeepSeek 使用 2026-10-17 开放的自研搜索裸 API（`POST /v1/tools/search`，原始 JSON，不经模型，按成功请求计费 5 元/千次）：请求体仅 `query`（上限 128 字符，超限报错并允许回退）/`count`/`need_content:false`，域名约束仍在客户端对返回来源强制执行。不再走 Responses `web_search`（官方文档标注仅 `deepseek-v4-pro` 支持，`deepseek-flash` 静默忽略）；搜索词不带回模型正文，来源直接来自搜索引擎结构化结果。测试即一次真实 Search 调用，无结果或余额不足（402）判为失败。

抓取只接受公开 HTTP(S) 标准端口，逐跳验证 URL/DNS，实际连接固定到已经校验的地址；禁止向重定向转发搜索凭据。响应上限 5 MiB、正文上限 50,000 字符并报告截断。HTML 清理不是浏览器：不会运行脚本、登录或处理二进制/PDF。HTTP(S) 代理显式配置，CONNECT 目标固定到校验后的 IP。与 PuddingClaw 一样，198.18/15 Fake-IP 只允许域名 HTTPS，仍保持完整证书及主机名校验。

可选「抓取兜底」（`fetchFallbackEnabled`，默认关，设置 → 联网 内开关）：本地直连抓取失败且已配置 DeepSeek 密钥时，改用 DeepSeek Fetch 裸 API（`POST /v1/tools/fetch`，请求体仅 `url`，返回 `{title, content}` Markdown，按成功请求计费 5 元/千次，余额不足返回 402、无法提取正文返回 404）重试一次；目标 URL 将对 DeepSeek 可见。结果带 `via` 字段标注实际抓取通道（`direct`/`deepseek`），双失败时抛出合并错误。

独立 Pi 使用环境变量 `TAVILY_API_KEY`、`DEEPSEEK_API_KEY`、`XAI_API_KEY`。可设置 `PUDDING_WEB_RESEARCH_CONFIG` 指向非密钥 JSON 配置，覆盖 `DEFAULT_CONFIG` 中的路由/开关/模型/代理。用 `/web-research-test <provider>` 明确执行一次真实搜索测试；通过后当前 Pi Session 可搜索。测试可能产生供应商费用。

验证：`node --test core/*.test.mjs`。


### Shared capture transport

PuddingTeams read-later reuses the host-independent core network transport. Public DNS addresses remain pinned through CONNECT. Synthetic 198.18/15 hostname HTTPS can use a local TUN directly with pinned DNS and full certificate/hostname verification; when an HTTP(S) proxy is configured, CONNECT tunnels the original hostname instead. No proxy is required solely because DNS uses Fake-IP. Literal private/synthetic URLs, plain HTTP Fake-IP and mixed private DNS records remain rejected. This does not grant the standalone pi extension Teams' persistence, curation, room, or publication workflows.
