import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

// Real first-party Codex Connector rehearsal. The Teams Home and workspace are
// isolated; Codex uses the operator's existing login without copying auth files.
const cli = process.argv[2];
const mode = process.argv[3] ?? 'verify';
if (!cli || !path.isAbsolute(cli) || !['verify', 'browser-hold'].includes(mode)) {
  throw new Error('Usage: node scripts/verify-installed-real-codex-direct.mjs /absolute/path/to/puddingteams [verify|browser-hold]');
}
const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-real-codex-');
const workspace = await mkdtemp('/private/tmp/puddingteams-real-codex-workspace-');
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  USER: process.env.USER,
  LOGNAME: process.env.LOGNAME,
  TMPDIR: process.env.TMPDIR,
  LANG: process.env.LANG,
  PUDDINGTEAMS_HOME: home,
  PI_CODING_AGENT_DIR: path.join(home, 'pi-agent'),
};
const reserve = createTcpServer();
await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
const request = async (method, route, body) => {
  const response = await fetch(base + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(route.endsWith('/messages') ? { 'idempotency-key': randomUUID() } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const ok = async (method, route, body) => {
  const result = await request(method, route, body);
  assert.equal(result.status, 200, `${method} ${route}: ${JSON.stringify(result.body)}`);
  return result.body;
};
let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { cwd: workspace, env, timeout: 30_000 });
  started = true;
  const codex = (await ok('GET', '/api/agents')).agents.find((agent) => agent.name === 'codex');
  assert.ok(codex?.enabled, 'bundled Codex Worker must be enabled');
  assert.equal(codex.connector?.connectorId, 'codex');
  const options = (await ok('GET', '/api/agents/codex/connector/config-options/model')).options;
  assert.ok(Array.isArray(options) && options.length > 0, 'Codex must report account-available models');
  const model = (options.find((option) => option.isDefault) ?? options[0]).value;
  await ok('PUT', '/api/agents/codex/connector', {
    ...codex.connector,
    config: { sandbox: 'read-only', model },
    expectedRevision: codex.extensionRevision,
  });
  const createdWorkspace = (await ok('POST', '/api/workspaces', { path: workspace, name: 'isolated-codex-rehearsal' })).workspace;
  const room = (await ok('POST', '/api/rooms', { type: 'direct', members: ['codex'], workspaceId: createdWorkspace.id })).room;
  assert.equal(room.cwdSnapshot, workspace, 'Codex must run in the empty isolated workspace');
  const sessionId = room.activeSession;
  await ok('POST', `/api/sessions/${sessionId}/messages`, { content: '请只回答：REAL_CODEX_CONNECTOR_OK。不要修改文件。' });
  const deadline = Date.now() + 120_000;
  let outcome;
  let types = [];
  while (Date.now() < deadline) {
    const messages = (await ok('GET', `/api/sessions/${sessionId}/messages`)).messages;
    types = messages.filter((item) => item.role === 'custom').map((item) => item.customType);
    outcome = messages.find((item) => item.customType === 'pudding:task_result');
    if (outcome) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.ok(outcome, `Codex direct result timed out; custom types: ${types.join(', ')}`);
  const serialized = JSON.stringify(outcome);
  assert.match(serialized, /REAL_CODEX_CONNECTOR_OK/, `Codex result did not contain expected answer: ${serialized.slice(0, 800)}`);
  console.log(JSON.stringify({ home, workspace, base, mode, roomId: room.id, sessionId, connector: codex.connector.connectorId, model, customTypes: types, resultMatched: true }, null, 2));
  if (mode === 'browser-hold') {
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); process.off('SIGINT', done); process.off('SIGTERM', done); resolve(); };
      const timer = setTimeout(done, 15 * 60_000);
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
  }
} finally {
  if (started) await run(cli, ['stop'], { cwd: workspace, env, timeout: 20_000 }).catch(() => {});
}
