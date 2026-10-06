import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { link, mkdir, mkdtemp, readdir, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { CompileJobStore, type NewCompileJob } from "./compile-jobs.js";

function input(root: string): NewCompileJob {
	return {
		operationId: "compile-op-1", ownerId: "local-user", targetBindingId: "binding-1",
		bindingRevision: 2, trustRevision: 3, rootIdentity: "device:inode",
		sourceAcceptanceIds: ["accepted-source"], sourceSnapshotRefs: ["sha256:source"], sourceSnapshotRoot: path.join(root, "source"),
		stagingRoot: path.join(root, "staging"), privateRoot: path.join(root, "private"),
		compilerRef: "@puddingteams/connector-codex", compilerPackageSha256: "a".repeat(64),
		agentId: "codex", agentRevision: 1, task: "Compile approved source into staging",
		commandPath: path.join(root, "trusted-codex"), commandSha256: "b".repeat(64),
	};
}

async function preparedRoot(prefix: string): Promise<string> {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
	await Promise.all(["source", "staging", "private"].map((name) => mkdir(path.join(root, name))));
	return root;
}

test("CompileJob 准入跨实例幂等、单次领取、唯一委托绑定与中断封锁", async () => {
	const root = await preparedRoot("pt-compile-jobs-");
	const store = new CompileJobStore(root);
	const frozen = input(root);
	await assert.rejects(store.create({ ...frozen, sourceSnapshotHash: "f".repeat(64) } as NewCompileJob), /cannot supply sourceSnapshotHash/);
	await assert.rejects(store.create({ ...frozen, sourceAcceptanceIds: [] }), /invalid CompileJob authority/);
	await assert.rejects(store.create({ ...frozen, sourceAcceptanceIds: ["same", "same"], sourceSnapshotRefs: ["one", "two"] }), /invalid CompileJob authority/);
	await writeFile(path.join(root, "source", "approved.md"), "accepted source\n");
	const created = await store.create(frozen);
	assert.deepEqual(created.sourceAcceptanceIds, ["accepted-source"]);
	assert.match(created.sourceSnapshotHash, /^[a-f0-9]{64}$/);
	assert.equal((await new CompileJobStore(root).create(frozen)).id, created.id);
	await writeFile(path.join(root, "source", "approved.md"), "changed source\n");
	await assert.rejects(store.create(frozen), /operation conflict/, "same operation cannot silently adopt changed source bytes");
	await assert.rejects(store.create({ ...frozen, commandSha256: "d".repeat(64) }), /operation conflict/);
	await assert.rejects(store.create({ ...frozen, sourceAcceptanceIds: ["different-acceptance"] }), /operation conflict/, "identical bytes under a different accepted-note identity are a different Job authority");
	await assert.rejects(store.create({ ...frozen, operationId: "other-op" }), /already used/);
	await mkdir(path.join(root, "another-private"));
	await assert.rejects(store.create({ ...frozen, operationId: "swapped-root-op", stagingRoot: frozen.privateRoot,
		privateRoot: path.join(root, "another-private") }), /already used/);
	await assert.rejects(store.create({ ...frozen, operationId: "nested-op", privateRoot: path.join(root, "source") }), /disjoint/);
	const claimed = await store.claim(created.id);
	assert.equal(claimed.status, "running");
	await assert.rejects(store.claim(created.id), /not queued/);
	await assert.rejects(store.finish(created.id, "candidate_ready", { candidateBatchId: "batch" }), /bound Delegation/);
	await store.bindDelegation(created.id, "delegation-1");
	await assert.rejects(store.bindDelegation(created.id, "delegation-2"), /binding conflict/);
	const interrupted = await new CompileJobStore(root).failInterrupted();
	assert.equal(interrupted.length, 1);
	assert.equal(interrupted[0]?.failureCode, "server_restart");
	await assert.rejects(store.finish(created.id, "candidate_ready", { candidateBatchId: "batch" }), /not running/);
	await assert.rejects(store.claim(created.id), /not queued/);
	assert.equal((await new CompileJobStore(root).get(created.id))?.status, "failed");
});

test("CompileJob 来源快照拒绝符号链接和硬链接", async () => {
	const root = await preparedRoot("pt-compile-source-links-");
	const source = path.join(root, "source");
	const target = path.join(root, "outside.md");
	await writeFile(target, "outside\n");
	await symlink(target, path.join(source, "shortcut.md"));
	const store = new CompileJobStore(root);
	await assert.rejects(store.create(input(root)), /link or special file/);
	await unlink(path.join(source, "shortcut.md"));
	await link(target, path.join(source, "hardlink.md"));
	await assert.rejects(store.create(input(root)), /hard link/);
});

test("CompileJob 候选必须来自绑定的运行任务；失败不可升级为候选", async () => {
	const root = await preparedRoot("pt-compile-candidate-");
	const store = new CompileJobStore(root);
	const created = await store.create(input(root));
	await store.claim(created.id);
	await store.bindDelegation(created.id, "delegation-1");
	await assert.rejects(store.finish(created.id, "candidate_ready"), /validated batch/);
	const failed = await store.finish(created.id, "failed", { failureCode: "model_channel_unavailable" });
	assert.equal(failed.status, "failed");
	await assert.rejects(store.finish(created.id, "candidate_ready", { candidateBatchId: "batch" }), /not running/);
});

test("两个独立进程同时领取同一 CompileJob 仅一个成功", async () => {
	const root = await preparedRoot("pt-compile-cross-process-");
	const store = new CompileJobStore(root);
	const job = await store.create(input(root));
	const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "compile-jobs.ts")).href;
	const script = `import { writeFile, access } from 'node:fs/promises';
		import path from 'node:path';
		import { CompileJobStore } from ${JSON.stringify(moduleUrl)};
		const [root, id] = process.argv.slice(1);
		await writeFile(path.join(root, 'ready-' + process.pid), 'ready');
		while (true) { try { await access(path.join(root, 'go')); break; } catch { await new Promise(r => setTimeout(r, 5)); } }
		try { await new CompileJobStore(root).claim(id); console.log('claimed'); }
		catch (error) { console.log('rejected:' + error.message); }`;
	const launch = () => {
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, root, job.id],
			{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
		const done = new Promise<string>((resolve, reject) => {
			child.on("error", reject);
			child.on("exit", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(output)));
		});
		return { child, done };
	};
	const first = launch();
	const second = launch();
	try {
		const deadline = Date.now() + 10_000;
		while ((await readdir(root)).filter((name) => name.startsWith("ready-")).length < 2) {
			if (Date.now() > deadline) throw new Error("claim workers did not reach barrier");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		await writeFile(path.join(root, "go"), "go");
		const results = await Promise.all([first.done, second.done]);
		assert.deepEqual(results.map((value) => value.split("\n").at(-1)).sort(), ["claimed", "rejected:CompileJob is not queued"]);
		assert.equal((await store.get(job.id))?.revision, 1);
	} finally {
		first.child.kill(); second.child.kill();
	}
});
