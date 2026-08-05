// Kill any process still bound to the dev ports before `pnpm dev` starts.
// Only ever touches PUDDINGTEAMS_DEV_PORTS (default 8933, 8934) — never 3000
// or any other port.
import { execFileSync } from "node:child_process";

const ports = (process.env.PUDDINGTEAMS_DEV_PORTS ?? "8933,8934")
	.split(",")
	.map((s) => Number(s.trim()))
	.filter(Number.isInteger);

const isWindows = process.platform === "win32";

function pidsOnPort(port) {
	try {
		if (isWindows) {
			const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
			const lines = out
				.split("\n")
				.filter((l) => l.includes(`:${port}`) && l.includes("LISTENING"));
			return [...new Set(lines.map((l) => l.trim().split(/\s+/).pop()))].filter(Boolean);
		}
		const out = execFileSync("lsof", ["-ti", `:${port}`], { encoding: "utf8" });
		return out.trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

for (const port of ports) {
	for (const pid of pidsOnPort(port)) {
		try {
			process.kill(Number(pid), "SIGKILL");
			console.log(`[kill-ports] freed port ${port} (pid ${pid})`);
		} catch {
			// already gone
		}
	}
}
