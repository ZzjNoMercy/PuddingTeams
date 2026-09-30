# Web Research

独立的联网能力包：Tavily REST Search、DeepSeek Responses `web_search`、Grok Web/X Search，以及公开 HTTP(S) 网页正文抓取。无 Python、PuddingClaw Backend 或浏览器运行依赖。

- `core/`：无宿主依赖的网络、路由、供应商和工具工厂。
- `pi/index.mjs`：只使用 Pi ExtensionAPI 的门面，可以 `pi install <package>` 单独使用。
- Teams 宿主入口：`apps/server/src/network/web-research.ts`。作为平台设置级能力挂载，配置位于 **设置 → 联网**，不依赖每个 Agent 的 Capability binding。设置内「Worker 授权」按智能体分别开启搜索/网页阅读，默认关闭；未授权目标不装载工具。所有本地 Pi Worker（含 Wiki）和 Manager Solo 支持配置，第三方 Driver 使用上游自己的联网能力。Wiki 交互由宿主明确注入联网工具白名单，保留对 MCP、通用 Extension/Capability 和原生执行工具的限制；后台候选编译不会自动增加联网工具。

Teams 的设置、Worker 授权、密钥和探测记录保存在 `<PUDDINGTEAMS_HOME>/secrets/web-research/credentials.json` 的一个加密状态快照中。普通设置 API 只返回是否配置、凭据来源与测试状态。DeepSeek / Grok 可以沿用 Teams 模型页的 `deepseek` / `xai` API Key；单独配置的联网密钥优先。

搜索供应商必须启用并通过显式真实搜索测试。自动路由支持国内/全球优先顺序、最多三家回退和用户明确请求时的两源核验；X 和图片/视频搜索仅由 Grok 提供。核验只取得一家结果时显式标记未完成。修改密钥、搜索模型或代理使相应测试失效。每次工具调用读取最新配置。

DeepSeek 请求沿用 PuddingClaw 的 `deepseek-v4-flash` + `/responses` + `tools: [{type: "web_search"}]` + 强制 `tool_choice`，检索设置 `reasoning: {effort: "none"}`，避免默认长推理耗尽 8192 token 输出预算。未返回服务端搜索调用记录或真实来源时不能判为成功；普通回答中写出的 URL 不作为联网证据。2026-09-30 核对 [官方 Responses 兼容性文档](https://api-docs.deepseek.com/guides/responses_api/)，当前 `web_search` 被忽略；本适配器保留请求格式并以实际搜索证据判断可用性，不能把模型接口可达当作联网能力已通过。

抓取只接受公开 HTTP(S) 标准端口，逐跳验证 URL/DNS，实际连接固定到已经校验的地址；禁止向重定向转发搜索凭据。响应上限 5 MiB、正文上限 50,000 字符并报告截断。HTML 清理不是浏览器：不会运行脚本、登录或处理二进制/PDF。HTTP(S) 代理显式配置，CONNECT 目标固定到校验后的 IP。与 PuddingClaw 一样，198.18/15 Fake-IP 只允许域名 HTTPS，仍保持完整证书及主机名校验。

独立 Pi 使用环境变量 `TAVILY_API_KEY`、`DEEPSEEK_API_KEY`、`XAI_API_KEY`。可设置 `PUDDING_WEB_RESEARCH_CONFIG` 指向非密钥 JSON 配置，覆盖 `DEFAULT_CONFIG` 中的路由/开关/模型/代理。用 `/web-research-test <provider>` 明确执行一次真实搜索测试；通过后当前 Pi Session 可搜索。测试可能产生供应商费用。

验证：`node --test core/*.test.mjs`。


### Shared capture transport

PuddingTeams read-later reuses the host-independent core network transport. Public DNS addresses remain pinned through CONNECT. Synthetic 198.18/15 hostname HTTPS can use a local TUN directly with pinned DNS and full certificate/hostname verification; when an HTTP(S) proxy is configured, CONNECT tunnels the original hostname instead. No proxy is required solely because DNS uses Fake-IP. Literal private/synthetic URLs, plain HTTP Fake-IP and mixed private DNS records remain rejected. This does not grant the standalone pi extension Teams' persistence, curation, room, or publication workflows.
