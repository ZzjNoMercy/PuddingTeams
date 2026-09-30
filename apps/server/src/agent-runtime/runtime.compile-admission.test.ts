import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "./runtime.js";
import { DelegationStore } from "./delegation-store.js";
import { InteractionSecretStore } from "./interaction-secret-store.js";
import { CompileJobStore } from "../knowledge/compile-jobs.js";
import type { AgentDriver } from "./types.js";

test("普通 Runtime 委托不能注入受保护编译权限或伪造 purpose", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-compile-admission-"));
	const delegations = new DelegationStore(root); await delegations.init();
	const secrets = new InteractionSecretStore(root); await secrets.init();
	let driverResolved = 0;
	const runtime = new AgentRuntime(delegations, secrets, () => { driverResolved++; return undefined; });
	const input = { windowId: "w", cwdSnapshot: root, managerSessionId: "s", agentId: "codex", agentRevision: 1,
		message: "compile", mode: "run" as const };
	await assert.rejects(runtime.delegate(input, { cwd: root, env: {}, protectedCompile: {
		jobId: "forged", stagingRoot: root, commandPath: "/bin/echo", commandSha256: "a".repeat(64),
		sandboxProfilePath: "/tmp/forged.sb", sandboxProfileSha256: "b".repeat(64), env: {},
	} }), /requires a platform CompileJob admission/);
	await assert.rejects(runtime.delegate({ ...input, purpose: "knowledge_compile" } as never, { cwd: root, env: {} }), /unsupported delegation purpose/);
	assert.equal(driverResolved, 0, "reject before resolving or starting a Connector");
	assert.deepEqual(await delegations.listDelegations(), [], "rejection leaves no durable Run");
});

test("受信 CompileJob 在 Driver 首个事件前绑定唯一 Delegation，候选仅由宿主验证回调放行", { skip: process.platform !== "darwin" }, async () => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pt-compile-runtime-")));
	const directories = ["state", "source", "staging", "private", "trusted"];
	await Promise.all(directories.map((name) => mkdir(path.join(root, name), { mode: 0o700 })));
	const commandPath = path.join(root, "trusted", "codex-stub");
	await writeFile(commandPath, "#!/bin/sh\nexit 0\n");
	await chmod(commandPath, 0o755);
	const digest = createHash("sha256").update(await readFile(commandPath)).digest("hex");
	const jobs = new CompileJobStore(path.join(root, "state"));
	const job = await jobs.create({
		operationId: "compile:one", ownerId: "user", targetBindingId: "binding", bindingRevision: 1, trustRevision: 1,
		rootIdentity: "root-id", sourceAcceptanceIds: ["accepted-source"], sourceSnapshotRefs: ["snapshot:1"], sourceSnapshotRoot: path.join(root, "source"),
		stagingRoot: path.join(root, "staging"), privateRoot: path.join(root, "private"),
		compilerRef: "@puddingteams/connector-codex", compilerPackageSha256: "a".repeat(64),
		agentId: "codex", agentRevision: 1, task: "compile", commandPath, commandSha256: digest,
		baseManifestHash: "b".repeat(64),
	});
	let activeJob = job;
	let requireInput = false;
	let mutateSourceDuringRun = false;
	let authorized = true;
	let revokeDuringRun = false;
	let revokeDuringValidation = false;
	let candidateValidations = 0;
	let attestationCalls = 0;
	let rejectAttestationAt = 0;
	let packageValid = true;
	let revokePackageDuringRun = false;
	let revokePackageDuringValidation = false;
	const delegations = new DelegationStore(path.join(root, "state")); await delegations.init();
	const secrets = new InteractionSecretStore(path.join(root, "state")); await secrets.init();
	let started = 0;
	const driver: AgentDriver = {
		id: "codex",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn" }; },
		async *run(_request, ctx) {
			started++;
			assert.equal(ctx.protectedCompile?.jobId, activeJob.id);
			assert.equal(ctx.cwd, activeJob.stagingRoot);
			assert.deepEqual(Object.keys(ctx.env).sort(), ["HOME", "PATH", "TEMP", "TMP", "TMPDIR"]);
			const bound = await jobs.get(activeJob.id);
			assert.equal(bound?.status, "running");
			assert.equal(bound?.delegationId, ctx.delegationId);
			if (requireInput) {
				yield { type: "input_required", result: { agentId: "codex", status: "needs_input", interaction: {
					id: "untrusted-approval", kind: "permission", requests: [{ requestId: "permit", prompt: "write Wiki?", options: ["once", "reject"] }],
				} } };
				return;
			}
			if (mutateSourceDuringRun) await writeFile(path.join(activeJob.sourceSnapshotRoot, "input.md"), "changed during run\n");
			if (revokeDuringRun) authorized = false;
			if (revokePackageDuringRun) packageValid = false;
			yield { type: "completed", result: { agentId: "codex", status: "completed", content: "candidate" } };
		},
		async *continue() { throw new Error("compile must not continue"); },
		async *respond() { throw new Error("compile must not request input"); },
		async probe() { throw new Error("compile must not probe"); },
	};
	const runtime = new AgentRuntime(delegations, secrets, () => driver, undefined, undefined, undefined, undefined, {
		jobs, attestCompilerDriver: async (candidate, resolved) => {
			assert.equal(candidate.id, activeJob.id);
			assert.equal(resolved, driver);
			attestationCalls++;
			return !packageValid || attestationCalls === rejectAttestationAt ? undefined : "a".repeat(64);
		},
		authorizeJob: async (candidate) => {
			assert.equal(candidate.id, activeJob.id);
			if (!authorized) throw new Error("CompileJob authorization changed");
		},
		validateCandidate: async (candidate, outcome) => {
			candidateValidations++;
			assert.equal(candidate.id, activeJob.id);
			assert.equal(outcome.delegation.compileJobId, activeJob.id);
			assert.equal(outcome.status, "completed");
			if (revokeDuringValidation) authorized = false;
			if (revokePackageDuringValidation) packageValid = false;
			return "validated-batch";
		},
	});
	const outcome = await runtime.runCompileJob(job.id);
	assert.equal(outcome.status, "completed");
	assert.equal(started, 1);
	assert.equal((await jobs.get(job.id))?.status, "candidate_ready");
	assert.equal((await jobs.get(job.id))?.candidateBatchId, "validated-batch");
	await assert.rejects(runtime.runCompileJob(job.id), /not queued/);
	assert.equal(started, 1);
	for (const name of ["source2", "staging2", "private2"]) await mkdir(path.join(root, name), { mode: 0o700 });
	const second = await jobs.create({
		operationId: "compile:two", ownerId: job.ownerId, targetBindingId: job.targetBindingId,
		bindingRevision: job.bindingRevision, trustRevision: job.trustRevision, rootIdentity: job.rootIdentity,
		sourceAcceptanceIds: job.sourceAcceptanceIds, sourceSnapshotRefs: job.sourceSnapshotRefs, sourceSnapshotRoot: path.join(root, "source2"),
		stagingRoot: path.join(root, "staging2"), privateRoot: path.join(root, "private2"),
		compilerRef: job.compilerRef, compilerPackageSha256: job.compilerPackageSha256,
		agentId: job.agentId, agentRevision: job.agentRevision, task: job.task,
		commandPath, commandSha256: digest, baseManifestHash: job.baseManifestHash,
	});
	activeJob = second;
	requireInput = true;
	const rejected = await runtime.runCompileJob(second.id);
	assert.equal(rejected.status, "failed");
	assert.equal(rejected.result.status === "failed" ? rejected.result.errorCode : undefined, "compile_interaction_forbidden");
	assert.equal((await jobs.get(second.id))?.status, "failed");
	assert.equal((await delegations.listInteractions()).length, 0, "compiler approval must not enter the user approval queue");
	const nextInput = (number: number) => ({
		operationId: `compile:${number}`, ownerId: job.ownerId, targetBindingId: job.targetBindingId,
		bindingRevision: job.bindingRevision, trustRevision: job.trustRevision, rootIdentity: job.rootIdentity,
		sourceAcceptanceIds: job.sourceAcceptanceIds, sourceSnapshotRefs: job.sourceSnapshotRefs, sourceSnapshotRoot: path.join(root, `source${number}`),
		stagingRoot: path.join(root, `staging${number}`), privateRoot: path.join(root, `private${number}`),
		compilerRef: job.compilerRef, compilerPackageSha256: job.compilerPackageSha256,
		agentId: job.agentId, agentRevision: job.agentRevision, task: job.task,
		commandPath, commandSha256: digest, baseManifestHash: job.baseManifestHash,
	});
	for (const name of ["source3", "staging3", "private3"]) await mkdir(path.join(root, name), { mode: 0o700 });
	await writeFile(path.join(root, "source3", "input.md"), "approved\n");
	const third = await jobs.create(nextInput(3));
	activeJob = third;
	requireInput = false;
	await writeFile(path.join(root, "source3", "input.md"), "changed before run\n");
	const startsBeforeDrift = started;
	await assert.rejects(runtime.runCompileJob(third.id), /source snapshot changed/);
	assert.equal(started, startsBeforeDrift, "changed source must fail before the Driver starts");
	assert.equal((await jobs.get(third.id))?.failureCode, "source_snapshot_changed");
	for (const name of ["source4", "staging4", "private4"]) await mkdir(path.join(root, name), { mode: 0o700 });
	await writeFile(path.join(root, "source4", "input.md"), "approved\n");
	const fourth = await jobs.create(nextInput(4));
	activeJob = fourth;
	mutateSourceDuringRun = true;
	await assert.rejects(runtime.runCompileJob(fourth.id), /source snapshot changed/);
	assert.equal((await jobs.get(fourth.id))?.failureCode, "source_snapshot_changed");
	mutateSourceDuringRun = false;
	for (const name of ["source5", "staging5", "private5"]) await mkdir(path.join(root, name), { mode: 0o700 });
	const fifth = await jobs.create(nextInput(5));
	activeJob = fifth;
	revokeDuringRun = true;
	const validationsBeforeRevoke = candidateValidations;
	await assert.rejects(runtime.runCompileJob(fifth.id), /authorization changed/);
	assert.equal(candidateValidations, validationsBeforeRevoke, "revocation after Driver completion must prevent candidate validation");
	assert.equal((await jobs.get(fifth.id))?.failureCode, "compile_authorization_changed");
	revokeDuringRun = false;
	authorized = true;
	for (const name of ["source6", "staging6", "private6"]) await mkdir(path.join(root, name), { mode: 0o700 });
	const sixth = await jobs.create(nextInput(6));
	activeJob = sixth;
	revokeDuringValidation = true;
	await assert.rejects(runtime.runCompileJob(sixth.id), /authorization changed/);
	assert.equal(candidateValidations, validationsBeforeRevoke + 1, "validation ran once before revocation");
	assert.equal((await jobs.get(sixth.id))?.failureCode, "compile_authorization_changed");
	authorized = true;
	revokeDuringValidation = false;
	for (const name of ["source7", "staging7", "private7"]) await mkdir(path.join(root, name), { mode: 0o700 });
	const seventh = await jobs.create(nextInput(7));
	activeJob = seventh;
	rejectAttestationAt = attestationCalls + 1;
	const startsBeforeSpoof = started;
	await assert.rejects(runtime.runCompileJob(seventh.id), /not the reviewed loaded package/);
	assert.equal((await jobs.get(seventh.id))?.status, "queued", "untrusted Driver is rejected before claiming the Job");
	assert.equal(started, startsBeforeSpoof);
	for (const name of ["source8", "staging8", "private8"]) await mkdir(path.join(root, name), { mode: 0o700 });
	const eighth = await jobs.create(nextInput(8));
	activeJob = eighth;
	rejectAttestationAt = attestationCalls + 2;
	const deniedAtStart = await runtime.runCompileJob(eighth.id);
	assert.equal(deniedAtStart.status, "failed");
	assert.equal((await jobs.get(eighth.id))?.status, "failed", "replacement before first Driver event seals the claimed Job");
	assert.equal(started, startsBeforeSpoof);
	rejectAttestationAt = 0;
	for (const name of ["source9", "staging9", "private9"]) await mkdir(path.join(root, name), { mode: 0o700 });
	const ninth = await jobs.create(nextInput(9));
	activeJob = ninth;
	revokePackageDuringRun = true;
	const beforePackageRevoke = candidateValidations;
	await assert.rejects(runtime.runCompileJob(ninth.id), /not the reviewed loaded package/);
	assert.equal(candidateValidations, beforePackageRevoke, "replaced package after run must block candidate validation");
	assert.equal((await jobs.get(ninth.id))?.failureCode, "compiler_package_changed");
	revokePackageDuringRun = false;
	packageValid = true;
	for (const name of ["source10", "staging10", "private10"]) await mkdir(path.join(root, name), { mode: 0o700 });
	const tenth = await jobs.create(nextInput(10));
	activeJob = tenth;
	revokePackageDuringValidation = true;
	await assert.rejects(runtime.runCompileJob(tenth.id), /not the reviewed loaded package/);
	assert.equal((await jobs.get(tenth.id))?.failureCode, "compiler_package_changed");
});
