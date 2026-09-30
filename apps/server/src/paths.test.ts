import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireLease, ensurePaths, puddingTeamsHomeId, resolvePuddingTeamsPaths } from "./paths.js";

function freshHome(): string {
	return mkdtempSync(path.join(tmpdir(), "pt-home-"));
}

test("PUDDINGTEAMS_HOME 相对路径直接拒绝（必须绝对路径）", () => {
	assert.throws(() => resolvePuddingTeamsPaths({ PUDDINGTEAMS_HOME: "relative/dir" }, "/tmp/whatever"), /必须是绝对路径/);
	assert.throws(() => resolvePuddingTeamsPaths({ PUDDINGTEAMS_HOME: "./x" }, "/tmp/whatever"), /必须是绝对路径/);
});

test("缺省根解析为 <home>/.puddingteams，目录树按文档 §4 派生", () => {
	const paths = resolvePuddingTeamsPaths({}, "/tmp/pt-user");
	assert.equal(paths.home, "/tmp/pt-user/.puddingteams");
	assert.equal(paths.config, "/tmp/pt-user/.puddingteams/config");
	assert.equal(paths.state, "/tmp/pt-user/.puddingteams/state");
	assert.equal(paths.sessions, "/tmp/pt-user/.puddingteams/sessions");
	assert.equal(paths.workerSessions, "/tmp/pt-user/.puddingteams/sessions/workers");
	assert.equal(paths.extensions, "/tmp/pt-user/.puddingteams/extensions");
	assert.equal(paths.uploads, "/tmp/pt-user/.puddingteams/uploads");
	assert.equal(paths.artifactBlobs, "/tmp/pt-user/.puddingteams/artifacts/blobs");
	assert.equal(paths.knowledgeState, "/tmp/pt-user/.puddingteams/state/knowledge");
	assert.equal(paths.knowledgeAcceptance, "/tmp/pt-user/.puddingteams/state/knowledge/acceptance");
	assert.equal(paths.knowledgePlans, "/tmp/pt-user/.puddingteams/state/knowledge/plans");
	assert.equal(paths.knowledgeReviews, "/tmp/pt-user/.puddingteams/state/knowledge/reviews");
	assert.equal(paths.knowledgeOperations, "/tmp/pt-user/.puddingteams/state/knowledge/operations");
	assert.equal(paths.knowledgeObjects, "/tmp/pt-user/.puddingteams/knowledge/objects");
	assert.equal(paths.knowledgeCache, "/tmp/pt-user/.puddingteams/cache/knowledge");
	assert.equal(paths.calendarState, "/tmp/pt-user/.puddingteams/state/calendar");
	assert.equal(paths.managedWorkspaces, "/tmp/pt-user/.puddingteams/workspaces/managed");
	assert.equal(paths.unscopedWorkspace, "/tmp/pt-user/.puddingteams/workspaces/unscoped");
	assert.equal(paths.secrets, "/tmp/pt-user/.puddingteams/secrets");
	assert.equal(paths.runtime, "/tmp/pt-user/.puddingteams/runtime");
	assert.equal(paths.logs, "/tmp/pt-user/.puddingteams/logs");
	assert.equal(paths.migrations, "/tmp/pt-user/.puddingteams/migrations");
});

test("绝对路径 PUDDINGTEAMS_HOME 优先于缺省根", () => {
	const paths = resolvePuddingTeamsPaths({ PUDDINGTEAMS_HOME: "/data/pt" }, "/tmp/pt-user");
	assert.equal(paths.home, "/data/pt");
	assert.equal(paths.state, "/data/pt/state");
});

test("Home 指纹稳定且不暴露路径正文", () => {
	const home = path.join(tmpdir(), "pt-private-home");
	const id = puddingTeamsHomeId(home);
	assert.equal(id, puddingTeamsHomeId(path.resolve(home)));
	assert.equal(id.length, 64);
	assert.ok(!id.includes("pt-private-home"));
});

test("ensurePaths 建出完整目录树", async () => {
	const home = freshHome();
	const paths = resolvePuddingTeamsPaths({ PUDDINGTEAMS_HOME: path.join(home, "nested", "pt") });
	await ensurePaths(paths);
	for (const dir of [
		paths.config,
		paths.state,
		paths.sessions,
		paths.workerSessions,
		paths.extensions,
		path.join(paths.assets, "avatars"),
		paths.uploads,
		paths.artifactBlobs,
		paths.knowledgeState,
		paths.knowledgeAcceptance,
		paths.knowledgePlans,
		paths.knowledgeReviews,
		paths.knowledgeOperations,
		paths.knowledgeObjects,
		paths.knowledgeCache,
		paths.calendarState,
		paths.managedWorkspaces,
		paths.unscopedWorkspace,
		paths.secrets,
		path.join(paths.runtime, "tmp"),
		paths.logs,
		paths.migrations,
	]) {
		assert.ok(existsSync(dir), `缺目录：${dir}`);
	}
});

test("Lease：存活实例持有时第二个实例拒绝启动", async () => {
	const paths = resolvePuddingTeamsPaths({ PUDDINGTEAMS_HOME: freshHome() });
	await ensurePaths(paths);
	const release = await acquireLease(paths);
	// lease 里写的是本进程 pid（存活），第二个实例必须被拒绝。
	await assert.rejects(() => acquireLease(paths), /拒绝第二个实例/);
	await release();
	// 释放后可以被重新获取。
	const again = await acquireLease(paths);
	await again();
});

test("Lease：stale（进程已死）自动回收重建", async () => {
	const paths = resolvePuddingTeamsPaths({ PUDDINGTEAMS_HOME: freshHome() });
	await ensurePaths(paths);
	const leaseDirectory = path.join(paths.runtime, "backend.leases");
	mkdirSync(leaseDirectory, { recursive: true });
	const leaseFile = path.join(leaseDirectory, "99999999-00000000-0000-4000-8000-000000000000.json");
	// 99999999 超出常见 pid_max，必然不存在。
	writeFileSync(leaseFile, JSON.stringify({ pid: 99_999_999, startedAt: "2026-01-01T00:00:00Z" }) + "\n");
	const release = await acquireLease(paths);
	assert.equal(existsSync(leaseFile), false);
	await release();
});

test("Lease：遗留单文件存在时安全拒绝，不删除未知旧实例的凭据", async () => {
	const paths = resolvePuddingTeamsPaths({ PUDDINGTEAMS_HOME: freshHome() });
	await ensurePaths(paths);
	const legacyFile = path.join(paths.runtime, "backend.lease");
	writeFileSync(legacyFile, "not json\n");
	await assert.rejects(() => acquireLease(paths), /旧版后端 lease/);
	assert.equal(existsSync(legacyFile), true);
});

test("Lease：同时竞选同一 Home 最多一个取得资格，释放只删除自己的文件", async () => {
	const paths = resolvePuddingTeamsPaths({ PUDDINGTEAMS_HOME: freshHome() });
	await ensurePaths(paths);
	const results = await Promise.allSettled([acquireLease(paths), acquireLease(paths)]);
	const winners = results.filter((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === "fulfilled");
	assert.ok(winners.length <= 1);
	for (const winner of winners) await winner.value();
	const next = await acquireLease(paths);
	await next();
});
