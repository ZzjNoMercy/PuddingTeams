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
if (!cli || !path.isAbsolute(cli) || !['verify', 'browser-hold', 'browser-stream-hold'].includes(mode)) throw new Error('Usage: node scripts/verify-installed-pi-worker-mcp.mjs /absolute/path/to/puddingteams [verify|browser-hold|browser-stream-hold]');
const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-pi-worker-mcp-');
const env = { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
const sockets = new Set();
const track = (server) => server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
const close = async (server) => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); };
const listen = async (server) => { track(server); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return server.address().port; };
const mcpSeen = [];
const mcp = createServer(async (req, res) => {
  if (req.method === 'GET') return void res.writeHead(404).end();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const data = JSON.parse(Buffer.concat(chunks).toString());
  const token = req.headers.authorization;
  if (data.method === 'initialize' || data.method === 'tools/list' || data.method === 'tools/call') mcpSeen.push({ method: data.method, token });
  if (data.method === 'notifications/initialized') return void res.writeHead(202).end();
  const result = data.method === 'initialize'
    ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture-docs', version: '1.0.0' } }
    : data.method === 'tools/list'
      ? { tools: [{ name: 'ping', description: 'Return the configured token version', inputSchema: { type: 'object', properties: {} } }] }
      : { content: [{ type: 'text', text: `MCP ${token}` }] };
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: data.id, result })}\r\n\r\n`);
});
const mcpPort = await listen(mcp);
let modelCalls = 0;
let managerDelegations = 0;
let workerToolCalls = 0;
const toolSurfaces = [];
let pendingBrowserReply = null;
const model = createServer(async (req, res) => {
  if (mode === 'browser-stream-hold' && req.method === 'GET' && req.url === '/__fixture/pending') {
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ pending: Boolean(pendingBrowserReply) }));
  }
  if (mode === 'browser-stream-hold' && req.method === 'POST' && req.url === '/__fixture/release') {
    if (!pendingBrowserReply) return void res.writeHead(409).end();
    pendingBrowserReply();
    pendingBrowserReply = null;
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ released: true }));
  }
  if (req.method === 'GET' && req.url === '/v1/models') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] }));
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const names = (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
  toolSurfaces.push(names);
  const delegate = names.find((name) => name === 'agent_pi-b__delegate');
  const ping = names.find((name) => name.includes('ping'));
  const secondPrompt = JSON.stringify(body.messages ?? []).includes('再次委托 Designer');
  const thirdPrompt = JSON.stringify(body.messages ?? []).includes('第三次委托 Designer');
  const tool = delegate && managerDelegations < (thirdPrompt ? 3 : secondPrompt ? 2 : 1)
    ? delegate
    : ping && workerToolCalls < managerDelegations ? ping : undefined;
  if (tool && tool === delegate) managerDelegations++;
  if (tool && tool === ping) workerToolCalls++;
  const id = `fixture-${++modelCalls}`;
  const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1780000000, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (mode === 'browser-stream-hold' && JSON.stringify(body.messages ?? []).includes('A12-WS-STREAM')) {
    send({ role: 'assistant', content: 'A12 流式阶段一；' });
    pendingBrowserReply = () => {
      send({ content: '阶段二已完成。' });
      send({}, 'stop');
      res.end('data: [DONE]\n\n');
    };
    return;
  }
  if (tool) {
    send({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${modelCalls}`, type: 'function', function: { name: tool, arguments: JSON.stringify(tool === ping ? {} : { task: `调用 Docs MCP ping 并报告结果，委托编号 ${managerDelegations}` }) } }] });
    send({}, 'tool_calls');
  } else {
    send({ role: 'assistant', content: ping ? 'Pi Worker 已完成 MCP 调用。' : 'Manager 收到 Pi Worker 结果。' });
    send({}, 'stop');
  }
  res.end('data: [DONE]\n\n');
});
const modelPort = await listen(model);
const reserve = createTcpServer();
const port = await listen(reserve);
await close(reserve);
const base = `http://127.0.0.1:${port}`;
const request = async (method, route, body) => {
  const response = await fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(route.endsWith('/messages') ? { 'idempotency-key': randomUUID() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const ok = async (method, route, body) => { const result = await request(method, route, body); assert.equal(result.status, 200, `${method} ${route}: ${JSON.stringify(result.body)}`); return result.body; };
const waitFor = async (fn, label) => { const deadline = Date.now() + 20_000; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 150)); } throw new Error(`timeout waiting for ${label}: ${JSON.stringify({ mcpSeen: mcpSeen.slice(-5), modelCalls, managerDelegations, workerToolCalls, lastToolSurfaces: toolSurfaces.slice(-3) })}`); };
let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30_000 });
  started = true;
  const agents = (await ok('GET', '/api/agents')).agents;
  const worker = agents.find((agent) => agent.name === 'pi-b');
  assert.ok(worker);
  await ok('PUT', '/api/agents/pi-b/connector', { ...worker.connector, config: { model: 'fixture/fixture-model' }, expectedRevision: worker.extensionRevision });
  const created = await request('POST', '/api/extensions/mcp/servers', { id: 'fixture-docs', displayName: 'Fixture Docs', definition: { url: `http://127.0.0.1:${mcpPort}/mcp`, headers: { Authorization: 'Bearer ${API_TOKEN}' } }, secrets: { API_TOKEN: 'old-token' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const choice = await ok('GET', '/api/agents/pi-b/mcp');
  await ok('PUT', '/api/agents/pi-b/mcp', { serverIds: ['fixture-docs'], expectedRevision: choice.revision });
  const provider = await ok('GET', '/api/providers/custom');
  await ok('PUT', '/api/providers/custom/fixture', { expectedRevision: provider.revision, name: 'Fixture', baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: 'openai-completions', models: [{ id: 'fixture-model' }] });
  await ok('POST', '/api/providers/fixture/key', { apiKey: 'fixture-only' });
  const solo = (await ok('GET', '/api/rooms')).rooms.find((room) => room.type === 'solo');
  assert.ok(solo);
  const room = (await ok('GET', `/api/rooms/${solo.id}`)).room;
  await ok('POST', `/api/sessions/${room.activeSession}/model`, { model: 'fixture/fixture-model' });
  await ok('POST', `/api/sessions/${room.activeSession}/messages`, { content: '请委托 Designer 调用 Docs MCP 工具。' });
  await waitFor(() => mcpSeen.some((entry) => entry.method === 'tools/call' && entry.token === 'Bearer old-token'), 'Pi Worker MCP tool call');
  await waitFor(async () => (await ok('GET', `/api/sessions/${room.activeSession}/messages`)).messages.some((message) => message.role === 'assistant' && JSON.stringify(message.content).includes('Manager 收到 Pi Worker 结果')), 'first Manager reply');
  const changed = await ok('PUT', '/api/extensions/mcp/servers/fixture-docs', { displayName: 'Fixture Docs', definition: { url: `http://127.0.0.1:${mcpPort}/mcp`, headers: { Authorization: 'Bearer ${API_TOKEN}' } }, secrets: { API_TOKEN: 'new-token' } });
  assert.ok(changed);
  await ok('POST', `/api/sessions/${room.activeSession}/messages`, { content: '再次委托 Designer 调用 Docs MCP 工具。' });
  await waitFor(() => mcpSeen.some((entry) => entry.method === 'tools/call' && entry.token === 'Bearer new-token'), 'new Pi Worker MCP tool call');
  assert.ok(toolSurfaces.some((names) => names.some((name) => name.endsWith('__delegate'))));
  assert.ok(toolSurfaces.some((names) => names.some((name) => name.includes('ping'))));
  const processes = (await ok('GET', `/api/rooms/${solo.id}/delegation-processes?managerSessionId=${room.activeSession}`)).delegations;
  assert.ok(processes.length >= 2, 'two Pi Worker delegations should be discoverable');
  const directRoom = (await ok('GET', '/api/rooms')).rooms.find((item) => item.type === 'direct' && item.members?.some((member) => member.name === 'pi-b'));
  console.log(JSON.stringify({ home, base, cli, mode, managerSession: room.activeSession, directRoomId: directRoom?.id, directSessionId: directRoom?.activeSession, modelControlUrl: mode === 'browser-stream-hold' ? `http://127.0.0.1:${modelPort}/__fixture` : undefined, modelCalls, mcpSeen, delegationIds: processes.map((item) => item.delegationId), piToolSurface: toolSurfaces.find((names) => names.some((name) => name.includes('ping'))) }, null, 2));
  if (mode === 'browser-hold' || mode === 'browser-stream-hold') {
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); process.off('SIGINT', done); process.off('SIGTERM', done); resolve(); };
      const timer = setTimeout(done, 15 * 60_000);
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
  }
} finally {
  if (started) await run(cli, ['stop'], { env, timeout: 20_000 }).catch(() => {});
  await close(model);
  await close(mcp);
}
