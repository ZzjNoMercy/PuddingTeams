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

// Reap orphaned dev watchers from previous runs. Ctrl+C on `pnpm --parallel`
// does not propagate to children, so `tsx watch` / `next dev` processes leak
// and keep holding thousands of file descriptors (EMFILE) unless killed.
// The pattern is anchored to this project's root so other projects' dev
// servers (e.g. PuddingClaw running in parallel) are never touched.
if (!isWindows) {
	const projectRoot = new URL("..", import.meta.url).pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = `${projectRoot}.*(tsx/dist/cli\\.mjs watch|node_modules/\\.bin/next dev)`;
	try {
		const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
		for (const pid of out.trim().split("\n").filter(Boolean)) {
			if (Number(pid) === process.pid) continue;
			try {
				process.kill(Number(pid), "SIGKILL");
				console.log(`[kill-ports] killed orphaned dev watcher (pid ${pid})`);
			} catch {
				// already gone
			}
		}
	} catch {
		// pgrep found nothing
	}
}
