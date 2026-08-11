import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	WORKSPACE_TRUST_POLICY_VERSION,
	WorkspaceStore,
	scanWorkspaceResources,
} from "./workspaces.js";

/**
 * Workspace 信任门（迁移方案 §7）：外部登记初始 pending、managed 直接
 * trusted、状态机流转、realpath 漂移自动退回 pending、有效资源判定单点。
 */

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

async function makeStore(): Promise<{ store: WorkspaceStore; dir: string }> {
	const dir = freshDir("pt-trust-store-");
	const store = new WorkspaceStore(path.join(dir, "state"), path.join(dir, "managed"));
	await store.init();
	return { store, dir };
}

test("信任门: 外部登记初始 pending，managed 直接 trusted", async () => {
	const { store } = await makeStore();
	const external = await store.createFromPath({ path: freshDir("pt-trust-ext-") });
	assert.deepEqual(external.trust, { state: "pending", policyVersion: WORKSPACE_TRUST_POLICY_VERSION });

	const managed = await store.createManaged("M");
	assert.equal(managed.trust.state, "trusted");
	assert.equal(managed.trust.policyVersion, WORKSPACE_TRUST_POLICY_VERSION);
	assert.equal(managed.trust.canonicalPathAtDecision, managed.canonicalPath);
	assert.ok(managed.trust.decidedAt);
});

test("信任门: 状态机 pending→trusted→denied，暂不决定清除决定元数据", async () => {
	const { store } = await makeStore();
	const ws = await store.createFromPath({ path: freshDir("pt-trust-flow-") });

	const trusted = await store.setTrust(ws.id, { state: "trusted" });
	assert.equal(trusted.trust.state, "trusted");
	assert.equal(trusted.trust.canonicalPathAtDecision, ws.canonicalPath);
	assert.ok(trusted.trust.decidedAt);
	assert.equal(trusted.trust.approvedResources, undefined, "缺省 = 全三类");

	const denied = await store.setTrust(ws.id, { state: "denied", approvedResources: ["skills"] });
	assert.equal(denied.trust.state, "denied");
	assert.deepEqual(denied.trust.approvedResources, ["skills"]);

	const pending = await store.setTrust(ws.id, { state: "pending" });
	assert.equal(pending.trust.state, "pending");
	assert.equal(pending.trust.decidedAt, undefined);
	assert.equal(pending.trust.canonicalPathAtDecision, undefined);
	assert.deepEqual(pending.trust.approvedResources, ["skills"], "暂不决定保留 approvedResources 草稿");

	await assert.rejects(() => store.setTrust(ws.id, { state: "maybe" as never }), /pending \| trusted \| denied/);
	await assert.rejects(() => store.setTrust(ws.id, { state: "trusted", approvedResources: ["everything" as never] }), /approvedResources/);
	await assert.rejects(() => store.setTrust("missing", { state: "trusted" }), /not found/);
});

test("信任门: 有效资源判定单点——trusted 缺省全三类，approvedResources 收敛", async () => {
	const { store } = await makeStore();
	const ws = await store.createFromPath({ path: freshDir("pt-trust-access-") });

	// pending：全关。
	assert.deepEqual(await store.resourceAccessFor(ws.id), { context: false, skills: false, prompts: false });
	// 无 workspaceId（unscoped）：全关（§6.3）。
	assert.deepEqual(await store.resourceAccessFor(undefined), { context: false, skills: false, prompts: false });

	await store.setTrust(ws.id, { state: "trusted" });
	assert.deepEqual(await store.resourceAccessFor(ws.id), { context: true, skills: true, prompts: true });

	await store.setTrust(ws.id, { state: "trusted", approvedResources: ["skills"] });
	assert.equal(await store.isWorkspaceResourceAllowed(ws.id, "skills"), true);
	assert.equal(await store.isWorkspaceResourceAllowed(ws.id, "context"), false);
	assert.equal(await store.isWorkspaceResourceAllowed(ws.id, "prompts"), false);

	await store.setTrust(ws.id, { state: "denied" });
	assert.deepEqual(await store.resourceAccessFor(ws.id), { context: false, skills: false, prompts: false });
});

test("信任门: realpath 漂移立即退回 pending 并持久化", async () => {
	const { store } = await makeStore();
	const root = freshDir("pt-trust-drift-");
	const ws = await store.createFromPath({ path: root });
	await store.setTrust(ws.id, { state: "trusted", approvedResources: ["context"] });

	// 目录被替换为指向别处的 symlink：realpath 与登记身份不一致。
	const elsewhere = freshDir("pt-trust-elsewhere-");
	renameSync(root, path.join(path.dirname(root), `${path.basename(root)}-old`));
	symlinkSync(elsewhere, root);

	const drifted = await store.get(ws.id);
	assert.equal(drifted?.trust.state, "pending");
	assert.equal(drifted?.trust.decidedAt, undefined);
	assert.deepEqual(drifted?.trust.approvedResources, ["context"], "漂移保留 approvedResources 草稿");
	assert.deepEqual(await store.resourceAccessFor(ws.id), { context: false, skills: false, prompts: false });

	// 已持久化：再次读取仍是 pending。
	const again = await store.get(ws.id);
	assert.equal(again?.trust.state, "pending");
});

test("信任门: 资源摘要只报类型与数量，不读正文", async () => {
	const root = freshDir("pt-trust-scan-");
	writeFileSync(path.join(root, "AGENTS.md"), "SECRET-CONTEXT");
	mkdirSync(path.join(root, ".pi", "skills", "s1"), { recursive: true });
	mkdirSync(path.join(root, ".pi", "skills", "s2"), { recursive: true });
	mkdirSync(path.join(root, ".pi", "prompts"), { recursive: true });
	writeFileSync(path.join(root, ".pi", "prompts", "p1.md"), "SECRET-PROMPT");

	const summary = await scanWorkspaceResources(root);
	assert.deepEqual(summary, { contextFiles: 1, skills: 2, prompts: 1 });
	assert.ok(!JSON.stringify(summary).includes("SECRET"));

	// 不可读/不存在目录按 0 计。
	assert.deepEqual(await scanWorkspaceResources(path.join(root, "missing")), { contextFiles: 0, skills: 0, prompts: 0 });
});

test("信任门: 列表/详情返回 trust 与资源摘要", async () => {
	const { store } = await makeStore();
	const root = freshDir("pt-trust-list-");
	writeFileSync(path.join(root, "CLAUDE.md"), "x");
	const ws = await store.createFromPath({ path: root });

	const list = await store.list();
	const entry = list.find((w) => w.id === ws.id);
	assert.equal(entry?.trust.state, "pending");
	assert.equal(entry?.available, true);
	assert.deepEqual(entry?.resources, { contextFiles: 1, skills: 0, prompts: 0 });

	const detail = await store.summary(ws.id);
	assert.equal(detail?.trust.state, "pending");
	assert.equal(detail?.resources.contextFiles, 1);
	assert.equal(await store.summary("missing"), undefined);

	// managed 默认 trusted 出现在列表里。
	const managed = await store.createManaged("M");
	const managedEntry = (await store.list()).find((w) => w.id === managed.id);
	assert.equal(managedEntry?.trust.state, "trusted");
	assert.equal(managedEntry?.resources.contextFiles, 0);
});

test("信任门: 旧记录缺 trust 字段按来源补默认", async () => {
	const dir = freshDir("pt-trust-legacy-");
	const stateDir = path.join(dir, "state");
	mkdirSync(stateDir, { recursive: true });
	const externalRoot = freshDir("pt-trust-legacy-ext-");
	writeFileSync(
		path.join(stateDir, "workspaces.json"),
		JSON.stringify({
			version: 1,
			workspaces: {
				ext: {
					id: "ext",
					name: "ext",
					rootPath: externalRoot,
					canonicalPath: realpathSync(externalRoot),
					managed: false,
					createdAt: "2026-01-01T00:00:00.000Z",
					lastOpenedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		}),
	);
	const store = new WorkspaceStore(stateDir, path.join(dir, "managed"));
	await store.init();
	const record = await store.get("ext");
	assert.equal(record?.trust.state, "pending", "外部旧记录默认 pending，不自动沿用信任");
});
