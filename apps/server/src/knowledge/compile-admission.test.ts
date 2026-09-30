import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDriver } from "../agent-runtime/types.js";
import type { AgentConfig } from "../store/teams.js";
import { KnowledgeAcceptanceStore } from "./acceptance.js";
import { KnowledgeBindingRegistry } from "./bindings.js";
import { createCompileAdmission } from "./compile-admission.js";
import { CompileJobStore } from "./compile-jobs.js";
import { fingerprintCompileSnapshot } from "./compile-snapshot.js";
import type { CompileJob } from "./contracts.js";
import { KnowledgeObjectStore } from "./objects.js";
import { KnowledgeObservationService } from "./observation.js";

test("生产 CompileAdmission 复核当前绑定、Agent、采纳身份和真实 Driver 实例；候选拒绝非本 Job 委托结果", async () => {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pt-compile-prod-admission-")));
	const vault = path.join(root, "vault");
	await mkdir(vault);
	const source = path.join(vault, "a.md");
	await writeFile(source, "# Accepted\n");
	const bindings = new KnowledgeBindingRegistry(path.join(root, "state"));
	const binding = await bindings.create({ ownerId: "owner", name: "Wiki", description: "Test", rootPath: vault });
	const objects = new KnowledgeObjectStore(path.join(root, "objects"));
	const blob = await objects.put(Buffer.from("# Accepted\n"));
	const acceptance = new KnowledgeAcceptanceStore(path.join(root, "acceptance"));
	await acceptance.adopt(binding.id, [{ relativePath: "a.md", contentHash: blob.hash, snapshotRef: blob.hash, acceptedBy: "owner" }], 0);
	const accepted = Object.values((await acceptance.getSnapshot(binding.id)).entries)[0]!;
	const observation = new KnowledgeObservationService(acceptance, { objects });
	const snapshotRoot = path.join(root, "snapshot");
	await mkdir(snapshotRoot);
	await writeFile(path.join(snapshotRoot, "a.md"), "# Accepted\n");
	let agentRevision = 1;
	let attestedDriver: AgentDriver | undefined;
	const digest = "a".repeat(64);
	const admission = createCompileAdmission({
		jobs: new CompileJobStore(path.join(root, "state")), bindings, acceptance, observation, objects,
		teams: { getAgent: async () => ({ name: "codex", description: "Compiler", enabled: true,
			connector: { connectorId: "codex", transport: "spawn", config: {} }, extensionRevision: agentRevision }) as AgentConfig },
		extensions: { attestBundledDriver: async (id, driver) => {
			assert.equal(id, "codex"); attestedDriver = driver; return digest;
		} },
	});
	const job = {
		ownerId: "owner", targetBindingId: binding.id, bindingRevision: binding.bindingRevision,
		trustRevision: binding.trustRevision, rootIdentity: binding.rootIdentity, agentId: "codex", agentRevision: 1,
		sourceAcceptanceIds: [accepted.acceptanceId], sourceSnapshotRefs: [blob.hash], compilerPackageSha256: digest,
		sourceSnapshotRoot: snapshotRoot, sourceSnapshotHash: await fingerprintCompileSnapshot(snapshotRoot),
	} as CompileJob;
	const driver = { id: "codex" } as AgentDriver;
	assert.equal(await admission.attestCompilerDriver(job, driver), digest);
	assert.equal(attestedDriver, driver);
	await admission.authorizeJob(job);
	await assert.rejects(admission.validateCandidate(job, {} as never), /did not come from the Job's own completed compile Delegation/);
	await writeFile(path.join(snapshotRoot, "a.md"), "# Injected\n");
	await assert.rejects(admission.authorizeJob({ ...job, sourceSnapshotHash: await fingerprintCompileSnapshot(snapshotRoot) }),
		/source snapshot does not match accepted objects/, "correct acceptanceId must not authorize different worker-visible bytes");
	await writeFile(path.join(snapshotRoot, "a.md"), "# Accepted\n");
	await writeFile(path.join(snapshotRoot, "extra.md"), "# Unexpected\n");
	await assert.rejects(admission.authorizeJob({ ...job, sourceSnapshotHash: await fingerprintCompileSnapshot(snapshotRoot) }),
		/source snapshot does not match accepted objects/, "unselected files must not enter compiler source");
	await rm(path.join(snapshotRoot, "extra.md"));

	await writeFile(source, "# Changed\n");
	await assert.rejects(admission.authorizeJob(job), /source is no longer current/);
	await writeFile(source, "# Accepted\n");
	await acceptance.adopt(binding.id, [{ relativePath: "a.md", contentHash: blob.hash, snapshotRef: blob.hash, acceptedBy: "owner" }], (await acceptance.getSnapshot(binding.id)).acceptanceRevision);
	await assert.rejects(admission.authorizeJob(job), /accepted source identity changed/);
	const latest = Object.values((await acceptance.getSnapshot(binding.id)).entries)[0]!;
	const reacceptedJob = { ...job, sourceAcceptanceIds: [latest.acceptanceId] };
	await admission.authorizeJob(reacceptedJob);
	const changedDuringScan = createCompileAdmission({
		jobs: new CompileJobStore(path.join(root, "state")), bindings, acceptance, objects,
		observation: { scan: async (current) => {
			const snapshot = await observation.scan(current);
			await acceptance.adopt(binding.id, [{ relativePath: "a.md", contentHash: blob.hash, snapshotRef: blob.hash, acceptedBy: "owner" }], (await acceptance.getSnapshot(binding.id)).acceptanceRevision);
			return snapshot;
		} },
		teams: { getAgent: async () => ({ name: "codex", description: "Compiler", enabled: true,
			connector: { connectorId: "codex", transport: "spawn", config: {} }, extensionRevision: agentRevision }) as AgentConfig },
		extensions: { attestBundledDriver: async () => digest },
	});
	await assert.rejects(changedDuringScan.authorizeJob(reacceptedJob), /authority changed during source observation/);
	const newest = Object.values((await acceptance.getSnapshot(binding.id)).entries)[0]!;
	const currentJob = { ...job, sourceAcceptanceIds: [newest.acceptanceId] };
	agentRevision = 2;
	await assert.rejects(admission.authorizeJob(currentJob), /Agent authority changed/);
	await assert.rejects(admission.authorizeJob({ ...currentJob, ownerId: "intruder" }), /knowledge binding not found/);
});
