import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
	const leaseFile = path.join(paths.runtime, "backend.lease");
	// 99999999 超出常见 pid_max，必然不存在。
	writeFileSync(leaseFile, JSON.stringify({ pid: 99_999_999, startedAt: "2026-01-01T00:00:00Z" }) + "\n");
	const release = await acquireLease(paths);
	await release();
});

test("Lease：内容损坏视为 stale 回收", async () => {
	const paths = resolvePuddingTeamsPaths({ PUDDINGTEAMS_HOME: freshHome() });
	await ensurePaths(paths);
	writeFileSync(path.join(paths.runtime, "backend.lease"), "not json\n");
	const release = await acquireLease(paths);
	await release();
});
