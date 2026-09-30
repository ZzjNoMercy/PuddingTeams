import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli)) throw new Error('Usage: node scripts/verify-installed-harness-settings.mjs /absolute/path/to/installed/bin/puddingteams');
const home = await mkdtemp('/private/tmp/puddingteams-m1-harness-');
const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
const reserve = createServer();
await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
const request = async (method, body) => {
  const response = await fetch(`${base}/api/settings/harness`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() };
};
let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const initial = await request('GET');
  assert.equal(initial.status, 200);
  assert.match(initial.body.revision, /^[a-f0-9]{64}$/);
  const missing = await request('PUT', { codeSearch: { defaultProvider: 'fff' } });
  assert.equal(missing.status, 428);
  const accepted = await request('PUT', { expectedRevision: initial.body.revision, codeSearch: { defaultProvider: 'fff' } });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.notEqual(accepted.body.revision, initial.body.revision);
  const stale = await request('PUT', { expectedRevision: initial.body.revision, goalRecovery: { mode: 'manual' } });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.currentRevision, accepted.body.revision);
  const beforeRestart = await request('GET');
  assert.equal(beforeRestart.body.revision, accepted.body.revision);
  assert.equal(beforeRestart.body.harness.codeSearch.defaultProvider, 'fff');
  assert.equal(beforeRestart.body.harness.goalRecovery.mode, 'safe_auto');
  await run(cli, ['stop'], { env, timeout: 30000 });
  started = false;
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const afterRestart = await request('GET');
  assert.equal(afterRestart.body.revision, accepted.body.revision);
  assert.equal(afterRestart.body.harness.goalRecovery.mode, 'safe_auto');
  const normalized = await request('PUT', { expectedRevision: afterRestart.body.revision, verification: { reviewers: { evidenceModel: '  provider/model  ' } } });
  assert.equal(normalized.status, 200, JSON.stringify(normalized.body));
  assert.equal(normalized.body.harness.verification.reviewers.evidenceModel, 'provider/model');
  assert.equal(normalized.body.revision, (await request('GET')).body.revision);
  console.log(JSON.stringify({ home, initialRevision: initial.body.revision, acceptedRevision: accepted.body.revision, staleStatus: stale.status, revisionStableAcrossRestart: true, normalizedRevisionMatchesGet: true }, null, 2));
} finally {
  if (started) await run(cli, ['stop'], { env, timeout: 30000 }).catch(() => undefined);
}
