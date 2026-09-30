import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const cli = process.argv[2];
const mode = process.argv[3] ?? 'verify';
if (!cli || !path.isAbsolute(cli) || !['verify', 'browser-hold'].includes(mode)) throw new Error('Usage: node scripts/verify-installed-mcp-revision.mjs /absolute/path/to/puddingteams [verify|browser-hold]');

const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-mcp-revision-');
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
  return { status: response.status, body: await response.json() };
};

let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const created = await request('POST', '/api/extensions/mcp/servers', {
    id: 'fixture-docs',
    displayName: 'Fixture Docs',
    definition: { url: 'https://mcp.example.test' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const initial = await request('GET', '/api/agents/manager/mcp');
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.deepEqual(initial.body.serverIds, []);
  const selected = await request('PUT', '/api/agents/manager/mcp', {
    expectedRevision: initial.body.revision,
    serverIds: ['fixture-docs'],
  });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));

  const stale = await request('PUT', '/api/agents/manager/mcp', {
    expectedRevision: initial.body.revision,
    serverIds: [],
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'binding_conflict');
  const current = await request('GET', '/api/agents/manager/mcp');
  assert.equal(current.status, 200, JSON.stringify(current.body));
  assert.deepEqual(current.body.serverIds, ['fixture-docs']);
  assert.equal(current.body.revision, selected.body.revision);

  const missingRevision = await request('PUT', '/api/agents/manager/mcp', { serverIds: [] });
  assert.equal(missingRevision.status, 400, JSON.stringify(missingRevision.body));
  const updated = await request('PUT', '/api/extensions/mcp/servers/fixture-docs', {
    displayName: 'Fixture Docs Updated',
    definition: { url: 'https://mcp-updated.example.test' },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const afterUpdate = await request('GET', '/api/agents/manager/mcp');
  assert.equal(afterUpdate.body.revision, selected.body.revision + 1, 'MCP 目录变化须使引用它的 Agent 修订失效');
  assert.deepEqual(afterUpdate.body.serverIds, ['fixture-docs']);
  console.log(JSON.stringify({ home, base, cli, mode, initialRevision: initial.body.revision, selectedRevision: selected.body.revision, catalogUpdateRevision: afterUpdate.body.revision, staleStatus: stale.status, staleCode: stale.body.code, currentServerIds: afterUpdate.body.serverIds, missingRevisionStatus: missingRevision.status }, null, 2));
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
