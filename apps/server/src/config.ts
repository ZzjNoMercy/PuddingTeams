import { fileURLToPath } from "node:url";
import path from "node:path";

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
};
