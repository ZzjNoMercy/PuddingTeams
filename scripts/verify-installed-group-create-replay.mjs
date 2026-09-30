import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli)) throw new Error('Usage: node scripts/verify-installed-group-create-replay.mjs /absolute/path/to/puddingteams');
const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-group-create-');
const env = { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
const reserve = createServer();
await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
const key = randomUUID();
const payload = { type: 'group', members: ['pi-b', 'puddingclaw'], name: '响应丢失回放' };
const request = async (method, route, body, operationId) => {
  const response = await fetch(base + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(operationId ? { 'idempotency-key': operationId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const rooms = async () => {
  const result = await request('GET', '/api/rooms');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.rooms.filter((room) => room.type === 'group' && room.name === payload.name);
};
let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30_000 });
  started = true;
  const missing = await request('POST', '/api/rooms', payload);
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'room_operation_invalid');
  // The caller deliberately discards the successful response, then cold-starts.
  const ignored = await fetch(base + '/api/rooms', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
  });
  assert.equal(ignored.status, 200);
  await ignored.arrayBuffer();
  assert.equal((await rooms()).length, 1);
  await run(cli, ['stop'], { env, timeout: 20_000 });
  started = false;
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30_000 });
  started = true;
  const replay = await request('POST', '/api/rooms', { ...payload, members: [...payload.members].reverse() }, key);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.existed, true);
  const [group] = await rooms();
  assert.equal(group.id, replay.body.room.id);
  assert.equal(group.sessions.length, 1);
  const conflict = await request('POST', '/api/rooms', { ...payload, name: '另一个意图' }, key);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, 'room_operation_conflict');
  const removed = await request('DELETE', `/api/rooms/${group.id}`);
  assert.equal(removed.status, 204);
  const gone = await request('POST', '/api/rooms', payload, key);
  assert.equal(gone.status, 409);
  assert.equal(gone.body.code, 'room_operation_gone');
  assert.equal((await rooms()).length, 0);
  const workspaceA = await request('POST', '/api/workspaces', { managed: true, name: '项目 A' });
  const workspaceB = await request('POST', '/api/workspaces', { managed: true, name: '项目 B' });
  assert.equal(workspaceA.status, 200);
  assert.equal(workspaceB.status, 200);
  const source = await request('POST', '/api/rooms', { ...payload, name: '跨项目源群聊', workspaceId: workspaceA.body.workspace.id }, randomUUID());
  assert.equal(source.status, 200, JSON.stringify(source.body));
  const switchUrl = `/api/rooms/${source.body.room.id}/switch-workspace`;
  const sourceRoom = source.body.room;
  const switchBody = { workspaceId: workspaceB.body.workspace.id, mode: 'new_window', source: {
    type: sourceRoom.type, name: sourceRoom.name, members: sourceRoom.members.map((member) => member.name),
    prompt: sourceRoom.prompt, workspaceId: sourceRoom.workspace?.id ?? null, cwdSnapshot: sourceRoom.cwdSnapshot,
  } };
  const switchKey = randomUUID();
  const missingSwitchKey = await request('POST', switchUrl, switchBody);
  assert.equal(missingSwitchKey.status, 400);
  assert.equal(missingSwitchKey.body.code, 'room_operation_invalid');
  const switched = await request('POST', switchUrl, switchBody, switchKey);
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  await run(cli, ['stop'], { env, timeout: 20_000 });
  started = false;
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30_000 });
  started = true;
  const switchReplay = await request('POST', switchUrl, switchBody, switchKey);
  assert.equal(switchReplay.status, 200, JSON.stringify(switchReplay.body));
  assert.equal(switchReplay.body.existed, true);
  assert.equal(switchReplay.body.room.id, switched.body.room.id);
  assert.equal(switchReplay.body.room.activeSession, switched.body.room.activeSession);
  assert.equal(switchReplay.body.room.sessions.length, 1);
  const switchConflict = await request('POST', switchUrl, { workspaceId: null, mode: 'new_window' }, switchKey);
  assert.equal(switchConflict.status, 409);
  assert.equal(switchConflict.body.code, 'room_operation_conflict');
  const renamedSource = await request('PATCH', switchUrl.replace('/switch-workspace', ''), { name: '来源已更新' });
  assert.equal(renamedSource.status, 200, JSON.stringify(renamedSource.body));
  const staleSource = await request('POST', switchUrl, switchBody, randomUUID());
  assert.equal(staleSource.status, 409);
  assert.equal(staleSource.body.code, 'room_source_changed');
  const deletedSource = await request('DELETE', switchUrl.replace('/switch-workspace', ''));
  assert.equal(deletedSource.status, 204);
  const missingSource = await request('POST', switchUrl, switchBody, randomUUID());
  assert.equal(missingSource.status, 404);
  assert.equal(missingSource.body.code, 'room_source_unavailable');
  const replayAfterSourceGone = await request('POST', switchUrl, switchBody, switchKey);
  assert.equal(replayAfterSourceGone.status, 200, JSON.stringify(replayAfterSourceGone.body));
  assert.equal(replayAfterSourceGone.body.room.id, switched.body.room.id);
  console.log(JSON.stringify({ home, roomId: group.id, sessionId: group.activeSession, replay: replay.body.existed, conflict: conflict.body.code, deletedReplay: gone.body.code, switchRoomId: switched.body.room.id, switchReplay: switchReplay.body.existed, switchConflict: switchConflict.body.code, staleSource: staleSource.body.code, missingSource: missingSource.body.code, replayAfterSourceGone: replayAfterSourceGone.body.existed }, null, 2));
} finally {
  if (started) await run(cli, ['stop'], { env, timeout: 20_000 }).catch(() => undefined);
}
