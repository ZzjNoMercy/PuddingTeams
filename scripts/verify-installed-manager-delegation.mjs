import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, readFile, writeFile, chmod, access } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

// Installed-package protocol rehearsal. All state and both mock peers are isolated.
const cli = process.argv[2];
const mode = process.argv[3] ?? 'approve';
if (!cli || !path.isAbsolute(cli) || !['approve', 'pending-switch', 'browser-pending'].includes(mode)) throw new Error('Usage: node scripts/verify-installed-manager-delegation.mjs /absolute/path/to/puddingteams [approve|pending-switch|browser-pending]');
const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-manager-chain-');
const env = { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
const worker = path.join(home, 'worker.sh');
await writeFile(worker, `#!/bin/sh
if [ "$2" = run ]; then
  printf '%s\\n' run >> '${home}/worker-dispatches.log'
  /bin/cat > '${home}/worker-run.json'
  /bin/pwd > '${home}/worker-run-cwd.txt'
  printf '%s\\n' '{"status":"needs_input","run_id":"fixture-run","session_id":"fixture-session","continuation_token":"private-fixture-token","needs_input":{"type":"permission","request_id":"fixture-permission","prompt":"允许继续？","options":[{"id":"once"},{"id":"reject"}]}}'
elif [ "$2" = respond ]; then
  /bin/cat > '${home}/worker-respond.json'
  /bin/pwd > '${home}/worker-respond-cwd.txt'
  printf '%s\\n' '{"status":"completed","run_id":"fixture-run","session_id":"fixture-session","final_response":"Worker 已完成"}'
elif [ "$2" = continue ]; then
  printf '%s\\n' continue >> '${home}/worker-dispatches.log'
  /bin/cat > '${home}/worker-continue.json'
  printf '%s\\n' '{"status":"completed","run_id":"fixture-direct-run","session_id":"fixture-session","final_response":"Direct Worker 已完成"}'
else
  exit 2
fi
`);
await chmod(worker, 0o700);
let modelCalls = 0;
const modelTools = [];
const sockets = new Set();
const mock = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] }));
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const names = (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
  modelTools.push(names);
  const callTool = names.includes('agent_puddingclaw__delegate') && !(body.messages ?? []).some((message) => message.role === 'tool');
  const id = `fixture-${++modelCalls}`;
  const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1780000000, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (callTool) {
    send({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${modelCalls}`, type: 'function', function: { name: 'agent_puddingclaw__delegate', arguments: JSON.stringify({ task: '执行安装态委托审批验证' }) } }] });
    send({}, 'tool_calls');
  } else {
    send({ role: 'assistant', content: 'Manager 收到 Worker 结果。' });
    send({}, 'stop');
  }
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
const request = async (method, route, body, operationKey) => {
  const headers = body === undefined ? {} : { 'content-type': 'application/json' };
  if (method === 'POST' && /^\/api\/sessions\/[^/]+\/messages$/.test(route)) headers['idempotency-key'] = operationKey ?? randomUUID();
  const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return { status: response.status, body: await response.json() };
};
const loseResponse = async (route, body, operationKey) => {
  const payload = JSON.stringify(body);
  let confirmUpstream;
  const upstreamConfirmed = new Promise((resolve) => { confirmUpstream = resolve; });
  const proxy = createServer((incoming, outgoing) => {
    const forwarded = httpRequest({ hostname: '127.0.0.1', port, path: route, method: 'POST', headers: incoming.headers }, (response) => {
      confirmUpstream(response.statusCode);
      response.resume();
      outgoing.destroy();
    });
    forwarded.once('error', (error) => { confirmUpstream({ error: error.message }); outgoing.destroy(); });
    incoming.pipe(forwarded);
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  try {
    const client = new Promise((resolve) => {
      const outgoing = httpRequest({ hostname: '127.0.0.1', port: proxy.address().port, path: route, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'idempotency-key': operationKey } },
      (response) => { response.resume(); resolve({ unexpectedStatus: response.statusCode }); });
      outgoing.once('error', (error) => resolve({ errorCode: error.code }));
      outgoing.end(payload);
    });
    return { upstreamStatus: await upstreamConfirmed, client: await client };
  } finally { await new Promise((resolve) => proxy.close(resolve)); }
};
const ok = async (method, route, body) => { const result = await request(method, route, body); assert.equal(result.status, 200, `${method} ${route}: ${JSON.stringify(result.body)}`); return result.body; };
const waitFor = async (fn, label, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timeout waiting for ${label}`);
};
let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  assert.deepEqual((await ok('GET', '/api/rooms/solo/work-index')).works, [], 'first-open search must not invent a work item');
  const rooms = (await ok('GET', '/api/rooms')).rooms;
  const solo = rooms.find((room) => room.type === 'solo');
  assert.ok(solo);
  const a = (await ok('POST', '/api/workspaces', { managed: true, name: 'Manager fixture A' })).workspace;
  const b = (await ok('POST', '/api/workspaces', { managed: true, name: 'Manager fixture B' })).workspace;
  const workerAgent = (await ok('GET', '/api/agents')).agents.find((agent) => agent.name === 'puddingclaw');
  assert.ok(workerAgent);
  await ok('PUT', '/api/agents/puddingclaw/connector', { expectedRevision: workerAgent.extensionRevision ?? 0, extensionId: 'puddingclaw', connectorId: 'puddingclaw', transport: 'spawn', config: { command: worker } });
  const catalog = await ok('GET', '/api/providers/custom');
  await ok('PUT', '/api/providers/custom/fixture', { expectedRevision: catalog.revision, name: 'Fixture', baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: 'openai-completions', models: [{ id: 'fixture-model' }] });
  await ok('POST', '/api/providers/fixture/key', { apiKey: 'fixture-only' });
  await ok('POST', `/api/rooms/${solo.id}/switch-workspace`, { workspaceId: a.id, mode: 'in_place' });
  const manager = (await ok('GET', `/api/rooms/${solo.id}`)).room;
  const sessionId = manager.activeSession;
  await ok('POST', `/api/sessions/${sessionId}/model`, { model: 'fixture/fixture-model' });
  await ok('POST', `/api/sessions/${sessionId}/messages`, { content: '请委托 PuddingClaw Worker 完成工作并处理审批。' });
  const interaction = await waitFor(async () => (await ok('GET', '/api/interactions')).interactions[0], 'pending interaction');
  const direct = await waitFor(async () => (await ok('GET', '/api/rooms')).rooms.find((room) => room.type === 'direct'), 'direct window');
  const wrong = await request('POST', `/api/interactions/${interaction.id}/responses`, { requestId: 'fixture-response-wrong', revision: interaction.revision, windowId: solo.id, responses: [{ requestId: 'fixture-permission', action: 'approve', scope: 'once' }] });
  assert.equal(wrong.status, 403);
  const runCwd = (await readFile(path.join(home, 'worker-run-cwd.txt'), 'utf8')).trim();
  assert.equal(runCwd, a.canonicalPath);
  const runInput = JSON.parse(await readFile(path.join(home, 'worker-run.json'), 'utf8'));
  assert.equal(runInput.workspace_path, a.canonicalPath);
  assert.ok(modelTools.some((names) => names.includes('agent_puddingclaw__delegate')));
  if (mode === 'browser-pending') {
    console.log(JSON.stringify({ ready: true, home, base, workspaceA: a.id, workspaceB: b.id, managerSession: sessionId, directWindow: direct.id, interaction: interaction.id }, null, 2));
    await new Promise((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
      setTimeout(resolve, 15 * 60_000).unref();
    });
  } else {
  let approved;
  if (mode === 'approve') {
    approved = await ok('POST', `/api/interactions/${interaction.id}/responses`, { requestId: 'fixture-response-correct', revision: interaction.revision, windowId: direct.id, responses: [{ requestId: 'fixture-permission', action: 'approve', scope: 'once' }] });
    assert.equal(approved.outcome.status, 'approved');
    await waitFor(async () => (await ok('GET', `/api/sessions/${sessionId}/messages`)).messages.some((message) => message.role === 'assistant' && JSON.stringify(message.content).includes('Manager 收到 Worker 结果')), 'Manager final response');
    const respondCwd = (await readFile(path.join(home, 'worker-respond-cwd.txt'), 'utf8')).trim();
    assert.equal(respondCwd, a.canonicalPath);
  }
  const toB = (await ok('POST', `/api/rooms/${solo.id}/switch-workspace`, { workspaceId: b.id, mode: 'in_place' })).room;
  assert.notEqual(toB.activeSession, sessionId);
  const parkedIndex = (await ok('GET', `/api/rooms/${solo.id}/work-index`)).works;
  assert.equal(parkedIndex.find((work) => work.sessionId === sessionId)?.workspaceName, a.name);
  assert.equal(parkedIndex.find((work) => work.sessionId === sessionId)?.firstMessage, '请委托 PuddingClaw Worker 完成工作并处理审批。');
  assert.equal(parkedIndex.find((work) => work.sessionId === sessionId)?.active, false);
  assert.equal(parkedIndex.some((work) => work.sessionId === toB.activeSession), false, 'empty B container is not searchable work');
  let inactive;
  if (mode === 'pending-switch') {
    const process = await ok('GET', `/api/delegations/${interaction.delegationId}/process`);
    assert.equal(process.executionState, 'observation_lost');
    const old = (await ok('GET', `/api/interactions/${interaction.id}`)).interaction;
    assert.equal(old.status, 'expired');
    assert.equal((await ok('GET', '/api/interactions')).interactions.length, 0);
    inactive = await request('POST', `/api/interactions/${interaction.id}/responses`, { requestId: 'fixture-response-while-b', revision: interaction.revision, windowId: direct.id, responses: [{ requestId: 'fixture-permission', action: 'approve', scope: 'once' }] });
    assert.equal(inactive.status, 409, JSON.stringify(inactive.body));
    assert.equal(inactive.body.code, 'interaction_context_inactive');
  }
  const back = await ok('POST', `/api/rooms/${solo.id}/switch-workspace`, { workspaceId: a.id, mode: 'in_place' });
  assert.equal(back.room.activeSession, sessionId);
  assert.equal(back.restored, true);
  let stale;
  if (mode === 'pending-switch') {
    const cards = await waitFor(async () => {
      const history = (await ok('GET', `/api/sessions/${sessionId}/messages`)).messages;
      const projected = history.filter((message) => message.customType === 'pudding:interaction_resolved' || message.customType === 'pudding:task_result');
      return projected.length >= 2 ? projected.slice(-2) : undefined;
    }, 'honest cancellation cards');
    assert.deepEqual(cards.map((message) => message.details?.status), ['observation_lost', 'observation_lost']);
    assert.ok(cards.every((message) => !/已终止|已由用户取消/.test(message.content)));
    stale = await request('POST', `/api/interactions/${interaction.id}/responses`, { requestId: 'fixture-response-after-return', revision: interaction.revision, windowId: direct.id, responses: [{ requestId: 'fixture-permission', action: 'approve', scope: 'once' }] });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.code, 'not_pending');
    await assert.rejects(access(path.join(home, 'worker-respond.json')));
  }
  await run(cli, ['stop'], { env, timeout: 20000 });
  started = false;
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const coldRoom = (await ok('GET', `/api/rooms/${solo.id}`)).room;
  const coldHistory = (await ok('GET', `/api/sessions/${sessionId}/messages`)).messages;
  const coldInteraction = (await ok('GET', `/api/interactions/${interaction.id}`)).interaction;
  assert.equal(coldRoom.activeSession, sessionId);
  const coldWork = (await ok('GET', `/api/rooms/${solo.id}/work-index`)).works.find((work) => work.sessionId === sessionId);
  assert.equal(coldWork?.active, true);
  assert.equal(coldWork?.firstMessage, '请委托 PuddingClaw Worker 完成工作并处理审批。');
  assert.equal(coldInteraction.status, mode === 'approve' ? 'approved' : 'expired');
  if (mode === 'approve') assert.ok(coldHistory.some((message) => message.role === 'assistant' && JSON.stringify(message.content).includes('Manager 收到 Worker 结果')));
  else {
    assert.equal((await ok('GET', '/api/interactions')).interactions.length, 0);
    const process = await ok('GET', `/api/delegations/${interaction.delegationId}/process`);
    assert.equal(process.executionState, 'observation_lost');
    await assert.rejects(access(path.join(home, 'worker-respond.json')));
  }
  assert.equal(JSON.stringify(coldHistory).includes('private-fixture-token'), false);
  let directLostResponse;
  let directReplayStatus;
  let directColdReplayStatus;
  let directReservedRecoveryStatus;
  let directDispatches;
  if (mode === 'approve') {
    const directAfterRestart = (await ok('GET', `/api/rooms/${direct.id}`)).room;
    const directSessionId = directAfterRestart.activeSession;
    assert.ok(directSessionId);
    const directRoute = `/api/sessions/${directSessionId}/messages`;
    const directKey = randomUUID();
    const directPayload = { content: '安装态 direct 响应丢失验证' };
    const dispatchesBefore = (await readFile(path.join(home, 'worker-dispatches.log'), 'utf8')).trim().split('\n').length;
    directLostResponse = await loseResponse(directRoute, directPayload, directKey);
    assert.equal(directLostResponse.upstreamStatus, 200, JSON.stringify(directLostResponse));
    assert.equal(directLostResponse.client.errorCode, 'ECONNRESET', JSON.stringify(directLostResponse));
    const replay = await request('POST', directRoute, directPayload, directKey);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    directReplayStatus = replay.status;
    const directHistory = (await ok('GET', directRoute)).messages;
    assert.equal(directHistory.filter((message) => message.customType === 'pudding:user_message' && message.details?.operationId === directKey).length, 1);
    assert.equal(directHistory.filter((message) => message.customType === 'pudding:task_assign' && message.details?.operationId === directKey && !message.details?.delegationId).length, 1);
    directDispatches = (await readFile(path.join(home, 'worker-dispatches.log'), 'utf8')).trim().split('\n').length - dispatchesBefore;
    assert.equal(directDispatches, 1);
    await run(cli, ['stop'], { env, timeout: 20000 });
    started = false;
    await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
    started = true;
    const coldReplay = await request('POST', directRoute, directPayload, directKey);
    assert.equal(coldReplay.status, 200, JSON.stringify(coldReplay.body));
    directColdReplayStatus = coldReplay.status;
    const coldDirectHistory = (await ok('GET', directRoute)).messages;
    assert.equal(coldDirectHistory.filter((message) => message.customType === 'pudding:user_message' && message.details?.operationId === directKey).length, 1);
    assert.equal((await readFile(path.join(home, 'worker-dispatches.log'), 'utf8')).trim().split('\n').length - dispatchesBefore, 1);
    await run(cli, ['stop'], { env, timeout: 20000 });
    started = false;
    const operationFile = path.join(home, 'state', 'message-submission-operations', `${createHash('sha256').update(directKey).digest('hex')}.json`);
    const acceptedRecord = JSON.parse(await readFile(operationFile, 'utf8'));
    assert.equal(acceptedRecord.state, 'accepted');
    await writeFile(operationFile, `${JSON.stringify({ ...acceptedRecord, state: 'reserved' })}\n`);
    await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
    started = true;
    const recovered = await request('POST', directRoute, directPayload, directKey);
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    directReservedRecoveryStatus = recovered.status;
    assert.equal(JSON.parse(await readFile(operationFile, 'utf8')).state, 'accepted');
    assert.equal((await ok('GET', directRoute)).messages.filter((message) => message.customType === 'pudding:user_message' && message.details?.operationId === directKey).length, 1);
    assert.equal((await readFile(path.join(home, 'worker-dispatches.log'), 'utf8')).trim().split('\n').length - dispatchesBefore, 1);
  }
  console.log(JSON.stringify({ home, cli, mode, modelCalls, managerSession: sessionId, workspaceA: a.id, workspaceB: b.id, directWindow: direct.id, interaction: interaction.id, wrongWindowStatus: wrong.status, approvedStatus: approved?.outcome.status, inactiveStatus: inactive?.status, inactiveCode: inactive?.body.code, staleStatus: stale?.status, coldInteractionStatus: coldInteraction.status, coldHistoryCount: coldHistory.length, restored: back.restored, directLostResponse, directReplayStatus, directColdReplayStatus, directReservedRecoveryStatus, directDispatches }, null, 2));
  }
} finally {
  if (started) await run(cli, ['stop'], { env, timeout: 20000 }).catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => mock.close(resolve));
}
