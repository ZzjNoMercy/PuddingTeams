import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const cli = process.argv[2];
const mode = process.argv[3];
if (!cli || !path.isAbsolute(cli) || !['after_user', 'after_admission'].includes(mode)) {
  throw new Error('Usage: node scripts/verify-installed-message-admission-crash.mjs /absolute/path/to/puddingteams after_user|after_admission');
}
const run = promisify(execFile);
const home = await mkdtemp(`/private/tmp/puddingteams-message-${mode}-`);
const preload = fileURLToPath(new URL('./fixture-crash-message-admission.cjs', import.meta.url));
const env = { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1', PUDDINGTEAMS_MESSAGE_CRASH_MODE: mode, NODE_OPTIONS: `--require=${preload}` };
const modelSockets = new Set();
let modelRequests = 0;
const model = createHttpServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
  modelRequests += 1;
  for await (const _ of req) { /* hold the model turn until the server is killed */ }
});
model.on('connection', (socket) => { modelSockets.add(socket); socket.on('close', () => modelSockets.delete(socket)); });
await new Promise((resolve, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', resolve); });
const modelPort = model.address().port;
const reserve = createTcpServer();
await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
const request = async (method, route, body, headers = {}) => {
  const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const ok = async (method, route, body, headers) => {
  const result = await request(method, route, body, headers);
  assert.equal(result.status, 200, `${method} ${route}: ${JSON.stringify(result.body)}`);
  return result.body;
};
const key = `ordinary-crash-${mode}-0001`;
const content = `普通消息 ${mode} 中断`;
let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30_000 });
  started = true;
  const catalog = await ok('GET', '/api/providers/custom');
  await ok('PUT', '/api/providers/custom/fixture', { expectedRevision: catalog.revision, name: 'Local Fixture', baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: 'openai-completions', models: [{ id: 'fixture-model' }] });
  await ok('POST', '/api/providers/fixture/key', { apiKey: 'fixture-only' });
  const solo = (await ok('GET', '/api/rooms')).rooms.find((room) => room.type === 'solo');
  assert.ok(solo?.activeSession);
  const sessionId = solo.activeSession;
  await ok('POST', `/api/sessions/${sessionId}/model`, { model: 'fixture/fixture-model' });
  let disconnected = false;
  try { await request('POST', `/api/sessions/${sessionId}/messages`, { content }, { 'idempotency-key': key }); }
  catch { disconnected = true; }
  assert.equal(disconnected, true, 'SIGKILL must break the first HTTP response');
  started = false;
  const markerFile = path.join(home, `ordinary-message-${mode}-killed`);
  const sessionFile = (await readFile(markerFile, 'utf8')).trim();
  assert.ok(sessionFile.endsWith('.jsonl'));
  const before = (await readFile(sessionFile, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const userBefore = before.filter((entry) => entry.type === 'message' && entry.message?.role === 'user' && JSON.stringify(entry.message.content).includes(content));
  const admissionsBefore = before.filter((entry) => entry.type === 'custom_message' && entry.customType === 'pudding:message_admission' && entry.details?.operationId === key);
  assert.equal(userBefore.length, 1);
  assert.equal(admissionsBefore.length, mode === 'after_user' ? 0 : 1);
  const requestsBeforeReplay = modelRequests;

  await run(cli, ['start', '--port', String(port)], { env, timeout: 30_000 });
  started = true;
  const replay = await request('POST', `/api/sessions/${sessionId}/messages`, { content }, { 'idempotency-key': key });
  assert.equal(replay.status, mode === 'after_user' ? 409 : 200, JSON.stringify(replay.body));
  if (mode === 'after_user') assert.equal(replay.body.code, 'message_delivery_unconfirmed');
  else assert.equal(replay.body.accepted, true);
  const after = (await readFile(sessionFile, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(after.filter((entry) => entry.type === 'message' && entry.message?.role === 'user' && JSON.stringify(entry.message.content).includes(content)).length, 1);
  assert.equal(after.filter((entry) => entry.type === 'custom_message' && entry.customType === 'pudding:message_admission' && entry.details?.operationId === key).length, admissionsBefore.length);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(modelRequests, requestsBeforeReplay, 'same-key replay must not call the model again');
  console.log(JSON.stringify({ home, cli, mode, sessionId, firstStatus: 'connection_lost', replayStatus: replay.status, durableUsers: 1, admissions: admissionsBefore.length, modelRequests, duplicateExecutionPrevented: true }, null, 2));
} finally {
  if (started) await run(cli, ['stop'], { env, timeout: 20_000 }).catch(() => undefined);
  for (const socket of modelSockets) socket.destroy();
  await new Promise((resolve) => model.close(resolve));
}
