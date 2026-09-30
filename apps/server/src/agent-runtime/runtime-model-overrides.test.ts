import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexDriver } from "@puddingteams/connector-codex/driver";
import { ClaudeCodeDriver } from "@puddingteams/connector-claude-code/driver";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { LocalPiDriver } from "./pi-driver.js";

for (const kind of ["codex", "claude-code"] as const) {
	test(`${kind} run/continue forwards model and effort to the CLI, then restores defaults`, async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pt-runtime-model-"));
		const command = path.join(dir, "fixture-cli");
		const argvFile = path.join(dir, "argv.json");
		writeFileSync(command, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(kind === "codex" ? '{"type":"thread.started","thread_id":"same-thread"}\n{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n' : '{"type":"result","subtype":"success","result":"ok","session_id":"same-thread"}\n')});\n`);
		chmodSync(command, 0o755);
		const driver = kind === "codex" ? new CodexDriver({ command, model: "configured", effort: "medium" }) : new ClaudeCodeDriver({ command, model: "configured", effort: "medium" });
		const context = { cwd: dir, env: process.env };
		for (const mode of ["run", "continue"] as const) {
			const input = { message: "test", requestId: mode, sessionHandle: "same-thread", options: { runtimeModel: { model: "override", effort: "high" } } };
			for await (const _event of driver[mode](input, context)) { /* drain the real spawn boundary */ }
			const args = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
			assert.equal(args[args.indexOf(kind === "codex" ? "-m" : "--model") + 1], "override");
			assert.ok(kind === "codex" ? args.includes('model_reasoning_effort="high"') : args[args.indexOf("--effort") + 1] === "high");
			if (mode === "continue") assert.ok(args.includes("same-thread"));
		}
		for await (const _event of driver.continue({ message: "default", requestId: "reset", sessionHandle: "same-thread" }, context)) {}
		const args = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
		assert.ok(args.includes("configured"));
		assert.ok(kind === "codex" ? args.includes('model_reasoning_effort="medium"') : args[args.indexOf("--effort") + 1] === "medium");
	});
}

test("pi applies per-turn settings on a resumed session and restores its original defaults", async () => {
	const driver = new LocalPiDriver();
	const manager = SessionManager.inMemory();
	const session = {
		sessionManager: manager,
		model: { provider: "fixture", id: "default" },
		thinkingLevel: "medium",
		async setModel(model: { provider: string; id: string }) { this.model = model; },
		setThinkingLevel(level: string) { this.thinkingLevel = level; },
	};
	const internals = driver as unknown as {
		resolveModel(ref: string): Promise<{ provider: string; id: string }>;
		applyRuntimeModel(session: unknown, settings?: { model?: string; effort?: string }): Promise<void>;
	};
	internals.resolveModel = async (ref) => ({ provider: ref.split("/")[0]!, id: ref.split("/")[1]! });
	await internals.applyRuntimeModel(session, { model: "fixture/override", effort: "high" });
	assert.equal(session.model.id, "override");
	assert.equal(session.thinkingLevel, "high");
	await internals.applyRuntimeModel(session, {});
	assert.equal(session.model.id, "default");
	assert.equal(session.thinkingLevel, "medium");
	assert.equal(manager.getEntries().filter((entry) => entry.type === "custom").length, 1);
});
