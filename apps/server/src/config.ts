import { fileURLToPath } from "node:url";
import path from "node:path";
import { homedir } from "node:os";

function resolveFromThisFile(...parts: string[]): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), ...parts);
}

export const config = {
	host: process.env.HOST ?? "127.0.0.1",
	port: Number(process.env.PORT ?? 8933),
	/** Directory where pi session JSONL files live. */
	sessionDir: process.env.PUDDINGTEAMS_SESSION_DIR ?? resolveFromThisFile("../.sessions"),
	/** Working directory pi manager agents operate in (file tools target this). */
	agentCwd: process.env.PUDDINGTEAMS_AGENT_CWD ?? process.cwd(),
	/** Directory holding the worker registry (teams.json) and room configs. */
	teamsDir: process.env.PUDDINGTEAMS_TEAMS_DIR ?? resolveFromThisFile("../.teams"),
	/** Directory for encrypted worker secrets (~/.puddingteams). */
	secretsDir: process.env.PUDDINGTEAMS_SECRETS_DIR ?? path.join(homedir(), ".puddingteams"),
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
