import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceExecutionCoordinator, WorkspaceExecutionError } from "./workspace-execution.js";

async function temp(prefix: string): Promise<string> {
	return mkdtemp(path.join(tmpdir(), prefix));
}

async function git(cwd: string, args: string[], input?: string): Promise<string> {
	const { spawn } = await import("node:child_process");
	return new Promise((resolve, reject) => {
		const child = spawn("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
		child.stdin.end(input);
	});
}

async function gitRepo(): Promise<string> {
	const root = await temp("pt-execution-git-");
	await git(root, ["init", "--initial-branch", "main"]);
	await git(root, ["config", "user.email", "test@example.com"]);
	await git(root, ["config", "user.name", "Pudding Test"]);
	await writeFile(path.join(root, "tracked.txt"), "base\n");
	await git(root, ["add", "tracked.txt"]);
	await git(root, ["commit", "-m", "base"]);
	return root;
}

test("isolated_worktree materializes clean, staged, unstaged, and non-ignored untracked state", async () => {
	const root = await gitRepo();
	const state = await temp("pt-execution-state-");
	try {
		await writeFile(path.join(root, "tracked.txt"), "base\nstaged\n");
		await git(root, ["add", "tracked.txt"]);
		await writeFile(path.join(root, "tracked.txt"), "base\nstaged\nunstaged\n");
		await writeFile(path.join(root, "new.txt"), "untracked\n");
		const coordinator = new WorkspaceExecutionCoordinator(state);
		await coordinator.init();
		const scope = await coordinator.begin({ workspacePath: root, workspaceId: "ws-1", mode: "isolated_worktree", delegationId: "d-1" });
		assert.notEqual(scope.executionCwd, root);
		assert.equal(await readFile(path.join(scope.executionCwd, "tracked.txt"), "utf8"), "base\nstaged\nunstaged\n");
		assert.equal(await readFile(path.join(scope.executionCwd, "new.txt"), "utf8"), "untracked\n");
		await writeFile(path.join(scope.executionCwd, "tracked.txt"), "worker\n");
		await writeFile(path.join(scope.executionCwd, "worker.txt"), "created\n");
		await git(scope.executionCwd, ["add", "tracked.txt", "worker.txt"]);
		await git(scope.executionCwd, ["-c", "user.email=worker@example.com", "-c", "user.name=Worker", "commit", "-m", "worker commit"]);
		const changeSet = await coordinator.capture(scope.id, scope.ownerToken);
		assert.deepEqual(changeSet.changedPaths, ["tracked.txt", "worker.txt"]);
		assert.equal(changeSet.promotionState, "pending");
		const promoted = await coordinator.promote(scope.id, changeSet.id, scope.ownerToken);
		assert.equal(promoted.promotionState, "applied");
		assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "worker\n");
		assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "untracked\n");
		assert.equal(await readFile(path.join(root, "worker.txt"), "utf8"), "created\n");
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

test("isolated_worktree rejects non-Git projects and nested repositories", async () => {
	const root = await temp("pt-execution-nongit-");
	const state = await temp("pt-execution-state-");
	try {
		const coordinator = new WorkspaceExecutionCoordinator(state);
		await coordinator.init();
		await assert.rejects(
			() => coordinator.begin({ workspacePath: root, mode: "isolated_worktree", delegationId: "d-1" }),
			(error: unknown) => error instanceof WorkspaceExecutionError && error.code === "unsupported_layout",
		);
		const repo = await gitRepo();
		await mkdir(path.join(repo, "nested"));
		await git(path.join(repo, "nested"), ["init"]);
		await assert.rejects(
			() => coordinator.begin({ workspacePath: repo, mode: "isolated_worktree", delegationId: "d-2" }),
			(error: unknown) => error instanceof WorkspaceExecutionError && error.code === "unsupported_layout",
		);
		await rm(repo, { recursive: true, force: true });
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

test("isolated_worktree ignores package-manager symlinks under ignored directories", async () => {
	const root = await gitRepo();
	const state = await temp("pt-execution-state-");
	try {
		await writeFile(path.join(root, ".gitignore"), "node_modules/\n");
		await git(root, ["add", ".gitignore"]);
		await git(root, ["commit", "-m", "ignore dependencies"]);
		await mkdir(path.join(root, "node_modules", ".pnpm"), { recursive: true });
		await import("node:fs/promises").then(({ symlink }) =>
			symlink(path.join(root, "tracked.txt"), path.join(root, "node_modules", "linked-package")),
		);
		const coordinator = new WorkspaceExecutionCoordinator(state);
		await coordinator.init();
		const scope = await coordinator.begin({ workspacePath: root, mode: "isolated_worktree", delegationId: "d-pnpm" });
		assert.notEqual(scope.executionCwd, root);
		assert.equal(await readFile(path.join(scope.executionCwd, "tracked.txt"), "utf8"), "base\n");
		await assert.rejects(() => readFile(path.join(scope.executionCwd, "node_modules", "linked-package")));
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

test("exclusive_write has a persistent, fail-closed lease and captures write-set", async () => {
	const root = await temp("pt-execution-exclusive-");
	const state = await temp("pt-execution-state-");
	try {
		await writeFile(path.join(root, "state.txt"), "before\n");
		const coordinator = new WorkspaceExecutionCoordinator(state, { leaseTimeoutMs: 60_000 });
		await coordinator.init();
		const first = await coordinator.begin({ workspacePath: root, workspaceId: "ws-lease", mode: "exclusive_write", delegationId: "d-1" });
		assert.ok(first.lease?.ownerToken);
		const restartedCoordinator = new WorkspaceExecutionCoordinator(state, { leaseTimeoutMs: 60_000 });
		await restartedCoordinator.init();
		await assert.rejects(
			() => restartedCoordinator.begin({ workspacePath: root, workspaceId: "ws-lease", mode: "exclusive_write", delegationId: "d-2" }),
			(error: unknown) => error instanceof WorkspaceExecutionError && error.code === "lease_conflict",
		);
		await writeFile(path.join(root, "state.txt"), "after\n");
		await writeFile(path.join(root, "created.txt"), "created\n");
		const changes = await coordinator.capture(first.id, first.lease!.ownerToken);
		assert.deepEqual(changes.changedPaths, ["created.txt", "state.txt"]);
		await coordinator.release(first.id, { ownerToken: first.lease!.ownerToken });
		const second = await restartedCoordinator.begin({ workspacePath: root, workspaceId: "ws-lease", mode: "exclusive_write", delegationId: "d-2" });
		assert.ok(second.lease);
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

test("promotion fences instead of overwriting a target changed after admission", async () => {
	const root = await gitRepo();
	const state = await temp("pt-execution-state-");
	try {
		const coordinator = new WorkspaceExecutionCoordinator(state);
		await coordinator.init();
		const scope = await coordinator.begin({ workspacePath: root, workspaceId: "ws-conflict", mode: "isolated_worktree", delegationId: "d-1" });
		await writeFile(path.join(scope.executionCwd, "tracked.txt"), "worker\n");
		const changes = await coordinator.capture(scope.id, scope.ownerToken);
		await writeFile(path.join(root, "tracked.txt"), "external\n");
		const result = await coordinator.promote(scope.id, changes.id, scope.ownerToken);
		assert.equal(result.promotionState, "conflict");
		assert.equal((await coordinator.get(scope.id))?.state, "fenced");
		assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "external\n");
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

test("promotion detects a target change after the workspace fingerprint check", async () => {
	const root = await gitRepo();
	const state = await temp("pt-execution-state-");
	try {
		const coordinator = new WorkspaceExecutionCoordinator(state, {
			promotionCheckpoint: async () => { await writeFile(path.join(root, "tracked.txt"), "racing-editor\n"); },
		});
		await coordinator.init();
		const scope = await coordinator.begin({ workspacePath: root, workspaceId: "ws-race", mode: "isolated_worktree", delegationId: "d-race" });
		await writeFile(path.join(scope.executionCwd, "tracked.txt"), "worker\n");
		const changes = await coordinator.capture(scope.id, scope.ownerToken);
		const result = await coordinator.promote(scope.id, changes.id, scope.ownerToken);
		assert.equal(result.promotionState, "conflict");
		assert.equal((await coordinator.get(scope.id))?.state, "fenced");
		assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "racing-editor\n");
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});

test("shared read-only detects mutation and rejects an unenforced admission", async () => {
	const root = await temp("pt-execution-readonly-");
	const state = await temp("pt-execution-state-");
	try {
		await writeFile(path.join(root, "a.txt"), "a\n");
		const coordinator = new WorkspaceExecutionCoordinator(state);
		await coordinator.init();
		await assert.rejects(
			() => coordinator.begin({ workspacePath: root, mode: "read_only_shared", readOnlyEnforcement: "none", delegationId: "d-0" }),
			(error: unknown) => error instanceof WorkspaceExecutionError && error.code === "invalid_policy",
		);
		await assert.rejects(
			() => coordinator.begin({ workspacePath: root, mode: "read_only_shared", readOnlyEnforcement: "mutation_guard", delegationId: "d-guard" }),
			(error: unknown) => error instanceof WorkspaceExecutionError && error.code === "invalid_policy",
		);
		const scope = await coordinator.begin({ workspacePath: root, mode: "read_only_shared", readOnlyEnforcement: "strong", delegationId: "d-1" });
		await writeFile(path.join(root, "a.txt"), "mutated\n");
		const changes = await coordinator.capture(scope.id);
		assert.equal(changes.integrity, "violation");
		assert.equal(changes.promotionState, "not_required");
	} finally {
		await rm(root, { recursive: true, force: true });
		await rm(state, { recursive: true, force: true });
	}
});
