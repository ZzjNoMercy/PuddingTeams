import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli)) throw new Error('Usage: node scripts/verify-installed-connector-revision.mjs /absolute/path/to/puddingteams');

const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-connector-revision-');
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

let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const initial = await request('GET', '/api/agents');
  assert.equal(initial.status, 200);
  const agent = initial.body.agents.find((item) => item.name === 'puddingclaw');
  assert.ok(agent);
  const input = { extensionId: 'puddingclaw', connectorId: 'puddingclaw', transport: 'spawn', config: { command: 'puddingclaw' } };
  const saved = await request('PUT', '/api/agents/puddingclaw/connector', { ...input, expectedRevision: agent.extensionRevision });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const stale = await request('PUT', '/api/agents/puddingclaw/connector', { ...input, expectedRevision: agent.extensionRevision, config: { command: 'old' } });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'binding_conflict');
  const missing = await request('PUT', '/api/agents/puddingclaw/connector', input);
  assert.equal(missing.status, 400, JSON.stringify(missing.body));
  const current = await request('GET', '/api/agents');
  const persisted = current.body.agents.find((item) => item.name === 'puddingclaw');
  assert.deepEqual(persisted.connector.config, { command: 'puddingclaw' });
  assert.equal(persisted.extensionRevision, saved.body.revision);
  console.log(JSON.stringify({ home, cli, initialRevision: agent.extensionRevision, savedRevision: saved.body.revision, staleStatus: stale.status, missingRevisionStatus: missing.status, currentConfig: persisted.connector.config }, null, 2));
} finally {
  if (started) await run(cli, ['stop'], { env, timeout: 20000 }).catch(() => {});
}
