import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../store/teams.js";
import {
	ExtensionCatalog,
	resolveAgentCapabilityRuntime,
	type CapabilityExtensionModule,
} from "./extensions.js";

test("Capability Session runtime 同时覆盖 Manager 与 Pi Worker，且 binding 状态互相隔离", async () => {
	const stateRoot = mkdtempSync(path.join(tmpdir(), "pt-capability-state-"));
	const skillPath = path.join(stateRoot, "skills");
	const seen: Array<{ agentId: string; pinned: boolean; connectorId?: string; stateDir: string }> = [];
	const module: CapabilityExtensionModule = {
		manifest: { id: "lark-like", kind: "capability", name: "Lark-like", version: "1", tools: [] },
		register() {},
		runtime: {
			resolveSession(ctx) {
				seen.push({
					agentId: ctx.agent.id,
					pinned: ctx.agent.pinned,
					...(ctx.agent.connectorId ? { connectorId: ctx.agent.connectorId } : {}),
					stateDir: ctx.stateDir,
				});
				return { skillPaths: [skillPath], env: { ...ctx.env, LARK_BINDING: ctx.agent.id } };
			},
		},
	};
	const catalog = new ExtensionCatalog();
	catalog.register(module);
	const binding = { id: "binding-1", extensionId: "lark-like", capabilityId: "lark-like", enabled: true, config: {} };
	const manager = {
		name: "manager",
		description: "manager",
		pinned: true,
		enabled: true,
		invoke: { type: "pi" },
		capabilityExtensions: [binding],
	} as AgentConfig;
	const worker = {
		name: "pi-worker",
		description: "worker",
		enabled: true,
		connector: { extensionId: "pi", connectorId: "pi", transport: "sdk", config: {} },
		capabilityExtensions: [binding],
	} as AgentConfig;

	const [managerRuntime, workerRuntime] = await Promise.all([
		resolveAgentCapabilityRuntime({ agent: manager, catalog, stateRoot, cwd: process.cwd(), env: {} }),
		resolveAgentCapabilityRuntime({ agent: worker, catalog, stateRoot, cwd: process.cwd(), env: {} }),
	]);
	assert.deepEqual(managerRuntime.skillPaths, [skillPath]);
	assert.deepEqual(workerRuntime.skillPaths, [skillPath]);
	assert.equal(managerRuntime.env.LARK_BINDING, "manager");
	assert.equal(workerRuntime.env.LARK_BINDING, "pi-worker");
	assert.equal(seen.find((item) => item.agentId === "manager")?.pinned, true);
	assert.equal(seen.find((item) => item.agentId === "pi-worker")?.connectorId, "pi");
	assert.notEqual(seen[0]?.stateDir, seen[1]?.stateDir, "Manager 与 Worker 不得共用 CLI token 目录");
});
