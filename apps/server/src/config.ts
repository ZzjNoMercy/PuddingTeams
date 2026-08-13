export const config = {
	host: process.env.HOST ?? "127.0.0.1",
	port: Number(process.env.PORT ?? 8933),
	/**
	 * 诊断覆盖：显式指定平台默认运行目录（无项目 Window 的 cwd、pi 会话
	 * 缺省 cwd）。缺省为 undefined —— 由 PUDDINGTEAMS_HOME/workspaces/unscoped
	 * 提供中立 cwd（见 paths.ts），不再回退到 process.cwd()。
	 */
	agentCwd: process.env.PUDDINGTEAMS_AGENT_CWD?.trim() || undefined,
	/** Max time a worker subprocess may run before the delegating tool aborts it. */
	workerTimeoutMs: Number(process.env.PUDDINGTEAMS_WORKER_TIMEOUT_MS ?? 900_000),
	/** Browser origins allowed to call the HTTP API and open WebSockets. */
	allowedOrigins: (
		process.env.PUDDINGTEAMS_ALLOWED_ORIGINS ?? "http://localhost:8934,http://127.0.0.1:8934"
	)
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
};

// 发行态 web 静态产物由本 server 同源托管，浏览器会在写请求/WS 上带自身源的
// Origin 头，必须放行，否则同源 POST/WS 反被 CORS 拦下。
config.allowedOrigins.push(
	`http://127.0.0.1:${config.port}`,
	`http://localhost:${config.port}`,
);
