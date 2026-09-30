import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli)) throw new Error('Usage: node scripts/verify-installed-direct-background-activity.mjs /absolute/path/to/puddingteams');
const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-direct-activity-');
const env = { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
const worker = path.join(home, 'worker.sh');
await writeFile(worker, `#!/bin/sh
if [ "$2" != run ]; then exit 2; fi
/bin/cat >/dev/null
printf 'started\\n' > '${home}/worker-started'
until [ -f '${home}/release-worker' ]; do /bin/sleep 0.1; done
printf '%s\\n' '{"status":"completed","run_id":"fixture-direct-run","session_id":"fixture-worker-session","final_response":"后台 Worker 已完成"}'
`);
await chmod(worker, 0o700);
const reserve = createServer();
await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
const request = async (method, route, body) => {
  const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(route.endsWith('/messages') || (route === '/api/rooms' && body?.type === 'group') ? { 'idempotency-key': randomUUID() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const ok = async (method, route, body) => { const result = await request(method, route, body); assert.equal(result.status, 200, `${method} ${route}: ${JSON.stringify(result.body)}`); return result.body; };
const waitFor = async (fn, label) => { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`timeout waiting for ${label}`); };
const rooms = async () => (await ok('GET', '/api/rooms')).rooms;
const roomOf = (list, id) => { const room = list.find((item) => item.id === id); assert.ok(room); return room; };
const connectSession = async (sessionId) => {
  const frames = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}/ws`);
  socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  await waitFor(() => frames.some((event) => event.type === 'session_ready' && event.sessionId === sessionId), `WS ready ${sessionId}`);
  return { socket, frames };
};
const closeSession = async ({ socket }) => {
  if (socket.readyState === WebSocket.OPEN) await new Promise((resolve) => { socket.onclose = resolve; socket.close(); });
};
let started = false;
let live;
let gap;
let reconnected;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30_000 });
  started = true;
  const agent = (await ok('GET', '/api/agents')).agents.find((item) => item.name === 'puddingclaw');
  assert.ok(agent);
  await ok('PUT', '/api/agents/puddingclaw/connector', { extensionId: 'puddingclaw', connectorId: 'puddingclaw', transport: 'spawn', config: { command: worker }, expectedRevision: agent.extensionRevision });
  const direct = (await ok('POST', '/api/rooms', { type: 'direct', members: ['puddingclaw'] })).room;
  const idleGroup = (await ok('POST', '/api/rooms', { type: 'group', members: ['pi-b', 'puddingclaw'], name: '空群聊' })).room;
  const originalSession = direct.activeSession;
  live = await connectSession(originalSession);
  gap = await connectSession(originalSession);
  await ok('POST', `/api/sessions/${originalSession}/messages`, { content: '请让 Worker 在后台完成' });
  await waitFor(() => live.frames.some((event) => event.type === 'message_start' && event.message?.customType === 'pudding:task_assign'), 'WS task assignment');
  await waitFor(() => gap.frames.some((event) => event.type === 'message_start' && event.message?.customType === 'pudding:task_assign'), 'second WS task assignment');
  await closeSession(gap);
  gap = undefined;
  await waitFor(async () => (await readFile(path.join(home, 'worker-started'), 'utf8').catch(() => '')) === 'started\n', 'worker started');
  const before = roomOf(await rooms(), direct.id);
  assert.equal(before.activitySessionId, originalSession);
  const firstRead = await ok('PUT', `/api/rooms/${direct.id}/read-watermark`, { sessionId: originalSession, activityRevision: before.activityRevision });
  assert.equal(firstRead.hasUnreadActivity, false);
  assert.equal(roomOf(await rooms(), direct.id).hasUnreadActivity, false);
  const next = (await ok('POST', `/api/rooms/${direct.id}/sessions`, {})).session;
  assert.notEqual(next.id, originalSession);
  assert.equal(roomOf(await rooms(), direct.id).activeSession, next.id);
  await writeFile(path.join(home, 'release-worker'), 'go\n');
  const liveResult = await waitFor(() => live.frames.find((event) => event.type === 'message_start' && event.message?.customType === 'pudding:task_result'), 'WS task result');
  const completed = await waitFor(async () => {
    const room = roomOf(await rooms(), direct.id);
    return room.activityRevision > before.activityRevision ? room : undefined;
  }, 'direct Worker result activity');
  assert.equal(completed.activeSession, next.id);
  assert.equal(completed.activitySessionId, originalSession);
  assert.equal(completed.hasUnreadActivity, true);
  assert.ok(completed.lastMessagePreview.includes('后台 Worker 已完成'));
  const staleRead = await ok('PUT', `/api/rooms/${direct.id}/read-watermark`, { sessionId: originalSession, activityRevision: before.activityRevision });
  assert.equal(staleRead.hasUnreadActivity, true);
  const wrongSessionRead = await ok('PUT', `/api/rooms/${direct.id}/read-watermark`, { sessionId: next.id, activityRevision: completed.activityRevision });
  assert.equal(wrongSessionRead.hasUnreadActivity, true);
  assert.equal(roomOf(await rooms(), direct.id).activitySessionId, originalSession);
  assert.equal((await rooms()).filter((item) => item.type !== 'solo')[0]?.id, direct.id);
  const oldHistory = (await ok('GET', `/api/sessions/${originalSession}/messages`)).messages;
  const newHistory = (await ok('GET', `/api/sessions/${next.id}/messages`)).messages;
  const historyResult = oldHistory.find((message) => message.customType === 'pudding:task_result' && message.content?.includes('后台 Worker 已完成'));
  assert.ok(historyResult);
  assert.ok(historyResult.puddingMessageId);
  assert.equal(liveResult.message.puddingMessageId, historyResult.puddingMessageId);
  assert.equal(newHistory.some((message) => message.customType === 'pudding:task_result'), false);
  reconnected = await connectSession(originalSession);
  const recoveredHistory = (await ok('GET', `/api/sessions/${originalSession}/messages`)).messages;
  assert.equal(recoveredHistory.find((message) => message.customType === 'pudding:task_result')?.puddingMessageId, historyResult.puddingMessageId);
  assert.equal(reconnected.frames.some((event) => event.type === 'message_start' && event.message?.customType === 'pudding:task_result'), false);
  await closeSession(reconnected);
  reconnected = undefined;
  await closeSession(live);
  live = undefined;
  await run(cli, ['stop'], { env, timeout: 20_000 });
  started = false;
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30_000 });
  started = true;
  const cold = roomOf(await rooms(), direct.id);
  assert.equal(cold.activityRevision, completed.activityRevision);
  assert.equal(cold.activitySessionId, originalSession);
  assert.equal(cold.activeSession, next.id);
  assert.equal(cold.hasUnreadActivity, true);
  const finalRead = await ok('PUT', `/api/rooms/${direct.id}/read-watermark`, { sessionId: originalSession, activityRevision: completed.activityRevision });
  assert.equal(finalRead.hasUnreadActivity, false);
  assert.equal(roomOf(await rooms(), direct.id).hasUnreadActivity, false);
  assert.equal((await rooms()).filter((item) => item.type !== 'solo')[0]?.id, direct.id);
  console.log(JSON.stringify({ home, cli, directRoom: direct.id, idleGroup: idleGroup.id, activitySession: completed.activitySessionId, activeSession: completed.activeSession, beforeRevision: before.activityRevision, finalRevision: completed.activityRevision, workerResultOnlyInOriginalSession: true, wsHttpMessageIdAligned: true, reconnectHistoryRecovered: true, staleReadPreservesNewUnread: true, wrongSessionReadPreservesOldUnread: true, coldRestartStable: true }, null, 2));
} finally {
  if (live) await closeSession(live).catch(() => {});
  if (gap) await closeSession(gap).catch(() => {});
  if (reconnected) await closeSession(reconnected).catch(() => {});
  await writeFile(path.join(home, 'release-worker'), 'go\n').catch(() => {});
  if (started) await run(cli, ['stop'], { env, timeout: 20_000 }).catch(() => {});
}
