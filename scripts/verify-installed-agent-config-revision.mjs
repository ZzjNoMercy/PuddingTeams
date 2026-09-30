import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const cli = process.argv[2];
const mode = process.argv[3] ?? 'verify';
if (!cli || !path.isAbsolute(cli) || !['verify', 'browser-hold'].includes(mode)) throw new Error('Usage: node scripts/verify-installed-agent-config-revision.mjs /absolute/path/to/puddingteams [verify|browser-hold]');

const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-agent-config-');
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
  const create = await request('POST', '/api/agents', {
    name: 'fixture-worker', description: 'initial', enabled: false,
    invoke: { type: 'command', command: 'echo', runArgs: [] },
  });
  assert.equal(create.status, 200, JSON.stringify(create.body));

  const results = {};
  for (const name of ['manager', 'fixture-worker']) {
    const list = await request('GET', '/api/agents');
    assert.equal(list.status, 200);
    const initial = list.body.agents.find((agent) => agent.name === name);
    assert.ok(initial);
    const newer = await request('PUT', `/api/agents/${name}/config`, { expectedRevision: initial.extensionRevision, description: 'newer' });
    assert.equal(newer.status, 200, JSON.stringify(newer.body));
    const stale = await request('PUT', `/api/agents/${name}/config`, { expectedRevision: initial.extensionRevision, description: 'stale' });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    const missing = await request('PUT', `/api/agents/${name}/config`, { description: 'missing revision' });
    assert.equal(missing.status, 400, JSON.stringify(missing.body));
    const current = await request('GET', '/api/agents');
    assert.equal(current.body.agents.find((agent) => agent.name === name).description, 'newer');
    results[name] = { initialRevision: initial.extensionRevision, savedRevision: newer.body.revision, staleStatus: stale.status, missingRevisionStatus: missing.status };
  }
  const worker = (await request('GET', '/api/agents')).body.agents.find((agent) => agent.name === 'fixture-worker');
  const fullStale = await request('PUT', '/api/agents/fixture-worker', { ...worker, expectedRevision: worker.extensionRevision - 1, description: 'full stale' });
  assert.equal(fullStale.status, 409, JSON.stringify(fullStale.body));
  assert.equal((await request('GET', '/api/agents')).body.agents.find((agent) => agent.name === 'fixture-worker').description, 'newer');
  const fullCurrent = await request('PUT', '/api/agents/fixture-worker', { ...worker, expectedRevision: worker.extensionRevision, description: 'full current' });
  assert.equal(fullCurrent.status, 200, JSON.stringify(fullCurrent.body));
  const afterFull = (await request('GET', '/api/agents')).body.agents.find((agent) => agent.name === 'fixture-worker');
  assert.equal(afterFull.description, 'full current');
  assert.equal(Object.hasOwn(afterFull, 'expectedRevision'), false);
  console.log(JSON.stringify({ home, base, cli, mode, results, fullStaleStatus: fullStale.status, fullCurrentStatus: fullCurrent.status, revisionFieldPersisted: false }, null, 2));
  if (mode === 'browser-hold') {
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); process.off('SIGINT', done); process.off('SIGTERM', done); resolve(); };
      const timer = setTimeout(done, 15 * 60_000);
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
  }
} finally {
  if (started) await run(cli, ['stop'], { env, timeout: 20000 }).catch(() => {});
}
