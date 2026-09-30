import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli)) throw new Error('Usage: node scripts/verify-installed-manager-resources-revision.mjs /absolute/path/to/puddingteams');

const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-manager-resources-');
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
const readAgent = async (name) => {
  const list = await request('GET', '/api/agents');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const agent = list.body.agents.find((item) => item.name === name);
  assert.ok(agent, `missing ${name}`);
  return agent;
};

let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const manager = await readAgent('manager');
  const savedManager = await request('PATCH', '/api/agents/manager/manager', { expectedRevision: manager.extensionRevision, description: 'new manager' });
  assert.equal(savedManager.status, 200, JSON.stringify(savedManager.body));
  const staleManager = await request('PATCH', '/api/agents/manager/manager', { expectedRevision: manager.extensionRevision, description: 'old manager' });
  assert.equal(staleManager.status, 409, JSON.stringify(staleManager.body));
  const missingManager = await request('PATCH', '/api/agents/manager/manager', { description: 'missing revision' });
  assert.equal(missingManager.status, 400, JSON.stringify(missingManager.body));
  assert.equal((await readAgent('manager')).description, 'new manager');

  const results = {};
  for (const name of ['manager', 'pi-b']) {
    const agent = await readAgent(name);
    if (!agent.pinned && agent.connector?.connectorId !== 'pi') throw new Error(`${name} is not a Pi Agent`);
    const saved = await request('PUT', `/api/agents/${name}/pi-resources`, { expectedRevision: agent.extensionRevision, piResources: { enabledSkills: ['new'] } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const stale = await request('PUT', `/api/agents/${name}/pi-resources`, { expectedRevision: agent.extensionRevision, piResources: { enabledSkills: ['old'] } });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    const missing = await request('PUT', `/api/agents/${name}/pi-resources`, { piResources: null });
    assert.equal(missing.status, 400, JSON.stringify(missing.body));
    const current = await readAgent(name);
    assert.deepEqual(current.piResources.enabledSkills, ['new']);
    results[name] = { initialRevision: agent.extensionRevision, savedRevision: saved.body.revision, staleStatus: stale.status, missingRevisionStatus: missing.status };
  }
  console.log(JSON.stringify({ home, cli, managerPatch: { initialRevision: manager.extensionRevision, savedRevision: savedManager.body.revision, staleStatus: staleManager.status, missingRevisionStatus: missingManager.status }, piResources: results }, null, 2));
} finally {
  if (started) await run(cli, ['stop'], { env, timeout: 20000 }).catch(() => {});
}
