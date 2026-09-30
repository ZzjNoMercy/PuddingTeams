import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const cli = process.argv[2];
const mode = process.argv[3] ?? 'after-tool';
if (!cli || !path.isAbsolute(cli) || !['after-tool', 'during-tool'].includes(mode)) throw new Error('Usage: node scripts/verify-installed-interrupted-tool-turn.mjs /absolute/path/to/puddingteams [after-tool|during-tool]');
const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-interrupted-tool-');
const env = { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
const sockets = new Set();
const content = '请读取项目 README，随后总结';
const key = 'tool-turn-crash-0001';
const readPath = mode === 'during-tool' ? path.join(home, 'blocked-read.fifo') : path.resolve(import.meta.dirname, '../README.md');
if (mode === 'during-tool') await run('/usr/bin/mkfifo', [readPath]);
let phase = 'initial';
let toolRequests = 0;
let continuationRequests = 0;
let modelRequests = 0;
let readToolAvailable = false;
const model = createHttpServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  modelRequests += 1;
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const names = (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
  const isTitle = JSON.stringify(body).includes('请为下面这段对话');
  const hasToolResult = (body.messages ?? []).some((message) => message.role === 'tool');
  const id = `fixture-${modelRequests}`;
  const send = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1780000000, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
  if (!isTitle && !hasToolResult) {
    readToolAvailable = names.includes('read');
    assert.ok(readToolAvailable, 'Manager must expose the read-only tool');
    toolRequests += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-read-fixture', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: readPath }) } }] });
    send({}, 'tool_calls');
    res.end('data: [DONE]\n\n');
    return;
  }
  if (!isTitle && hasToolResult) {
    continuationRequests += 1;
    return; // Hold the final reply until the real server is killed.
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send({ role: 'assistant', content: 'fixture title' });
  send({}, 'stop');
  res.end('data: [DONE]\n\n');
});
model.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
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
const ok = async (method, route, body, headers) => { const result = await request(method, route, body, headers); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
const waitFor = async (fn, label) => { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`timeout waiting for ${label}`); };
let started = false;
let ws;
const frames = [];
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
  if (mode === 'during-tool') {
    ws = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}/ws`);
    ws.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
    await waitFor(() => frames.some((frame) => frame.type === 'session_ready'), 'WebSocket subscription');
  }
  await ok('POST', `/api/sessions/${sessionId}/messages`, { content }, { 'idempotency-key': key });
  const live = await waitFor(async () => {
    const history = await ok('GET', `/api/sessions/${sessionId}/messages`);
    const toolUse = history.messages.some((message) => message.role === 'assistant' && message.stopReason === 'toolUse');
    return mode === 'during-tool'
      ? toolUse && frames.some((frame) => frame.type === 'tool_execution_start' && frame.toolCallId === 'call-read-fixture') ? history : undefined
      : continuationRequests > 0 && toolUse && history.messages.some((message) => message.role === 'toolResult') ? history : undefined;
  }, mode === 'during-tool' ? 'durable tool call and live tool execution' : 'durable tool call, tool result and second model request');
  assert.equal(live.running, true);
  if (mode === 'during-tool') {
    assert.equal(live.messages.some((message) => message.role === 'toolResult'), false);
    assert.equal(continuationRequests, 0);
  }
  const pid = JSON.parse(await readFile(path.join(home, 'run', 'server.pid'), 'utf8')).pid;
  process.kill(pid, 'SIGKILL');
  started = false;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const requestsBeforeRestart = modelRequests;
  phase = 'restart';
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30_000 });
  started = true;
  phase = 'cold_read';
  const cold = await ok('GET', `/api/sessions/${sessionId}/messages`);
  phase = 'replay';
  const replay = await ok('POST', `/api/sessions/${sessionId}/messages`, { content }, { 'idempotency-key': key });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(cold.running, false);
  assert.deepEqual(cold.runningToolCallIds, [], 'cold restart must not claim the killed local tool is still running');
  assert.equal(cold.unansweredUserMessage, false);
  assert.equal(cold.unfinishedAssistantTurn, true);
  assert.equal(cold.messages.filter((message) => message.role === 'user' && JSON.stringify(message.content).includes(content)).length, 1);
  assert.equal(cold.messages.filter((message) => message.role === 'assistant' && message.stopReason === 'toolUse').length, 1);
  const results = cold.messages.filter((message) => message.role === 'toolResult');
  assert.equal(results.length, mode === 'during-tool' ? 0 : 1);
  if (mode === 'after-tool') {
    assert.equal(results[0].toolCallId, 'call-read-fixture');
    assert.equal(results[0].isError, false);
    assert.match(JSON.stringify(results[0].content), /PuddingTeams/);
  }
  const sessionFiles = (await readdir(path.join(home, 'sessions'))).filter((name) => name.endsWith('.jsonl'));
  assert.equal(sessionFiles.length, 1);
  const entries = (await readFile(path.join(home, 'sessions', sessionFiles[0]), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(entries.filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant' && entry.message.stopReason === 'toolUse').length, 1);
  assert.equal(entries.filter((entry) => entry.type === 'message' && entry.message?.role === 'toolResult').length, mode === 'during-tool' ? 0 : 1);
  assert.equal(replay.accepted, true);
  assert.equal(toolRequests, 1, 'same-key replay must not request a second tool call');
  assert.equal(modelRequests, requestsBeforeRestart, 'cold read and same-key replay must not request the model');
  console.log(JSON.stringify({ home, cli, mode, sessionId, readToolAvailable, toolRequests, continuationRequests, modelRequests, requestsBeforeRestart, liveRunning: live.running, coldRunning: cold.running, coldUnfinishedAssistantTurn: cold.unfinishedAssistantTurn, coldToolResults: results.length, replayAccepted: replay.accepted, phase }, null, 2));
} finally {
  ws?.close();
  if (started) await run(cli, ['stop'], { env, timeout: 20_000 }).catch(() => undefined);
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => model.close(resolve));
}
