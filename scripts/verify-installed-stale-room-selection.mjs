import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli)) throw new Error('Usage: node scripts/verify-installed-stale-room-selection.mjs /absolute/path/to/puddingteams');
const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-stale-room-selection-');
const env = { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
const reserve = createTcpServer();
await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
const request = async (method, route, body) => {
  const response = await fetch(base + route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: await response.json() };
};
let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30_000 });
  started = true;
  const staleWorker = await request('POST', '/api/rooms', { type: 'direct', members: ['missing-fixture-worker'] });
  assert.equal(staleWorker.status, 400);
  assert.equal(staleWorker.body.code, 'worker_unavailable');
  const staleWorkspace = await request('POST', '/api/rooms', { type: 'direct', members: ['missing-fixture-worker'], workspaceId: 'missing-fixture-workspace' });
  assert.equal(staleWorkspace.status, 400);
  assert.equal(staleWorkspace.body.code, 'workspace_unavailable');
  const rooms = await request('GET', '/api/rooms');
  assert.equal(rooms.status, 200);
  assert.equal(rooms.body.rooms.filter((room) => room.type !== 'solo').length, 0);
  const page = await fetch(base + '/chats');
  assert.equal(page.status, 200);
  console.log(JSON.stringify({ home, cli, staleWorker: staleWorker.body.code, staleWorkspace: staleWorkspace.body.code, nonSoloRooms: 0, chatsPage: page.status }, null, 2));
} finally {
  if (started) await run(cli, ['stop'], { env, timeout: 20_000 }).catch(() => undefined);
}
