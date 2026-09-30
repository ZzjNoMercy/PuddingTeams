import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, link, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RuntimeOutcome } from "../agent-runtime/runtime.js";
import { KnowledgeAcceptanceStore, type StoredAcceptedNoteVersion } from "./acceptance.js";
import { KnowledgeBindingRegistry } from "./bindings.js";
import { candidateBatchIdFor, composeCompileTask, createCandidateValidator, readCandidateBatch } from "./candidate.js";
import { CompileJobStore } from "./compile-jobs.js";
import { publicationManifestHash, type CompileJob } from "./contracts.js";
import { KnowledgeObjectStore } from "./objects.js";
import { resolveEffectiveSchema } from "./schema-impact.js";
import { copySchemaPreset, hashTeamsSchema } from "./schema-presets.js";

async function setupFixture(opts: { schemaPresetId?: string } = {}) {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "pt-candidate-")));
	const vault = path.join(root, "vault");
	await mkdir(vault);
	await writeFile(path.join(vault, "a.md"), "# Accepted\n");
	if (opts.schemaPresetId) await writeFile(path.join(vault, "wiki.schema.json"), JSON.stringify(copySchemaPreset(opts.schemaPresetId)));
	const bindings = new KnowledgeBindingRegistry(path.join(root, "state"));
	const binding = await bindings.create({ ownerId: "owner", name: "Wiki", description: "Test", rootPath: vault });
	const objects = new KnowledgeObjectStore(path.join(root, "objects"));
	const blob = await objects.put(await readFile(path.join(vault, "a.md")));
	const acceptance = new KnowledgeAcceptanceStore(path.join(root, "acceptance"));
	await acceptance.adopt(binding.id, [{ relativePath: "a.md", contentHash: blob.hash, snapshotRef: blob.hash, acceptedBy: "owner" }], 0);
	const sourceEntry = Object.values((await acceptance.getSnapshot(binding.id)).entries)[0]! as StoredAcceptedNoteVersion;
	const jobs = new CompileJobStore(path.join(root, "state"));
	const sourceSnapshotRoot = path.join(root, "source");
	await mkdir(sourceSnapshotRoot);
	await writeFile(path.join(sourceSnapshotRoot, "a.md"), "# Accepted\n");
	const stagingRoot = path.join(root, "staging");
	const privateRoot = path.join(root, "private");
	await mkdir(stagingRoot, { mode: 0o700 });
	await mkdir(privateRoot, { mode: 0o700 });
	const job = await jobs.create({
		operationId: "compile-op", ownerId: "owner", targetBindingId: binding.id,
		bindingRevision: binding.bindingRevision, trustRevision: binding.trustRevision, rootIdentity: binding.rootIdentity,
		sourceAcceptanceIds: [sourceEntry.acceptanceId], sourceSnapshotRefs: [sourceEntry.snapshotRef],
		sourceSnapshotRoot, stagingRoot, privateRoot,
		compilerRef: "@puddingteams/connector-codex", compilerPackageSha256: "a".repeat(64),
		agentId: "codex", agentRevision: 1, task: "compile",
		commandPath: path.join(root, "codex-stub"), commandSha256: "b".repeat(64),
		baseManifestHash: "c".repeat(64),
		...(opts.schemaPresetId ? { schemaHash: hashTeamsSchema((await resolveEffectiveSchema(binding)).schema!) } : {}),
	});
	const outcome = {
		status: "completed",
		result: { agentId: "codex", status: "completed", content: "done" },
		delegation: { id: "delegation-1", purpose: "knowledge_compile", compileJobId: job.id },
	} as unknown as RuntimeOutcome;
	const validator = createCandidateValidator({ bindings, acceptance, objects });
	const writeCandidate = async (relative: string, content: string) => {
		const target = path.join(stagingRoot, relative);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, content);
	};
	return { root, binding, bindings, acceptance, objects, jobs, job, outcome, sourceEntry, stagingRoot, validator, writeCandidate };
}

const candidateNote = (sourceId: string, pin?: string) => `---\nsources:\n  - ${pin ? `${sourceId}#${pin}` : sourceId}\n---\n# Compiled\n`;

test("Markdown-only编译准入拒绝未冻结原件的shortcut/编码图片，代码示例仍可编译", async () => {
	const f = await setupFixture();
	try {
		for (const reference of [`![image](assets/images/${"a".repeat(64)}.png)`, `![image]\n\n[image]: assets/%69mages/${"a".repeat(64)}.png`]) {
			await f.writeCandidate("page.md", candidateNote(f.sourceEntry.acceptanceId) + reference);
			await assert.rejects(f.validator(f.job, f.outcome), /frozen original authority/);
			await assert.rejects(readCandidateBatch(f.job), /ENOENT/);
		}
		await f.writeCandidate("page.md", candidateNote(f.sourceEntry.acceptanceId) + "\n```md\n![example](assets/images/example.png)\n```\n");
		assert.equal(await f.validator(f.job, f.outcome), candidateBatchIdFor(f.job));
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("候选验证：冻结字节进对象库、计算 create/update 基线、批次原子落盘并可往返复核", async () => {
	const { job, outcome, sourceEntry, objects, validator, writeCandidate } = await setupFixture();
	await writeCandidate("Daily/2026-09-28.md", candidateNote(sourceEntry.acceptanceId));
	await writeCandidate("a.md", candidateNote(sourceEntry.acceptanceId, "a.md"));
	const batchId = await validator(job, outcome);
	assert.equal(batchId, candidateBatchIdFor(job));
	const batch = await readCandidateBatch(job);
	assert.equal(batch.id, batchId);
	assert.equal(batch.bindingId, job.targetBindingId);
	assert.equal(batch.rootIdentity, job.rootIdentity);
	assert.equal(batch.manifestHash, publicationManifestHash(batch));
	assert.equal(batch.status, "candidate");
	assert.equal(batch.revision, 1);
	assert.equal(batch.compilerVersion, `@puddingteams/connector-codex#${"a".repeat(64)}`);
	assert.deepEqual(batch.files.map((file) => file.targetPath), ["Daily/2026-09-28.md", "a.md"]);
	assert.deepEqual(batch.dependencyGroups, [["Daily/2026-09-28.md", "a.md"]]);
	assert.deepEqual(batch.sourceSnapshots, [sourceEntry.snapshotRef]);
	const created = batch.files[0]!;
	assert.equal(created.operation, "create");
	assert.equal(created.expectedHashOrAbsent, null);
	const updated = batch.files[1]!;
	assert.equal(updated.operation, "update");
	assert.equal(updated.expectedHashOrAbsent, sourceEntry.contentHash);
	for (const file of batch.files) {
		assert.match(file.candidateHash ?? "", /^[a-f0-9]{64}$/);
		assert.equal(file.blobRef, file.candidateHash);
		const bytes = await objects.get(file.blobRef!);
		assert.ok(bytes.length > 0);
	}
	const receipt = JSON.parse(batch.validationReceipt) as Record<string, unknown>;
	assert.equal(receipt.version, 1);
	assert.equal(receipt.schemaHash, null);
	assert.deepEqual(receipt.schemaCheckedFiles, []);
	assert.deepEqual(receipt.sourceAcceptanceIds, [sourceEntry.acceptanceId]);
	assert.deepEqual(receipt.referencedSourceIds, [sourceEntry.acceptanceId]);
	assert.deepEqual(receipt.unsupportedOperations, []);
	const written = await stat(path.join(job.privateRoot, "candidate-batch.json"));
	assert.equal(written.mode & 0o077, 0, "批次文件必须仅属主可读写");
});

test("候选验证：outcome 必须来自本 Job 已完成的编译 Delegation", async () => {
	const { job, outcome, validator, writeCandidate } = await setupFixture();
	await writeCandidate("a.md", candidateNote(job.sourceAcceptanceIds[0]!));
	await assert.rejects(validator(job, { ...outcome, status: "failed" } as RuntimeOutcome), /did not come from the Job's own completed compile Delegation/);
	await assert.rejects(validator(job, { ...outcome, delegation: { id: "other", purpose: "execution", compileJobId: job.id } } as unknown as RuntimeOutcome),
		/did not come from the Job's own completed compile Delegation/);
	await assert.rejects(validator(job, { ...outcome, delegation: { id: "other", purpose: "knowledge_compile", compileJobId: "other-job" } } as unknown as RuntimeOutcome),
		/did not come from the Job's own completed compile Delegation/);
});

test("候选验证：缺 sources 或引用冻结集合外来源一律拒绝", async () => {
	const { job, outcome, validator, writeCandidate } = await setupFixture();
	await writeCandidate("a.md", "---\ntitle: no sources\n---\n# Compiled\n");
	await assert.rejects(validator(job, outcome), /does not declare any accepted source/);
	await writeCandidate("a.md", `---\nsources:\n  - ${job.sourceAcceptanceIds[0]}\n  - not-a-job-source\n---\n# Compiled\n`);
	await assert.rejects(validator(job, outcome), /outside the Job's frozen set/);
});

test("候选验证：钉住路径必须等于账本相对路径", async () => {
	const { job, outcome, sourceEntry, validator, writeCandidate } = await setupFixture();
	await writeCandidate("a.md", candidateNote(sourceEntry.acceptanceId, "other.md"));
	await assert.rejects(validator(job, outcome), /pins a source path that does not match the accepted note/);
});

test("候选验证：隐藏项、符号链接、硬链接、非 .md 与反斜杠文件名一律拒绝", async () => {
	const { root, job, outcome, validator, writeCandidate, stagingRoot, sourceEntry } = await setupFixture();
	const valid = () => writeCandidate("ok.md", candidateNote(sourceEntry.acceptanceId));
	await valid();
	await writeCandidate(".hidden.md", candidateNote(sourceEntry.acceptanceId));
	await assert.rejects(validator(job, outcome), /hidden entry/);
	await rm(path.join(stagingRoot, ".hidden.md"));
	await symlink(path.join(root, "vault", "a.md"), path.join(stagingRoot, "link.md"));
	await assert.rejects(validator(job, outcome), /link or special file/);
	await rm(path.join(stagingRoot, "link.md"));
	await link(path.join(stagingRoot, "ok.md"), path.join(stagingRoot, "hard.md"));
	await assert.rejects(validator(job, outcome), /hard link/);
	await rm(path.join(stagingRoot, "hard.md"));
	await writeCandidate("note.txt", "not markdown\n");
	await assert.rejects(validator(job, outcome), /invalid target path/);
	await rm(path.join(stagingRoot, "note.txt"));
	await writeCandidate("weird\\name.md", candidateNote(sourceEntry.acceptanceId));
	await assert.rejects(validator(job, outcome), /invalid target path/);
});

test("候选验证：空文件视为删除请求并整批拒绝", async () => {
	const { job, outcome, validator, writeCandidate, sourceEntry } = await setupFixture();
	await writeCandidate("ok.md", candidateNote(sourceEntry.acceptanceId));
	await writeCandidate("empty.md", "  \n");
	await assert.rejects(validator(job, outcome), /requests a deletion, which is not supported/);
});

test("候选验证：同输入重复验证产出稳定 manifestHash", async () => {
	const { job, outcome, validator, writeCandidate, sourceEntry } = await setupFixture();
	await writeCandidate("a.md", candidateNote(sourceEntry.acceptanceId));
	const first = await validator(job, outcome);
	const firstBatch = await readCandidateBatch(job);
	const second = await validator(job, outcome);
	const secondBatch = await readCandidateBatch(job);
	assert.equal(first, second);
	assert.equal(firstBatch.manifestHash, secondBatch.manifestHash);
	assert.equal(firstBatch.manifestHash, publicationManifestHash(firstBatch));
});

test("候选验证：带结构绑定时逐文件校验 Teams 结构", async () => {
	const { job, outcome, validator, writeCandidate, sourceEntry } = await setupFixture({ schemaPresetId: "personal-assistant" });
	const daily = (title: string) => `---\nid: daily-2026-09-28\ntype: daily\ntitle: ${title}\ndate: 2026-09-28\nsources:\n  - ${sourceEntry.acceptanceId}\n---\n# 2026-09-28\n`;
	await writeCandidate("Daily/2026-09-28.md", daily("日记"));
	const batchId = await validator(job, outcome);
	const batch = await readCandidateBatch(job);
	assert.equal(batch.id, batchId);
	assert.equal(batch.schemaHash, job.schemaHash);
	assert.deepEqual(JSON.parse(batch.validationReceipt).schemaCheckedFiles, ["Daily/2026-09-28.md"]);
	await writeCandidate("Daily/2026-09-28.md", daily("日记").replace(/^title: 日记\n/m, ""));
	await assert.rejects(validator(job, outcome), /failed schema validation: missing:title/);
});

test("composeCompileTask：平台约定段只由 Job 冻结字段构成，重放可逐字节比对", async () => {
	const { job } = await setupFixture();
	const first = composeCompileTask("整理笔记", job);
	const second = composeCompileTask("整理笔记", job);
	assert.equal(first, second);
	assert.ok(first.startsWith("整理笔记"));
	assert.ok(first.includes(job.sourceSnapshotRoot));
	assert.ok(first.includes(job.sourceAcceptanceIds[0]!));
	assert.ok(first.includes(job.sourceSnapshotRefs[0]!));
	assert.ok(first.includes("删除请求"));
});
