import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli)) throw new Error('Usage: node scripts/verify-installed-agent-enable-revision.mjs /absolute/path/to/puddingteams');

const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-enable-revision-');
const env = { ...process.env, HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
const reserve = createServer();
await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
const request = async (method, route, body) => {
  const response = await fetch(base + route, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const readAgent = async () => {
  const list = await request('GET', '/api/agents');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const agent = list.body.agents.find((item) => item.name === 'pi-b');
  assert.ok(agent);
  return agent;
};

let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const original = await readAgent();
  assert.equal(original.enabled, true);
  const disabled = await request('PUT', '/api/agents/pi-b/enabled', { enabled: false, expectedRevision: original.extensionRevision });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  const stale = await request('PUT', '/api/agents/pi-b/enabled', { enabled: true, expectedRevision: original.extensionRevision });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'binding_conflict');
  const missing = await request('PUT', '/api/agents/pi-b/enabled', { enabled: true });
  assert.equal(missing.status, 400, JSON.stringify(missing.body));
  const current = await readAgent();
  assert.equal(current.enabled, false);
  assert.equal(current.extensionRevision, disabled.body.revision);
  assert.equal(current.runConfigRevision, original.runConfigRevision ?? original.extensionRevision, '停用不得改变 Run 执行配置版本');
  console.log(JSON.stringify({ home, cli, initialRevision: original.extensionRevision, disabledRevision: disabled.body.revision, runConfigRevision: current.runConfigRevision, staleStatus: stale.status, missingRevisionStatus: missing.status, currentEnabled: current.enabled }, null, 2));
} finally {
  if (started) await run(cli, ['stop'], { env, timeout: 20000 }).catch(() => {});
}
