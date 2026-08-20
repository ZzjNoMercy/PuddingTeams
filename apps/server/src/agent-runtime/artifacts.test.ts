import { test } from "node:test";
import assert from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizePuddingClawJson } from "./normalize.js";
import { PuddingClawDriver } from "./puddingclaw-driver.js";
import { handoffDirFor } from "./handoff.js";
import { ArtifactStore } from "./artifact-store.js";
import { AgentRuntime } from "./runtime.js";
import { DelegationStore } from "./delegation-store.js";
import { InteractionSecretStore } from "./interaction-secret-store.js";
import type { AgentDriver, AgentEvent, DriverCapabilities, InvocationContext } from "./types.js";

/** §15.4/§15.6：push 轨 --export、artifacts 归一化、ArtifactStore 登记。 */

function freshDir(prefix = "pt-artifacts-"): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

test("normalize：completed 解析 export.exported（原始 item + exported_path）", () => {
	const event = normalizePuddingClawJson({
		status: "completed",
		final_response: "完成",
		run_id: "r1",
		session_id: "s1",
		export: {
			directory: "/tmp/handoff",
			exported: [
				{ name: "report.md", path: "report.md", kind: "report", size: 128, exported_path: "report.md" },
				{ path: "data/out.csv", exported_path: "data/out.csv" },
			],
			skipped: [{ name: "x", reason: "source_missing" }],
		},
	});
	assert.equal(event.type, "completed");
	if (event.type !== "completed") return;
	assert.equal(event.result.artifacts?.length, 2);
	const [a, b] = event.result.artifacts!;
	assert.deepEqual(
		{ name: a!.name, path: a!.path, kind: a!.kind, size: a!.size, origin: a!.origin },
		{ name: "report.md", path: "report.md", kind: "report", size: 128, origin: "push" },
	);
	assert.equal(b!.name, "out.csv", "缺 name 时用文件名兜底");
	assert.equal(b!.origin, "push");
});

test("normalize：没有 --export 产物的 completed 不带 artifacts（不扫描兜底）", () => {
	const event = normalizePuddingClawJson({ status: "completed", final_response: "完成", artifacts: [{ name: "x", path: "x" }] });
	assert.equal(event.type, "completed");
	if (event.type !== "completed") return;
	assert.equal(event.result.artifacts, undefined, "只认 export.exported，不认未导出的声明");
});

/** 生成一个假 puddingclaw CLI：记录 argv 到 $ARGV_CAPTURE，输出固定 completed JSON。 */
function fakeCli(dir: string): string {
	const cli = path.join(dir, "fake-puddingclaw.sh");
	writeFileSync(
		cli,
		[
			"#!/bin/sh",
			'printf "%s\\n" "$@" > "$ARGV_CAPTURE"',
			'printf "%s\\n" \'{"status":"completed","final_response":"done","run_id":"r1","session_id":"s1","export":{"directory":"/x","exported":[{"name":"report.md","path":"report.md","kind":"report","size":3,"exported_path":"report.md"}],"skipped":[]}}\'',
			"",
		].join("\n"),
	);
	chmodSync(cli, 0o755);
	return cli;
}

async function collect(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const out: AgentEvent[] = [];
	for await (const e of iter) out.push(e);
	return out;
}

test("PuddingClawDriver：run/continue/respond 都传 --export <handoffDir>，artifacts 改写为 workspace 相对路径", async () => {
	const dir = freshDir();
	const ws = path.join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	const cli = fakeCli(dir);
	const driver = new PuddingClawDriver({ command: cli });

	const capture = path.join(dir, "argv-run.txt");
	const ctx: InvocationContext = { cwd: ws, env: { ...process.env, ARGV_CAPTURE: capture }, delegationId: "del-42" };
	const events = await collect(driver.run({ message: "x", requestId: "req-1" }, ctx));

	const argv = readFileSync(capture, "utf-8").trim().split("\n");
	const exportIdx = argv.indexOf("--export");
	assert.ok(exportIdx >= 0, "argv 必须包含 --export");
	assert.equal(argv[exportIdx + 1], handoffDirFor(ws, "del-42"), "导出目录按 §15.3 约定生成");

	const completed = events.find((e) => e.type === "completed");
	assert.ok(completed && completed.type === "completed");
	assert.equal(completed.result.artifacts?.[0]?.path, ".pudding/handoff/del-42/report.md", "path 改写为 workspace 相对路径");
	assert.equal(completed.result.artifacts?.[0]?.origin, "push");

	// continue 同样带 --export。
	const capture2 = path.join(dir, "argv-continue.txt");
	await collect(
		driver.continue(
			{ message: "x", requestId: "req-2", sessionHandle: "s1" },
			{ cwd: ws, env: { ...process.env, ARGV_CAPTURE: capture2 }, delegationId: "del-43" },
		),
	);
	const argv2 = readFileSync(capture2, "utf-8").trim().split("\n");
	assert.equal(argv2[argv2.indexOf("--export") + 1], handoffDirFor(ws, "del-43"));

	// respond 同样带 --export（token 经 providerState 注入）。
	const capture3 = path.join(dir, "argv-respond.txt");
	await collect(
		driver.respond(
			{ runHandle: "r1", interactionHandle: "h", requestId: "req-3", responses: [{ requestId: "p1", action: "approve" }] },
			{ cwd: ws, env: { ...process.env, ARGV_CAPTURE: capture3 }, delegationId: "del-42", providerState: { continuation_token: "tok" } },
		),
	);
	const argv3 = readFileSync(capture3, "utf-8").trim().split("\n");
	assert.deepEqual(argv3.slice(0, 2), ["agent", "respond"]);
	assert.ok(argv3.includes("--jsonl"), "respond 也必须流式透出审批后的后续事件");
	assert.equal(argv3[argv3.indexOf("--export") + 1], handoffDirFor(ws, "del-42"));
});

test("PuddingClawDriver：没有 delegationId 时不传 --export", async () => {
	const dir = freshDir();
	const ws = path.join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	const cli = fakeCli(dir);
	const driver = new PuddingClawDriver({ command: cli });
	const capture = path.join(dir, "argv.txt");
	await collect(driver.run({ message: "x", requestId: "req-1" }, { cwd: ws, env: { ...process.env, ARGV_CAPTURE: capture } }));
	assert.ok(!readFileSync(capture, "utf-8").includes("--export"));
});

test("ArtifactStore：登记（size 缺省 stat 补齐）与按 windowId/delegationId 查询", async () => {
	const dir = freshDir();
	const file = path.join(dir, "report.md");
	writeFileSync(file, "abc");
	const store = new ArtifactStore(dir, path.join(dir, "blobs"));
	await store.init();

	const seen: string[] = [];
	const off = store.onCreated((r) => seen.push(r.id));

	const a = await store.register({
		name: "report.md",
		path: file,
		kind: "report",
		origin: "push",
		producer: "puddingclaw",
		delegationId: "del-1",
		windowId: "win-1",
		workspaceId: "workspace-1",
		cwdSnapshot: realpathSync(dir),
	});
	assert.equal(a.size, 3, "size 缺省时从文件 stat 补齐");
	const b = await store.register({
		name: "out.csv",
		path: file,
		size: 99,
		origin: "observe",
		producer: "codex",
		delegationId: "del-2",
		windowId: "win-1",
		workspaceId: "workspace-1",
		cwdSnapshot: realpathSync(dir),
	});

	assert.deepEqual(seen, [a.id, b.id], "每次登记都发 artifact.created");
	assert.equal((await store.get(a.id))?.name, "report.md");
	assert.equal((await store.list({ windowId: "win-1" })).length, 2);
	assert.deepEqual((await store.list({ delegationId: "del-2" })).map((r) => r.id), [b.id]);
	assert.equal((await store.list({ windowId: "win-2" })).length, 0);
	off();
});

test("Runtime：Run 完成时把 CompletedResult.artifacts 登记进 ArtifactStore，DelegationRecord.result 带清单", async () => {
	const dir = freshDir();
	const ws = path.join(dir, "ws");
	mkdirSync(ws, { recursive: true });
	writeFileSync(path.join(ws, "report.md"), "hello");

	const capabilities: DriverCapabilities = { operations: ["run", "continue", "respond", "cancel"], interactionKinds: [], progress: "none", transport: "spawn" };
	const driver: AgentDriver = {
		id: "puddingclaw",
		async capabilities() {
			return capabilities;
		},
		async *run(): AsyncIterable<AgentEvent> {
			yield { type: "started" };
			yield {
				type: "completed",
				result: {
					agentId: "puddingclaw",
					status: "completed",
					sessionHandle: "s1",
					runHandle: "r1",
					content: "完成",
					artifacts: [{ name: "report.md", path: "report.md", kind: "report", origin: "push" }],
				},
			};
		},
		async *continue(): AsyncIterable<AgentEvent> {
			yield { type: "failed", result: { agentId: "puddingclaw", status: "failed", errorCode: "x", error: "x", recoverable: false } };
		},
		async *respond(): AsyncIterable<AgentEvent> {
			yield { type: "failed", result: { agentId: "puddingclaw", status: "failed", errorCode: "x", error: "x", recoverable: false } };
		},
		async probe() {
			return {
				extensionInstalled: true, detected: true, configured: true, authenticated: "unknown" as const, enabled: true,
				compatibility: "supported" as const, capabilities, issues: [],
			};
		},
	};

	const delegations = new DelegationStore(dir);
	await delegations.init();
	const secrets = new InteractionSecretStore(dir);
	await secrets.init();
	const artifacts = new ArtifactStore(dir, path.join(dir, "blobs"));
	await artifacts.init();
	const created: string[] = [];
	artifacts.onCreated((r) => created.push(r.id));
	const runtime = new AgentRuntime(delegations, secrets, () => driver, { ttlMs: 60_000 }, artifacts);

	const outcome = await runtime.delegate(
		{ workspaceId: "workspace-1", cwdSnapshot: realpathSync(ws), windowId: "win-1", managerSessionId: "sess-1", agentId: "puddingclaw", agentRevision: 0, message: "x", mode: "run" },
		{ cwd: ws, env: {} },
	);
	assert.equal(outcome.status, "completed");

	const registered = await artifacts.list({ windowId: "win-1" });
	assert.equal(registered.length, 1);
	const rec = registered[0]!;
	assert.equal(rec.path, realpathSync(path.join(ws, "report.md")), "workspace 相对路径登记为 canonical 绝对路径");
	assert.equal(rec.producer, "puddingclaw");
	assert.equal(rec.delegationId, outcome.delegation.id);
	assert.equal(rec.size, 5);
	assert.deepEqual(created, [rec.id], "登记触发 artifact.created");

	const persisted = await delegations.getDelegation(outcome.delegation.id);
	assert.equal(persisted?.status, "completed");
	assert.equal(persisted?.result?.artifacts?.[0]?.name, "report.md", "DelegationRecord.result 带 artifacts 清单");
});
