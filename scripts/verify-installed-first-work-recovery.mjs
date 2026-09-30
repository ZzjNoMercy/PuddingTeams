import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const cli = process.argv[2];
const mode = process.argv[3] ?? 'crash';
if (!cli || !['crash', 'drop', 'corrupt', 'postaccept', 'browser-hold', 'browser-crash-hold'].includes(mode)) throw new Error('Usage: node scripts/verify-installed-first-work-recovery.mjs /absolute/path/to/installed/bin/puddingteams [crash|drop|corrupt|postaccept|browser-hold|browser-crash-hold]');
const preload = fileURLToPath(new URL('./fixture-fail-first-user.cjs', import.meta.url));
const home = await mkdtemp('/private/tmp/puddingteams-m1-unaccepted-');
const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1', ...(mode === 'browser-hold' ? {} : { PUDDINGTEAMS_FIXTURE_USER_WRITE: mode === 'browser-crash-hold' ? 'crash' : mode, NODE_OPTIONS: `--require=${preload}` }) };
let releaseModel = mode !== 'drop';
let modelRequests = 0;
const sockets = new Set();
const mock = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
  modelRequests++;
  for await (const _ of req) { /* drain */ }
  if (!releaseModel) return;
  const chunk = (delta, finishReason = null) => JSON.stringify({ id: `fixture-${modelRequests}`, object: 'chat.completion.chunk', created: 1780000000, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finishReason }] });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${chunk({ role: 'assistant', content: 'retry accepted' })}\n\n`);
  res.write(`data: ${chunk({}, 'stop')}\n\n`);
  res.end('data: [DONE]\n\n');
});
mock.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve); });
const modelPort = mock.address().port;
const reserve = createTcpServer();
await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
const request = async (route, options = {}) => { const response = await fetch(base + route, { signal: AbortSignal.timeout(15000), ...options }); return { status: response.status, body: await response.json() }; };
const post = (route, body, headers = {}) => request(route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const catalog = await request('/api/providers/custom');
  assert.equal(catalog.status, 200);
  const provider = await request('/api/providers/custom/fixture', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: catalog.body.revision, name: 'Local Fixture', baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: 'openai-completions', models: [{ id: 'fixture-model' }] }) });
  assert.equal(provider.status, 200, JSON.stringify(provider.body));
  const key = await post('/api/providers/fixture/key', { apiKey: 'fixture-only' });
  assert.equal(key.status, 200, JSON.stringify(key.body));
  const rooms = await request('/api/rooms');
  const manager = rooms.body.rooms.find((room) => room.type === 'solo');
  assert.ok(manager);
  const operationKey = 'installed-unaccepted-firstwork-0001';
  const payload = { content: '冻结后未持久接纳的首发', modelRef: 'fixture/fixture-model', attachments: [{ filename: 'draft.txt', data: Buffer.from('attachment bytes').toString('base64') }], workspaceId: manager.workspace?.id ?? null, cwdSnapshot: manager.cwdSnapshot };
  const send = () => post(`/api/rooms/${manager.id}/new-work`, payload, { 'idempotency-key': operationKey });
  if (mode === 'browser-crash-hold') {
    console.log(JSON.stringify({ home, base, modelPort, managerRoomId: manager.id, mode, stage: 'ready_for_browser' }, null, 2));
    const marker = path.join(home, 'first-user-write-injected');
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline && !(await readFile(marker).catch(() => null))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(await readFile(marker).catch(() => null), 'browser did not reach injected first user write');
    started = false;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
    started = true;
    console.log(JSON.stringify({ home, base, mode, stage: 'restarted_after_first_write_crash' }, null, 2));
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 10 * 60 * 1000);
      process.once('SIGINT', () => { clearTimeout(timer); resolve(); });
    });
  } else if (mode === 'browser-hold') {
    console.log(JSON.stringify({ home, base, modelPort, managerRoomId: manager.id, mode }, null, 2));
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 15 * 60 * 1000);
      process.once('SIGINT', () => { clearTimeout(timer); resolve(); });
    });
  } else if (mode === 'postaccept') {
    const accepted = await send();
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    const sessionId = accepted.body.sessionId;
    let assistantSeen = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const history = await request(`/api/sessions/${sessionId}/messages`);
      assistantSeen = history.body.messages?.some((message) => message.role === 'assistant') ?? false;
      if (assistantSeen) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(assistantSeen, true);
    const listed = await request('/api/sessions');
    const file = listed.body.sessions.find((item) => item.id === sessionId)?.sessionFile;
    assert.ok(file);
    const entries = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(entries.filter((entry) => entry.type === 'message' && entry.message?.role === 'user').length, 1);
    await writeFile(file, `${entries.filter((entry) => !(entry.type === 'message' && entry.message?.role === 'user')).map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    const replay = await send();
    assert.equal(replay.status, 400, JSON.stringify(replay.body));
    assert.match(replay.body.error, /首次发送尚未写入会话记录/);
    assert.equal(replay.body.sessionId, sessionId);
    assert.equal((await readdir(path.join(home, 'uploads', sessionId))).length, 1);
    console.log(JSON.stringify({ home, sessionId, mode, firstStatus: accepted.status, replayStatus: replay.status, durableUsersAfterFault: 0, frozenUploads: 1 }, null, 2));
  } else if (mode === 'corrupt') {
    const first = await send();
    assert.equal(first.status, 400, JSON.stringify(first.body));
    assert.match(first.body.error, /首次发送尚未写入会话记录/);
    const replay = await send();
    assert.equal(replay.status, 409, JSON.stringify(replay.body));
    assert.equal(replay.body.code, 'first_message_conflict');
    assert.equal(replay.body.sessionId, first.body.sessionId);
    const files = (await readdir(path.join(home, 'sessions'))).filter((name) => name.includes(first.body.sessionId));
    assert.equal(files.length, 1);
    const entries = (await readFile(path.join(home, 'sessions', files[0]), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const users = entries.filter((entry) => entry.type === 'message' && entry.message?.role === 'user');
    assert.equal(users.length, 1);
    assert.match(JSON.stringify(users[0].message.content), /fixture: another user intent/);
    assert.equal((await readdir(path.join(home, 'uploads', first.body.sessionId))).length, 1);
    console.log(JSON.stringify({ home, sessionId: first.body.sessionId, mode, firstStatus: first.status, replayStatus: replay.status, durableUsers: users.length, frozenUploads: 1 }, null, 2));
  } else {
  let firstStatus;
  let liveRetryStatus = null;
  let sessionId;
  if (mode === 'crash') {
    let disconnected = false;
    try { await send(); }
    catch { disconnected = true; }
    assert.equal(disconnected, true, 'first request should lose the connection when its isolated server is killed');
    firstStatus = 'connection_lost';
    started = false;
  } else {
    const first = await send();
    assert.equal(first.status, 400, JSON.stringify(first.body));
    assert.match(first.body.error, /首次发送尚未写入会话记录/);
    sessionId = first.body.sessionId;
    firstStatus = first.status;
  }
  assert.equal((await readFile(path.join(home, 'first-user-write-injected'), 'utf8')).endsWith('.jsonl'), true);
  const uploadIds = await readdir(path.join(home, 'uploads'));
  assert.equal(uploadIds.length, 1);
  sessionId ??= uploadIds[0];
  assert.equal(sessionId, uploadIds[0]);
  const uploadDir = path.join(home, 'uploads', sessionId);
  const abandoned = await readdir(uploadDir);
  assert.equal(abandoned.length, 1);
  const sessionFiles = (await readdir(path.join(home, 'sessions'))).filter((name) => name.includes(sessionId));
  assert.equal(sessionFiles.length, 1);
  const before = (await readFile(path.join(home, 'sessions', sessionFiles[0]), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(before.filter((entry) => entry.type === 'message').length, 0);
  if (mode === 'drop') {
    const inFlight = await send();
    assert.equal(inFlight.status, 400, JSON.stringify(inFlight.body));
    assert.match(inFlight.body.error, /首次发送(仍在处理|尚未写入会话记录)/);
    liveRetryStatus = inFlight.status;
    assert.deepEqual(await readdir(uploadDir), abandoned);
    const pidState = JSON.parse(await readFile(path.join(home, 'run', 'server.pid'), 'utf8'));
    process.kill(pidState.pid, 'SIGKILL');
    started = false;
    releaseModel = true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const replay = await send();
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.sessionId, sessionId);
  const retained = await readdir(uploadDir);
  assert.equal(retained.length, 1);
  assert.notEqual(retained[0], abandoned[0]);
  const sessionList = await request('/api/sessions');
  const session = sessionList.body.sessions.find((item) => item.id === sessionId);
  assert.ok(session?.sessionFile);
  const entries = (await readFile(session.sessionFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const users = entries.filter((entry) => entry.type === 'message' && entry.message?.role === 'user');
  assert.equal(users.length, 1);
  console.log(JSON.stringify({ home, sessionId, mode, firstStatus, liveRetryStatus, replayStatus: replay.status, uploadsAfterFirst: abandoned.length, uploadsAfterReplay: retained.length, abandonedRemoved: true, durableUsers: users.length, modelRequests, injectedCrash: true }, null, 2));
  }
} finally {
  if (started) await run(cli, ['stop'], { env, timeout: 30000 }).catch(() => undefined);
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => mock.close(resolve));
}
