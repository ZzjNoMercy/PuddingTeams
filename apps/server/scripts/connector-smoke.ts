import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "../src/agent-runtime/runtime.js";
import { DelegationStore } from "../src/agent-runtime/delegation-store.js";
import { DriverRegistry } from "../src/agent-runtime/driver-registry.js";
import { ExtensionRegistry } from "../src/agent-runtime/extension-registry.js";
import { ExtensionCatalog } from "../src/agent-runtime/extensions.js";
import { InteractionSecretStore } from "../src/agent-runtime/interaction-secret-store.js";

type SmokeConnector = "echo" | "codex" | "claude-code";

const connector = process.argv[2] as SmokeConnector | undefined;
if (!connector || !["echo", "codex", "claude-code"].includes(connector)) {
	throw new Error("用法：tsx scripts/connector-smoke.ts echo|codex|claude-code");
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packageDir = path.join(repoRoot, "extensions", "connectors", connector);
const stateDir = await mkdtemp(path.join(tmpdir(), `puddingteams-${connector}-smoke-`));
const cwdSnapshot = await realpath(await mkdtemp(path.join(tmpdir(), "puddingteams-smoke-workspace-")));

const drivers = new DriverRegistry();
const extensions = new ExtensionRegistry(stateDir, new ExtensionCatalog(), drivers);
await extensions.init();
const installed = await extensions.installOrUpdateFromDir(packageDir);
assert.equal(installed.loaded, true, installed.loadError);

const driver = drivers.create(connector, {});
assert.ok(driver, `${connector} Driver 未注册`);
const probe = await driver.probe({ cwd: cwdSnapshot, env: process.env });
assert.equal(probe.detected, true, `${connector} CLI 未检测到：${probe.issues.map((issue) => issue.message).join("；")}`);

const delegations = new DelegationStore(stateDir);
const secrets = new InteractionSecretStore(stateDir);
await Promise.all([delegations.init(), secrets.init()]);
const runtime = new AgentRuntime(delegations, secrets, () => driver);
const marker = connector === "echo" ? "golden-path" : "PUDDINGTEAMS_SMOKE_OK";
const first = await runtime.delegate(
	{
		windowId: "smoke-window",
		cwdSnapshot,
		managerSessionId: "smoke-manager-session",
		agentId: connector,
		agentRevision: 0,
		message: connector === "echo" ? marker : `Reply with exactly ${marker} and nothing else.`,
		mode: "run",
		intent: "验证 Connector 黄金路径",
		expectedOutcome: marker,
		completionBoundary: "收到包含指定 marker 的 completed 边界",
	},
	{ cwd: cwdSnapshot, env: process.env },
);
assert.equal(first.status, "completed");
assert.match(first.result.content ?? "", new RegExp(marker));
assert.ok(first.result.sessionHandle, "首次 run 必须返回 sessionHandle");

if (connector === "echo") {
	const second = await runtime.delegate(
		{
			windowId: "smoke-window",
			cwdSnapshot,
			managerSessionId: "smoke-manager-session",
			parentDelegationId: first.delegation.id,
			handoffKind: "followup",
			agentId: connector,
			agentRevision: 0,
			message: "continue-path",
			mode: "continue",
			sessionHandle: first.result.sessionHandle,
		},
		{ cwd: cwdSnapshot, env: process.env },
	);
	assert.equal(second.status, "completed");
	assert.equal(second.result.content, "ECHO: continue-path");
	assert.equal(second.result.sessionHandle, first.result.sessionHandle);
	const persisted = await delegations.listDelegations("smoke-window", "smoke-manager-session");
	assert.equal(persisted.length, 2);
	assert.ok(persisted.every((item) => item.status === "completed" && item.cwdSnapshot === cwdSnapshot));
}

console.log(`✓ ${connector} smoke passed: install → probe → run${connector === "echo" ? " → continue → persistence" : ""}`);
