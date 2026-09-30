import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexDriver } from '../extensions/connectors/codex/driver/index.ts';
import { AgentRuntime } from '../apps/server/src/agent-runtime/runtime.ts';
import { DelegationStore } from '../apps/server/src/agent-runtime/delegation-store.ts';
import { InteractionSecretStore } from '../apps/server/src/agent-runtime/interaction-secret-store.ts';
import { CompileJobStore } from '../apps/server/src/knowledge/compile-jobs.ts';

const commandPath = process.argv[2];
if (process.platform !== 'darwin' || !commandPath || !path.isAbsolute(commandPath)) {
  throw new Error('Usage on macOS: apps/server/node_modules/.bin/tsx scripts/probe-compile-job-runtime-native.mjs /absolute/native/codex');
}
const command = await realpath(commandPath);
assert.equal(command, commandPath);
const commandSha256 = createHash('sha256').update(await readFile(command)).digest('hex');
const root = await realpath(await mkdtemp('/private/tmp/puddingteams-t03-job-runtime-'));
for (const name of ['state', 'source', 'staging', 'private', 'wiki', 'control']) {
  await mkdir(path.join(root, name), { mode: 0o700 });
}
await chmod(path.join(root, 'private'), 0o700);
await writeFile(path.join(root, 'source', 'approved.md'), 'synthetic accepted source\n');
await writeFile(path.join(root, 'wiki', 'page.md'), 'formal wiki unchanged\n');
await writeFile(path.join(root, 'control', 'secret'), 'synthetic control secret\n');
const jobs = new CompileJobStore(path.join(root, 'state'));
// This is a cold-profile integration probe, not a package-attestation gate.
const probePackageDigest = 'a'.repeat(64);
const job = await jobs.create({
  operationId: 'native-runtime-probe', ownerId: 'local-fixture', targetBindingId: 'synthetic-binding',
  bindingRevision: 1, trustRevision: 1, rootIdentity: 'synthetic-root',
  sourceSnapshotRefs: ['synthetic-approved-source'], sourceSnapshotRoot: path.join(root, 'source'),
  stagingRoot: path.join(root, 'staging'), privateRoot: path.join(root, 'private'),
  compilerRef: '@puddingteams/connector-codex', compilerPackageSha256: probePackageDigest,
  agentId: 'codex', agentRevision: 1, task: 'Read the approved source and answer with OK. Do not access any other directory.',
  commandPath: command, commandSha256, baseManifestHash: 'b'.repeat(64),
});
const delegations = new DelegationStore(path.join(root, 'state')); await delegations.init();
const secrets = new InteractionSecretStore(path.join(root, 'state')); await secrets.init();
const driver = new CodexDriver({ timeoutMs: 10_000 });
const runtime = new AgentRuntime(delegations, secrets, () => driver, undefined, undefined, undefined, undefined, {
  jobs, trustedCompilerPackageSha256: probePackageDigest,
  authorizeJob: async (frozen) => { assert.equal(frozen.id, job.id); },
  validateCandidate: async () => { throw new Error('cold profile must not admit a candidate'); },
});
const outcome = await runtime.runCompileJob(job.id);
const recordedJob = await jobs.get(job.id);
const recordedDelegation = await delegations.getDelegation(recordedJob.delegationId);
assert.equal(recordedJob.status, 'failed', 'offline native run must not admit a candidate');
assert.equal(recordedJob.candidateBatchId, undefined);
assert.equal(recordedDelegation?.compileJobId, job.id);
assert.equal(recordedDelegation?.purpose, 'knowledge_compile');
assert.equal(recordedDelegation?.executionState, 'reported_failed');
assert.equal(await readFile(path.join(root, 'wiki', 'page.md'), 'utf8'), 'formal wiki unchanged\n');
assert.equal(await readFile(path.join(root, 'control', 'secret'), 'utf8'), 'synthetic control secret\n');
console.log(JSON.stringify({
  root, command, commandSha256, jobId: job.id, jobStatus: recordedJob.status,
  jobFailureCode: recordedJob.failureCode, delegationId: recordedDelegation.id,
  delegationPurpose: recordedDelegation.purpose, delegationState: recordedDelegation.executionState,
  outcomeStatus: outcome.status, outcomeErrorCode: outcome.result.status === 'failed' ? outcome.result.errorCode : undefined,
  wikiUnchanged: true, controlUnchanged: true, packageAttested: false, modelCompleted: false, t03Admitted: false,
}, null, 2));
