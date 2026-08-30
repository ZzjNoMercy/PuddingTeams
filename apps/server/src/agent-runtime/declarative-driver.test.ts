import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseExtensionManifest, ExtensionCatalog } from "./extensions.js";
import { DriverRegistry } from "./driver-registry.js";
import { ExtensionRegistry } from "./extension-registry.js";
import type { AgentEvent, InvocationContext } from "./types.js";

/**
 * 路线图 P2-c：声明式 Connector（§10.3 两级模型第 1 级）+ echo 样例包。
 * echo 是本地 node 脚本 fixture（extensions/connectors/echo/cli.mjs），
 * 不依赖真实 agent 登录态，可以真 spawn 跑通 run/continue/probe 全链路。
 */

/** echo 样例包目录（纯 manifest 包，无 entry）。 */
const ECHO_PACKAGE_DIR = path.resolve(import.meta.dirname, "../../../../extensions/connectors/echo");

function echoManifestFromPackage(): Record<string, unknown> {
	const pkg = JSON.parse(readFileSync(path.join(ECHO_PACKAGE_DIR, "package.json"), "utf-8")) as Record<string, unknown>;
	return pkg.puddingteams as Record<string, unknown>;
}

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

const ctx: InvocationContext = { cwd: process.cwd(), env: process.env };

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
	const out: AgentEvent[] = [];
	for await (const e of events) out.push(e);
	return out;
}

async function installEcho(): Promise<{ drivers: DriverRegistry; entryLoaded: boolean }> {
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(freshDir("echo-ext-"), new ExtensionCatalog(), drivers);
	await registry.setDeveloperMode(true);
	const entry = await registry.install(ECHO_PACKAGE_DIR);
	assert.equal(entry.manifest.id, "echo");
	return { drivers, entryLoaded: entry.loaded };
}

test("P2-c: echo 折叠 manifest 通过校验，declarative 原样透传", () => {
	const parsed = parseExtensionManifest(echoManifestFromPackage());
	assert.equal(parsed.kind, "connector");
	assert.equal(parsed.entry, undefined, "声明式包必须无 entry");
	if (parsed.kind !== "connector") return;
	assert.equal(parsed.connector.id, "echo");
	assert.deepEqual(parsed.permissions, ["spawn"]);
	const d = parsed.connector.declarative;
	assert.ok(d, "declarative 必须透传进 ConnectorContribution");
	assert.equal(d.command, "node");
	assert.equal(d.operations.run.args[1], "run");
	assert.equal(d.output.mode, "jsonl");
	assert.deepEqual(d.capabilities.operations, ["run", "continue", "cancel"]);
	assert.deepEqual(d.capabilities.interactionKinds, []);
});

test("P2-c: declarative 校验——与 entry 互斥、capabilities 防虚标、mapping 非法拒绝", () => {
	const base = echoManifestFromPackage();
	const connector = base.connector as Record<string, unknown>;

	// declarative + entry 互斥（有代码走代码型）。
	assert.throws(() => parseExtensionManifest({ ...base, entry: "driver/index.mjs" }), /互斥/);

	// capabilities 含 respond 拒绝（声明式不支持 HITL）。
	const withRespond = {
		...base,
		connector: {
			...connector,
			declarative: {
				...(connector.declarative as Record<string, unknown>),
				capabilities: { operations: ["run", "continue", "cancel", "respond"], interactionKinds: [] },
			},
		},
	};
	assert.throws(() => parseExtensionManifest(withRespond), /respond/);

	// interactionKinds 非空拒绝。
	const withInteraction = {
		...base,
		connector: {
			...connector,
			declarative: {
				...(connector.declarative as Record<string, unknown>),
				capabilities: { operations: ["run", "continue", "cancel"], interactionKinds: ["permission"] },
			},
		},
	};
	assert.throws(() => parseExtensionManifest(withInteraction), /interactionKinds/);

	// capabilities.operations 缺 run 拒绝。
	const noRun = {
		...base,
		connector: {
			...connector,
			declarative: {
				...(connector.declarative as Record<string, unknown>),
				capabilities: { operations: ["cancel"], interactionKinds: [] },
			},
		},
	};
	assert.throws(() => parseExtensionManifest(noRun), /必须含 "run"/);

	// 未声明 operations.continue 却虚标 continue 拒绝。
	const decl = connector.declarative as Record<string, unknown>;
	const phantomContinue = {
		...base,
		connector: {
			...connector,
			declarative: { ...decl, operations: { run: (decl.operations as Record<string, unknown>).run } },
		},
	};
	assert.throws(() => parseExtensionManifest(phantomContinue), /continue/);

	// mapping 非法 key 拒绝。
	const badKey = {
		...base,
		connector: {
			...connector,
			declarative: {
				...decl,
				output: { mode: "jsonl", mapping: { threadId: "$.session_id@session.started" } },
			},
		},
	};
	assert.throws(() => parseExtensionManifest(badKey), /非法 key/);

	// mapping 非法 value 格式拒绝。
	const badValue = {
		...base,
		connector: {
			...connector,
			declarative: {
				...decl,
				output: { mode: "jsonl", mapping: { content: "text@message.completed" } },
			},
		},
	};
	assert.throws(() => parseExtensionManifest(badValue), /格式非法/);

	// operations.run 必填。
	const noRunOp = {
		...base,
		connector: { ...connector, declarative: { ...decl, operations: {} } },
	};
	assert.throws(() => parseExtensionManifest(noRunOp), /operations\.run/);
});

test("P2-c: install(echo 包目录) 后 DriverRegistry 可创建 echo Driver", async () => {
	const { drivers, entryLoaded } = await installEcho();
	assert.equal(entryLoaded, true);
	const driver = drivers.create("echo", "spawn", {});
	assert.ok(driver, "声明式 Driver 必须注册进 DriverRegistry");
	assert.equal(driver!.id, "echo");
});

test("P2-c: echo capabilities——诚实声明 run/continue/cancel、无 HITL、stream、spawn", async () => {
	const { drivers } = await installEcho();
	const driver = drivers.create("echo", "spawn", {})!;
	assert.deepEqual(await driver.capabilities(), {
		operations: ["run", "continue", "cancel"],
		interactionKinds: [],
		progress: "stream",
		transport: "spawn",
		cancelConfirmation: "observable",
		workspace: { honorsInvocationCwd: true, readOnlyEnforcement: "none", mutationObservation: ["git_diff", "filesystem_diff"] },
		verification: { modalities: ["cli"], freshSession: true, workspaceIsolation: ["mutation_guard", "isolated_copy"], commandExecution: true, guiObservation: false, networkObservation: true },
	});
});

test("P2-c: echo run——真 spawn 跑通，mapping 归一出 completed 边界", async () => {
	const { drivers } = await installEcho();
	const driver = drivers.create("echo", "spawn", {})!;
	const progress: string[] = [];
	const events = await collect(
		driver.run({ message: "你好", requestId: "req-1" }, { ...ctx, onUpdate: (c) => progress.push(c) }),
	);
	assert.equal(events[0]!.type, "started");
	const last = events.at(-1)!;
	assert.equal(last.type, "completed");
	if (last.type !== "completed") return;
	assert.equal(last.result.content, "ECHO: 你好");
	assert.ok(last.result.sessionHandle?.startsWith("echo-"), `sessionHandle=${last.result.sessionHandle}`);
	assert.ok(last.result.runHandle?.startsWith("run-"), `runHandle=${last.result.runHandle}`);
	assert.equal(last.result.usage?.inputTokens, 10);
	assert.equal(last.result.usage?.outputTokens, 5);
	// progress mapping 命中的文本实时外送；content 不外送（避免与终态重复）。
	assert.ok(progress.includes("echo 处理中"), `progress=${JSON.stringify(progress)}`);
	assert.ok(!progress.some((p) => p.startsWith("ECHO:")), "content 不得经 onUpdate 外送");
});

test("P2-c: echo continue——sessionHandle 透传给 CLI 并回到边界", async () => {
	const { drivers } = await installEcho();
	const driver = drivers.create("echo", "spawn", {})!;
	const events = await collect(
		driver.continue({ message: "继续", requestId: "req-2", sessionHandle: "echo-fixed-1" }, ctx),
	);
	assert.equal(events[0]!.type, "started");
	if (events[0]!.type === "started") assert.equal(events[0]!.sessionHandle, "echo-fixed-1");
	const last = events.at(-1)!;
	assert.equal(last.type, "completed");
	if (last.type !== "completed") return;
	assert.equal(last.result.sessionHandle, "echo-fixed-1");
	assert.equal(last.result.content, "ECHO: 继续");
});

test("P2-c: echo probe——detected true，versionRegex 提取 upstreamVersion", async () => {
	const { drivers } = await installEcho();
	const driver = drivers.create("echo", "spawn", {})!;
	const probe = await driver.probe(ctx);
	assert.equal(probe.detected, true);
	assert.equal(probe.upstreamVersion, "0.1.0");
	assert.equal(probe.transport, "spawn");
	assert.deepEqual(probe.issues, []);
});

test("P2-c: echo respond 防御性失败——声明式不支持 HITL", async () => {
	const { drivers } = await installEcho();
	const driver = drivers.create("echo", "spawn", {})!;
	const events = await collect(
		driver.respond({ runHandle: "r1", interactionHandle: "i1", requestId: "q1", responses: [] }, ctx),
	);
	assert.equal(events.length, 1);
	assert.equal(events[0]!.type, "failed");
	if (events[0]!.type !== "failed") return;
	assert.equal(events[0]!.result.errorCode, "interaction_unsupported");
	assert.equal(events[0]!.result.recoverable, false);
});

test("P2-c: 无 operations.continue 的声明式 Driver——continue 报 operation_unsupported", async () => {
	const manifest = echoManifestFromPackage();
	const connector = manifest.connector as Record<string, unknown>;
	const decl = connector.declarative as Record<string, unknown>;
	connector.declarative = {
		...decl,
		operations: { run: (decl.operations as Record<string, unknown>).run },
		capabilities: { operations: ["run", "cancel"], interactionKinds: [] },
	};
	const dir = freshDir("echo-norun-");
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), drivers);
	await registry.setDeveloperMode(true);
	// 用临时目录写一份改造过的折叠 manifest（不动 echo 包本体）。
	const { mkdirSync, writeFileSync, copyFileSync } = await import("node:fs");
	const pkgDir = path.join(dir, "echo-no-continue");
	mkdirSync(pkgDir, { recursive: true });
	writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "echo-no-continue", type: "module", puddingteams: manifest }));
	copyFileSync(path.join(ECHO_PACKAGE_DIR, "cli.mjs"), path.join(pkgDir, "cli.mjs"));
	await registry.install(pkgDir);
	const driver = drivers.create("echo", "spawn", {})!;
	const events = await collect(
		driver.continue({ message: "x", requestId: "req-3", sessionHandle: "s-1" }, ctx),
	);
	assert.equal(events.length, 1);
	assert.equal(events[0]!.type, "failed");
	if (events[0]!.type !== "failed") return;
	assert.equal(events[0]!.result.errorCode, "operation_unsupported");
	assert.equal(events[0]!.result.recoverable, false);
});
