import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { DelegationStore } from "../agent-runtime/delegation-store.js";
import { WorkspaceExecutionCoordinator } from "../agent-runtime/workspace-execution.js";
import { registerRuntimeFilesRoutes } from "./runtime-files.js";

async function makeStack() {
	const state = mkdtempSync(path.join(tmpdir(), "pt-runtime-files-state-"));
	const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "pt-runtime-files-workspace-")));
	writeFileSync(path.join(workspace, "existing.md"), "before\n");
	const delegations = new DelegationStore(state);
	await delegations.init();
	const delegation = await delegations.createDelegation({
		windowId: "window-1", managerSessionId: "session-1", agentId: "worker", agentRevision: 1,
		cwdSnapshot: workspace, operation: "run", workspaceId: "workspace-1",
	});
	const scopes = new WorkspaceExecutionCoordinator(state, { worktreeRoot: mkdtempSync(path.join(tmpdir(), "pt-runtime-files-scopes-")) });
	await scopes.init();
	const scope = await scopes.begin({ workspacePath: workspace, workspaceId: "workspace-1", mode: "exclusive_write", delegationId: delegation.id });
	await delegations.updateDelegation(delegation.id, { workspaceExecutionScopeId: scope.id, executionCwd: scope.executionCwd });
	const opened: string[] = [];
	const app = Fastify({ logger: false });
	registerRuntimeFilesRoutes(app, delegations, scopes, { open: async (target) => { opened.push(target); } });
	return { app, workspace, delegation, scopes, opened };
}

test("运行文件只列出相对 baseline 的当前变更并支持文本预览", async () => {
	const { app, workspace, delegation } = await makeStack();
	writeFileSync(path.join(workspace, "report.md"), "# 结果\n");
	writeFileSync(path.join(workspace, "data.json"), "{\"ok\":true}\n");

	const list = await app.inject({ method: "GET", url: `/api/delegations/${delegation.id}/files` });
	assert.equal(list.statusCode, 200);
	assert.deepEqual(list.json().files.map((item: { path: string }) => item.path), ["data.json", "report.md"]);
	assert.deepEqual(list.json().files.map((item: { preview: string }) => item.preview), ["json", "markdown"]);

	const content = await app.inject({ method: "GET", url: `/api/delegations/${delegation.id}/files/content?path=report.md` });
	assert.equal(content.statusCode, 200);
	assert.equal(content.body, "# 结果\n");
	assert.equal(content.headers["content-disposition"], "inline");

	const unrelated = await app.inject({ method: "GET", url: `/api/delegations/${delegation.id}/files/content?path=existing.md` });
	assert.equal(unrelated.statusCode, 404, "baseline 文件不能借 viewer 任意读取");
	await app.close();
});

test("运行文件打开复用权威 scope，拒绝穿越与 symlink", async () => {
	const { app, workspace, delegation, opened } = await makeStack();
	const spreadsheet = path.join(workspace, "result.xlsx");
	writeFileSync(spreadsheet, "xlsx bytes");
	const outside = path.join(path.dirname(workspace), "outside-runtime-secret.txt");
	writeFileSync(outside, "secret");

	const openResult = await app.inject({ method: "POST", url: `/api/delegations/${delegation.id}/files/open`, payload: { path: "result.xlsx" } });
	assert.equal(openResult.statusCode, 200);
	assert.deepEqual(opened, [spreadsheet]);

	const traversal = await app.inject({ method: "POST", url: `/api/delegations/${delegation.id}/files/open`, payload: { path: "../outside-runtime-secret.txt" } });
	assert.equal(traversal.statusCode, 400);

	symlinkSync(outside, path.join(workspace, "link.txt"));
	const symlink = await app.inject({ method: "POST", url: `/api/delegations/${delegation.id}/files/open`, payload: { path: "link.txt" } });
	assert.notEqual(symlink.statusCode, 200);
	assert.equal(opened.length, 1);
	await app.close();
});
