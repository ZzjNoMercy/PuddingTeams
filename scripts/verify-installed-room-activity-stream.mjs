import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const cli = process.argv[2];
const mode = process.argv[3] ?? 'verify';
if (!cli || !path.isAbsolute(cli) || !['verify', 'browser-hold'].includes(mode)) throw new Error('Usage: node scripts/verify-installed-room-activity-stream.mjs /absolute/path/to/puddingteams [verify|browser-hold]');
const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-activity-stream-');
const env = { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
const sockets = new Set();
const track = (server) => server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
const listen = async (server) => { track(server); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return server.address().port; };
const close = async (server) => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); };
const pending = [];
let modelCalls = 0;
const model = createServer(async (req, res) => {
  if (mode === 'browser-hold' && req.method === 'GET' && req.url === '/__fixture/pending') {
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(pending.map((item) => item.prompt)));
  }
  if (mode === 'browser-hold' && req.method === 'POST' && req.url === '/__fixture/release') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const contains = JSON.parse(Buffer.concat(chunks).toString()).contains;
    const index = pending.findIndex((item) => typeof contains === 'string' && item.prompt.includes(contains));
    if (index < 0) return void res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'pending response not found' }));
    pending.splice(index, 1)[0].release();
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ released: true }));
  }
  if (req.method === 'GET' && req.url === '/v1/models') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] }));
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const prompt = JSON.stringify(JSON.parse(Buffer.concat(chunks).toString()).messages ?? []);
  const id = `fixture-${++modelCalls}`;
  const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1780000000, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send({ role: 'assistant', content: '流式片段' });
  pending.push({ prompt, release: () => { send({ content: '最终回答' }); send({}, 'stop'); res.end('data: [DONE]\n\n'); } });
});
const modelPort = await listen(model);
const reserve = createTcpServer();
const port = await listen(reserve);
await close(reserve);
const base = `http://127.0.0.1:${port}`;
const request = async (method, route, body) => {
  const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(route.endsWith('/messages') || (route === '/api/rooms' && body?.type === 'group') ? { 'idempotency-key': randomUUID() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const ok = async (method, route, body) => { const result = await request(method, route, body); assert.equal(result.status, 200, `${method} ${route}: ${JSON.stringify(result.body)}`); return result.body; };
const waitFor = async (fn, label) => { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`timeout waiting for ${label}; modelCalls=${modelCalls}, pending=${pending.length}`); };
const rooms = async () => (await ok('GET', '/api/rooms')).rooms;
const roomOf = (list, id) => { const room = list.find((item) => item.id === id); assert.ok(room); return room; };
const finish = (text) => { const index = pending.findIndex((item) => item.prompt.includes(text)); assert.ok(index >= 0, `model response for ${text} must be pending`); pending.splice(index, 1)[0].release(); };
let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30_000 });
  started = true;
  const catalog = await ok('GET', '/api/providers/custom');
  await ok('PUT', '/api/providers/custom/fixture', { expectedRevision: catalog.revision, name: 'Fixture', baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: 'openai-completions', models: [{ id: 'fixture-model' }] });
  await ok('POST', '/api/providers/fixture/key', { apiKey: 'fixture-only' });
  // Direct 消息由 Agent Connector 运行，不读取房间 Session 的模型设置。
  // 浏览器验收会从 direct 房间发消息，先把 worker 真正绑定到本机模型。
  const agents = (await ok('GET', '/api/agents')).agents;
  const worker = agents.find((agent) => agent.name === 'pi-b');
  assert.ok(worker);
  await ok('PUT', '/api/agents/pi-b/connector', { ...worker.connector, config: { ...worker.connector.config, model: 'fixture/fixture-model' }, expectedRevision: worker.extensionRevision });
  const configuredWorker = (await ok('GET', '/api/agents')).agents.find((agent) => agent.name === 'pi-b');
  assert.equal(configuredWorker?.connector?.config?.model, 'fixture/fixture-model');
  const direct = (await ok('POST', '/api/rooms', { type: 'group', members: ['pi-b', 'puddingclaw'], name: '活动测试群 A' })).room;
  const group = (await ok('POST', '/api/rooms', { type: 'group', members: ['pi-b', 'puddingclaw'], name: '活动测试群 B' })).room;
  await ok('POST', `/api/sessions/${direct.activeSession}/model`, { model: 'fixture/fixture-model' });
  await ok('POST', `/api/sessions/${group.activeSession}/model`, { model: 'fixture/fixture-model' });
  const sendDirect = ok('POST', `/api/sessions/${direct.activeSession}/messages`, { content: '群聊 A 第一条业务消息' });
  await sendDirect;
  await waitFor(() => pending.some((item) => item.prompt.includes('群聊 A 第一条业务消息')), 'first room model stream');
  const first = await rooms();
  const directFirst = roomOf(first, direct.id);
  assert.equal(directFirst.lastMessagePreview, '群聊 A 第一条业务消息');
  assert.equal(directFirst.activityRevision, 1);
  assert.ok(directFirst.lastActivityAt);
  assert.equal(directFirst.activitySessionId, direct.activeSession);
  const directRevision = directFirst.activityRevision;
  const newer = (await ok('POST', `/api/rooms/${direct.id}/sessions`, {})).session;
  assert.notEqual(newer.id, direct.activeSession);
  assert.equal(roomOf(await rooms(), direct.id).activeSession, newer.id);
  finish('群聊 A 第一条业务消息');
  await waitFor(async () => roomOf(await rooms(), direct.id).activityRevision > directRevision, 'direct assistant completion');
  const completedDirect = roomOf(await rooms(), direct.id);
  assert.equal(completedDirect.activeSession, newer.id);
  assert.equal(completedDirect.activitySessionId, direct.activeSession, '后台完成必须定位旧 Session');
  const oldHistory = (await ok('GET', `/api/sessions/${direct.activeSession}/messages`)).messages;
  const newHistory = (await ok('GET', `/api/sessions/${newer.id}/messages`)).messages;
  assert.ok(oldHistory.some((message) => message.role === 'assistant' && JSON.stringify(message.content).includes('最终回答')));
  assert.equal(newHistory.some((message) => message.role === 'assistant'), false);
  await ok('PUT', `/api/rooms/${direct.id}/read-watermark`, { sessionId: direct.activeSession, activityRevision: completedDirect.activityRevision });
  const sendGroup = ok('POST', `/api/sessions/${group.activeSession}/messages`, { content: '群聊 B 新业务消息' });
  await sendGroup;
  await waitFor(() => pending.some((item) => item.prompt.includes('群聊 B 新业务消息')), 'second room model stream');
  const beforeToken = await rooms();
  const groupStreaming = roomOf(beforeToken, group.id);
  assert.equal(groupStreaming.lastMessagePreview, '群聊 B 新业务消息');
  assert.equal(groupStreaming.activityRevision, 1, 'stream token must not advance durable activity');
  assert.equal(beforeToken.filter((item) => item.type !== 'solo')[0]?.id, group.id);
  await ok('PATCH', `/api/rooms/${direct.id}`, { name: '群聊 A 改名' });
  const afterMetadata = await rooms();
  assert.equal(roomOf(afterMetadata, direct.id).lastActivityAt, completedDirect.lastActivityAt);
  assert.equal(roomOf(afterMetadata, group.id).activityRevision, groupStreaming.activityRevision);
  assert.equal(afterMetadata.filter((item) => item.type !== 'solo')[0]?.id, group.id);
  await ok('PUT', `/api/rooms/${group.id}/read-watermark`, { sessionId: group.activeSession, activityRevision: groupStreaming.activityRevision });
  const afterRead = await rooms();
  assert.equal(roomOf(afterRead, group.id).activityRevision, groupStreaming.activityRevision);
  assert.equal(afterRead.filter((item) => item.type !== 'solo')[0]?.id, group.id);
  finish('群聊 B 新业务消息');
  await waitFor(async () => roomOf(await rooms(), group.id).activityRevision > groupStreaming.activityRevision, 'group assistant completion');
  const groupDone = roomOf(await rooms(), group.id);
  assert.ok(groupDone.lastMessagePreview.includes('最终回答'));
  assert.equal(groupDone.activityRevision, 2);
  assert.equal((await rooms()).filter((item) => item.type !== 'solo')[0]?.id, group.id);
  const beforeRestart = await rooms();
  const durableFields = (room) => ({
    lastActivityAt: room.lastActivityAt,
    lastMessagePreview: room.lastMessagePreview,
    activitySessionId: room.activitySessionId,
    activityRevision: room.activityRevision,
    readRevision: room.readRevision,
    hasUnreadActivity: room.hasUnreadActivity,
    unreadSessionId: room.unreadSessionId,
  });
  await run(cli, ['stop'], { env, timeout: 20_000 });
  started = false;
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30_000 });
  started = true;
  for (const roomId of [direct.id, group.id]) {
    const expected = durableFields(roomOf(beforeRestart, roomId));
    for (let replay = 0; replay < 3; replay++) {
      assert.deepEqual(durableFields(roomOf(await rooms(), roomId)), expected,
        `cold restart and repeated JSONL projection must preserve room ${roomId}`);
    }
  }
  assert.equal((await rooms()).filter((item) => item.type !== 'solo')[0]?.id, group.id,
    'cold restart must preserve the business-activity order');
  let crossProject;
  if (mode === 'verify') {
    const workerRoom = (await ok('POST', '/api/rooms', { type: 'direct', members: ['pi-b'] })).room;
    await ok('POST', `/api/sessions/${workerRoom.activeSession}/messages`, { content: '本机 Worker 模型路由验证' });
    await waitFor(() => pending.some((item) => item.prompt.includes('本机 Worker 模型路由验证')), 'direct Worker local model stream');
    finish('本机 Worker 模型路由验证');
  }
  if (mode === 'browser-hold') {
    const workspaceA = (await ok('POST', '/api/workspaces', { managed: true, name: '验收项目 A' })).workspace;
    const workspaceB = (await ok('POST', '/api/workspaces', { managed: true, name: '验收项目 B' })).workspace;
    const roomA = (await ok('POST', '/api/rooms', { type: 'direct', members: ['pi-b'], workspaceId: workspaceA.id })).room;
    const roomB = (await ok('POST', '/api/rooms', { type: 'direct', members: ['pi-b'], workspaceId: workspaceB.id })).room;
    await ok('POST', `/api/sessions/${roomA.activeSession}/model`, { model: 'fixture/fixture-model' });
    await ok('POST', `/api/sessions/${roomB.activeSession}/model`, { model: 'fixture/fixture-model' });
    const listed = await rooms();
    assert.notEqual(roomA.id, roomB.id);
    assert.equal(roomOf(listed, roomA.id).workspace.name, workspaceA.name);
    assert.equal(roomOf(listed, roomB.id).workspace.name, workspaceB.name);
    crossProject = { workspaceA: workspaceA.id, workspaceB: workspaceB.id, roomA: roomA.id, roomB: roomB.id };
  }
  console.log(JSON.stringify({ home, base, modelControlUrl: mode === 'browser-hold' ? `http://127.0.0.1:${modelPort}/__fixture` : undefined, cli, mode, firstGroup: direct.id, secondGroup: group.id, firstActivitySession: completedDirect.activitySessionId, firstActiveSession: completedDirect.activeSession, firstUserRevision: directRevision, firstFinalRevision: completedDirect.activityRevision, secondUserRevision: groupStreaming.activityRevision, secondFinalRevision: groupDone.activityRevision, modelCalls, stableDuringRenameAndRead: true, stableAfterColdRestartAndReplay: true, crossProject }, null, 2));
  if (mode === 'browser-hold') {
    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
      setTimeout(resolve, 15 * 60_000).unref();
    });
  }
} finally {
  while (pending.length) pending.shift().release();
  if (started) await run(cli, ['stop'], { env, timeout: 20_000 }).catch(() => {});
  await close(model);
}
