import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
const cli = process.env.PUDDINGTEAMS_INSTALLED_CLI;
assert.ok(cli && path.isAbsolute(cli), 'PUDDINGTEAMS_INSTALLED_CLI must point to an installed CLI');
const home = await mkdtemp('/private/tmp/puddingteams-m1-positive-');
const externalRoot = await mkdtemp('/private/tmp/puddingteams-first-work-path-');
const env = {
  PATH: '/opt/homebrew/bin:/usr/bin:/bin',
  HOME: home,
  PUDDINGTEAMS_HOME: home,
  PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'),
  PI_OFFLINE: '1',
};
let modelRequests = 0;
let releaseHeldModel;
let markHeldModelStarted;
const heldModelRelease = new Promise((resolve) => { releaseHeldModel = resolve; });
const heldModelStarted = new Promise((resolve) => { markHeldModelStarted = resolve; });
const mock = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.writeHead(404).end();
    return;
  }
  modelRequests++;
  let requestBody = '';
  for await (const chunk of req) requestBody += chunk.toString();
  if (requestBody.includes('fixture upstream failure') && !requestBody.includes('请为下面这段对话')) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'fixture upstream rejected credential', type: 'authentication_error' } }));
    return;
  }
  if (requestBody.includes('fixture positive preflight') && !requestBody.includes('请为下面这段对话')) {
    markHeldModelStarted();
    await heldModelRelease;
  }
  const chunk = (delta, finishReason = null) => JSON.stringify({
    id: `chatcmpl-fixture-${modelRequests}`,
    object: 'chat.completion.chunk',
    created: 1780000000,
    model: 'fixture-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(`data: ${chunk({ role: 'assistant', content: 'fixture reply' })}\n\n`);
  res.write(`data: ${chunk({}, 'stop')}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', resolve); });
const mockPort = mock.address().port;
const socket = createTcpServer();
await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const request = async (route, options) => {
  const response = await fetch(`${base}${route}`, options);
  const body = await response.json();
  return { status: response.status, body };
};
const within = async (promise, ms, message) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer); }
};
const loseResponse = async (route, body, operationKey, disconnectBeforeReply) => {
  const payload = JSON.stringify(body);
  let confirmUpstream;
  const upstreamConfirmed = new Promise((resolve) => { confirmUpstream = resolve; });
  const proxy = createServer((incoming, outgoing) => {
    const forwarded = httpRequest({ hostname: '127.0.0.1', port, path: route, method: 'POST', headers: incoming.headers }, (response) => {
      confirmUpstream(response.statusCode);
      response.resume();
      if (!disconnectBeforeReply) outgoing.destroy(); // Never forward status, headers, or body to the client.
    });
    forwarded.once('error', (error) => { confirmUpstream({ error: error.message }); outgoing.destroy(); });
    if (disconnectBeforeReply) incoming.once('end', () => outgoing.destroy());
    incoming.pipe(forwarded);
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  try {
    const clientResult = new Promise((resolve) => {
      const outgoing = httpRequest({
        hostname: '127.0.0.1', port: proxy.address().port, path: route, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'idempotency-key': operationKey },
      }, (response) => { response.resume(); resolve({ unexpectedStatus: response.statusCode }); });
      outgoing.once('error', (error) => resolve({ errorCode: error.code }));
      outgoing.end(payload);
    });
    return { upstreamStatus: await upstreamConfirmed, client: await clientResult };
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
};
const countDurableUsers = async () => {
  const files = (await readdir(path.join(home, 'sessions'), { recursive: true })).filter((file) => file.endsWith('.jsonl'));
  let users = 0;
  for (const file of files) {
    const lines = (await readFile(path.join(home, 'sessions', file), 'utf8')).split('\n');
    for (const line of lines) {
      if (!line) continue;
      try { const entry = JSON.parse(line); if (entry.type === 'message' && entry.message?.role === 'user') users++; }
      catch { /* unfinished final line */ }
    }
  }
  return users;
};
let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const rootPage = await fetch(`${base}/`);
  const chatPage = await fetch(`${base}/chats?room=missing`);
  assert.equal(rootPage.status, 200);
  assert.equal(chatPage.status, 200);
  assert.match(rootPage.headers.get('content-type') ?? '', /text\/html/);
  assert.match(chatPage.headers.get('content-type') ?? '', /text\/html/);
  const catalog = await request('/api/providers/custom');
  assert.equal(catalog.status, 200);
  const created = await request('/api/providers/custom/fixture', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: catalog.body.revision, name: 'Local Fixture', baseUrl: `http://127.0.0.1:${mockPort}/v1`, api: 'openai-completions', models: [{ id: 'fixture-model' }] }),
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const key = await request('/api/providers/fixture/key', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: 'fixture-key-only' }),
  });
  assert.equal(key.status, 200, JSON.stringify(key.body));
  const rooms = await request('/api/rooms');
  const sessionId = rooms.body.rooms.find((room) => room.type === 'solo')?.activeSession;
  assert.ok(sessionId);
  const selected = await request(`/api/sessions/${sessionId}/model`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture/fixture-model' }),
  });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const sent = await within(request(`/api/sessions/${sessionId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ content: 'fixture positive preflight' }),
  }), 5000, 'normal send did not return while the model response was held');
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.accepted, true);
  await within(heldModelStarted, 5000, 'held model request did not start');
  const midTurn = await request(`/api/sessions/${sessionId}/messages`);
  assert.equal(midTurn.status, 200);
  assert.equal(midTurn.body.running, true, 'a pure model turn must report running while its response is held');
  releaseHeldModel();
  let messages = [];
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const history = await request(`/api/sessions/${sessionId}/messages`);
    assert.equal(history.status, 200);
    messages = history.body.messages;
    if (messages.some((message) => message.role === 'assistant') && history.body.running === false) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const durableUsers = await countDurableUsers();
  assert.equal(messages.filter((message) => message.role === 'user').length, 1);
  assert.ok(messages.some((message) => message.role === 'assistant'));
  const settled = await request(`/api/sessions/${sessionId}/messages`);
  assert.equal(settled.body.running, false, 'completed model turn must report idle');
  assert.equal(durableUsers, 1);
  assert.ok(modelRequests >= 1);
  const sessionSocket = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${sessionId}/ws`);
  const socketFrames = [];
  sessionSocket.addEventListener('message', (event) => socketFrames.push(JSON.parse(String(event.data))));
  const waitForSocketFrame = async (predicate, message) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (socketFrames.some(predicate)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(message);
  };
  await within(new Promise((resolve) => sessionSocket.addEventListener('open', resolve, { once: true })), 5000, 'session websocket did not open');
  await waitForSocketFrame((frame) => frame.type === 'session_ready', 'session websocket was not ready');
  const upstreamFailure = await within(request(`/api/sessions/${sessionId}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ content: 'fixture upstream failure' }),
  }), 5000, 'admitted message did not return after upstream failure');
  assert.equal(upstreamFailure.status, 200, JSON.stringify(upstreamFailure.body));
  assert.equal(upstreamFailure.body.accepted, true);
  let failureHistory;
  const failureDeadline = Date.now() + 10000;
  while (Date.now() < failureDeadline) {
    failureHistory = await request(`/api/sessions/${sessionId}/messages`);
    if (failureHistory.body.running === false && failureHistory.body.messages.some((message) =>
      message.role === 'user' && JSON.stringify(message.content).includes('fixture upstream failure'))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(failureHistory?.body.running, false);
  assert.equal(failureHistory.body.messages.filter((message) => message.role === 'user').length, 2);
  const failureUserFrame = socketFrames.find((frame) => frame.type === 'message_start' && frame.message?.role === 'user' &&
    JSON.stringify(frame.message.content).includes('fixture upstream failure'));
  const failureUserHistory = failureHistory.body.messages.find((message) => message.role === 'user' &&
    JSON.stringify(message.content).includes('fixture upstream failure'));
  assert.ok(failureUserFrame?.message?.puddingMessageId);
  assert.equal(failureUserHistory?.puddingMessageId, failureUserFrame.message.puddingMessageId,
    'HTTP history and websocket must use the same message identity');
  const assistantFailures = failureHistory.body.messages.filter((message) =>
    message.role === 'assistant' && message.stopReason === 'error' && String(message.errorMessage).includes('fixture upstream rejected credential'));
  assert.equal(assistantFailures.length, 1, 'model failure must remain visible as an assistant error entry');
  assert.equal(await countDurableUsers(), 2, 'accepted user must survive the model transport failure');
  const sessionFiles = (await readdir(path.join(home, 'sessions'), { recursive: true })).filter((file) => file.endsWith('.jsonl'));
  for (const file of sessionFiles) {
    assert.ok(!(await readFile(path.join(home, 'sessions', file), 'utf8')).includes('"puddingMessageId"'),
      'wire message identity must not change Pi JSONL entries');
  }
  await waitForSocketFrame((frame) => frame.type === 'message_end' && frame.message?.role === 'assistant' &&
    frame.message?.stopReason === 'error' && String(frame.message?.errorMessage).includes('fixture upstream rejected credential'),
  'model error did not reach the session websocket');
  const failureEvents = socketFrames.filter((frame) =>
    ['message_start', 'message_update', 'message_end'].includes(frame.type) && frame.message?.role === 'assistant');
  assert.ok(failureEvents.some((frame) => frame.type === 'message_start'));
  assert.ok(failureEvents.some((frame) => frame.type === 'message_end'));
  assert.equal(new Set(failureEvents.map((frame) => frame.message?.timestamp)).size, 1, 'one assistant turn must keep one timestamp across failure events');
  sessionSocket.close();
  const ordinaryKey = randomUUID();
  const ordinaryPayload = { content: 'fixture ordinary response lost' };
  const ordinaryRoute = `/api/sessions/${sessionId}/messages`;
  const lostOrdinaryResponse = await loseResponse(ordinaryRoute, ordinaryPayload, ordinaryKey, false);
  assert.equal(lostOrdinaryResponse.upstreamStatus, 200, JSON.stringify(lostOrdinaryResponse));
  assert.equal(lostOrdinaryResponse.client.errorCode, 'ECONNRESET', JSON.stringify(lostOrdinaryResponse));
  const retryOrdinary = () => request(ordinaryRoute, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': ordinaryKey }, body: JSON.stringify(ordinaryPayload),
  });
  const ordinaryReplay = await retryOrdinary();
  assert.equal(ordinaryReplay.status, 200, JSON.stringify(ordinaryReplay.body));
  assert.equal((await request(ordinaryRoute)).body.messages.filter((message) => message.role === 'user').length, 3);
  assert.equal(await countDurableUsers(), 3);
  const rejectedOrdinaryKey = randomUUID();
  const rejectedOrdinaryPayload = { content: `读取 ${path.join(home, 'missing-before-send.txt')}` };
  const retryRejectedOrdinary = () => request(ordinaryRoute, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': rejectedOrdinaryKey },
    body: JSON.stringify(rejectedOrdinaryPayload),
  });
  const rejectedOrdinary = await retryRejectedOrdinary();
  assert.equal(rejectedOrdinary.status, 400);
  assert.equal(rejectedOrdinary.body.code, 'message_operation_rejected');
  assert.equal((await retryRejectedOrdinary()).body.code, 'message_operation_rejected');
  assert.equal(await countDurableUsers(), 3);
  const ordinaryEntries = (await Promise.all((await readdir(path.join(home, 'sessions')))
    .filter((file) => file.endsWith('.jsonl'))
    .map(async (file) => (await readFile(path.join(home, 'sessions', file), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)))))
    .flat();
  const admission = ordinaryEntries.filter((entry) => entry.type === 'custom_message' &&
    entry.customType === 'pudding:message_admission' && entry.details?.operationId === ordinaryKey);
  assert.equal(admission.length, 1, 'ordinary message must have one durable admission marker');
  assert.equal(admission[0].display, false);
  assert.equal(ordinaryEntries.filter((entry) => entry.type === 'message' && entry.id === admission[0].details.userEntryId &&
    entry.message?.role === 'user').length, 1);
  const operationKey = randomUUID();
  const firstWorkPayload = { content: 'fixture first work', workspaceId: rooms.body.rooms.find((room) => room.type === 'solo')?.workspace?.id ?? null, cwdSnapshot: rooms.body.defaultCwdSnapshot };
  const startWork = (content) => request('/api/rooms/solo/new-work', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': operationKey },
    body: JSON.stringify({ ...firstWorkPayload, content }),
  });
  const lostResponse = await loseResponse('/api/rooms/solo/new-work', firstWorkPayload, operationKey, false);
  assert.equal(lostResponse.upstreamStatus, 200, JSON.stringify(lostResponse));
  assert.equal(lostResponse.client.errorCode, 'ECONNRESET', JSON.stringify(lostResponse));
  const firstWork = await startWork(firstWorkPayload.content);
  assert.equal(firstWork.status, 200, JSON.stringify(firstWork.body));
  assert.equal(firstWork.body.accepted, true);
  const firstWorkHistory = await request(`/api/sessions/${firstWork.body.sessionId}/messages`);
  assert.equal(firstWorkHistory.status, 200);
  const firstWorkUsers = firstWorkHistory.body.messages.filter((message) => message.role === 'user');
  assert.equal(firstWorkUsers.length, 1);
  assert.ok(JSON.stringify(firstWorkUsers[0].content).includes(firstWorkPayload.content));
  const replay = await startWork(firstWorkPayload.content);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.sessionId, firstWork.body.sessionId);
  const conflict = await startWork('different first work');
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  const earlyKey = randomUUID();
  const earlyPayload = { ...firstWorkPayload, content: 'fixture early disconnect work' };
  const lostBeforeReply = await loseResponse('/api/rooms/solo/new-work', earlyPayload, earlyKey, true);
  assert.equal(lostBeforeReply.upstreamStatus, 200, JSON.stringify(lostBeforeReply));
  assert.equal(lostBeforeReply.client.errorCode, 'ECONNRESET', JSON.stringify(lostBeforeReply));
  const recoverEarly = () => request('/api/rooms/solo/new-work', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': earlyKey },
    body: JSON.stringify(earlyPayload),
  });
  const earlyRecovered = await recoverEarly();
  assert.equal(earlyRecovered.status, 200, JSON.stringify(earlyRecovered.body));
  assert.notEqual(earlyRecovered.body.sessionId, firstWork.body.sessionId);
  const earlyHistory = await request(`/api/sessions/${earlyRecovered.body.sessionId}/messages`);
  assert.equal(earlyHistory.body.messages.filter((message) => message.role === 'user').length, 1);
  const attachmentKey = randomUUID();
  const attachmentBytes = [Buffer.from('first frozen attachment'), Buffer.from('second frozen attachment')];
  const attachmentPayload = {
    ...firstWorkPayload,
    content: 'fixture work with two attachments',
    attachments: [
      { filename: 'first.md', mediaType: 'text/markdown', data: attachmentBytes[0].toString('base64') },
      { filename: 'second.txt', mediaType: 'text/plain', data: attachmentBytes[1].toString('base64') },
    ],
  };
  const lostAttachmentResponse = await loseResponse('/api/rooms/solo/new-work', attachmentPayload, attachmentKey, false);
  assert.equal(lostAttachmentResponse.upstreamStatus, 200, JSON.stringify(lostAttachmentResponse));
  assert.equal(lostAttachmentResponse.client.errorCode, 'ECONNRESET', JSON.stringify(lostAttachmentResponse));
  const attachmentRequest = (payload) => request('/api/rooms/solo/new-work', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': attachmentKey }, body: JSON.stringify(payload),
  });
  const attachmentRecovered = await attachmentRequest(attachmentPayload);
  assert.equal(attachmentRecovered.status, 200, JSON.stringify(attachmentRecovered.body));
  const attachmentHistory = await request(`/api/sessions/${attachmentRecovered.body.sessionId}/messages`);
  const attachmentUsers = attachmentHistory.body.messages.filter((message) => message.role === 'user');
  assert.equal(attachmentUsers.length, 1);
  const attachmentText = typeof attachmentUsers[0].content === 'string' ? attachmentUsers[0].content
    : attachmentUsers[0].content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  assert.ok(attachmentText.startsWith(`${attachmentPayload.content}\n\n用户附件`));
  const attachmentLines = attachmentText.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(attachmentLines.length, 2);
  for (let index = 0; index < attachmentLines.length; index++) {
    const frozenPath = attachmentLines[index].slice(attachmentLines[index].lastIndexOf(': ') + 2);
    assert.equal(path.dirname(frozenPath), path.join(home, 'uploads', attachmentRecovered.body.sessionId));
    assert.deepEqual(await readFile(frozenPath), attachmentBytes[index]);
  }
  const changedAttachment = await attachmentRequest({
    ...attachmentPayload,
    attachments: [{ ...attachmentPayload.attachments[0], data: Buffer.from('different bytes').toString('base64') }, attachmentPayload.attachments[1]],
  });
  assert.equal(changedAttachment.status, 409, JSON.stringify(changedAttachment.body));
  const reorderedAttachments = await attachmentRequest({ ...attachmentPayload, attachments: [...attachmentPayload.attachments].reverse() });
  assert.equal(reorderedAttachments.status, 409, JSON.stringify(reorderedAttachments.body));
  const externalPath = path.join(externalRoot, 'external-evidence.txt');
  await writeFile(externalPath, 'frozen external bytes');
  const externalKey = randomUUID();
  const externalPayload = { ...firstWorkPayload, content: `fixture external path \`${externalPath}\`` };
  const lostExternalResponse = await loseResponse('/api/rooms/solo/new-work', externalPayload, externalKey, false);
  assert.equal(lostExternalResponse.upstreamStatus, 200, JSON.stringify(lostExternalResponse));
  await unlink(externalPath);
  const externalRequest = () => request('/api/rooms/solo/new-work', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': externalKey }, body: JSON.stringify(externalPayload),
  });
  const externalRecovered = await externalRequest();
  assert.equal(externalRecovered.status, 200, JSON.stringify(externalRecovered.body));
  const externalHistory = await request(`/api/sessions/${externalRecovered.body.sessionId}/messages`);
  const externalUsers = externalHistory.body.messages.filter((message) => message.role === 'user');
  assert.equal(externalUsers.length, 1);
  const externalText = typeof externalUsers[0].content === 'string' ? externalUsers[0].content
    : externalUsers[0].content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  assert.ok(!externalText.includes(externalPath));
  const frozenExternalPath = externalText.split('\n').find((line) => line.startsWith('- external-evidence.txt '))?.split(': ').at(-1);
  assert.ok(frozenExternalPath);
  assert.deepEqual(await readFile(frozenExternalPath), Buffer.from('frozen external bytes'));
  assert.equal(await countDurableUsers(), 7);
  await run(cli, ['stop'], { env, timeout: 30000 });
  started = false;
  // Simulate the narrow crash after both JSONL facts reached disk but before the ledger's accepted rename.
  const ordinaryLedgerFile = path.join(home, 'state', 'message-submission-operations',
    `${createHash('sha256').update(ordinaryKey).digest('hex')}.json`);
  const ordinaryLedger = JSON.parse(await readFile(ordinaryLedgerFile, 'utf8'));
  assert.equal(ordinaryLedger.state, 'accepted');
  await writeFile(ordinaryLedgerFile, `${JSON.stringify({ ...ordinaryLedger, state: 'reserved' })}\n`);
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const coldOrdinaryReplay = await retryOrdinary();
  assert.equal(coldOrdinaryReplay.status, 200, JSON.stringify(coldOrdinaryReplay.body));
  assert.equal(JSON.parse(await readFile(ordinaryLedgerFile, 'utf8')).state, 'accepted');
  assert.equal((await retryRejectedOrdinary()).body.code, 'message_operation_rejected');
  assert.equal((await request(ordinaryRoute)).body.messages.filter((message) => message.role === 'user').length, 3);
  const coldReplay = await startWork(firstWorkPayload.content);
  assert.equal(coldReplay.status, 200, JSON.stringify(coldReplay.body));
  assert.equal(coldReplay.body.sessionId, firstWork.body.sessionId);
  const coldEarlyReplay = await recoverEarly();
  assert.equal(coldEarlyReplay.status, 200, JSON.stringify(coldEarlyReplay.body));
  assert.equal(coldEarlyReplay.body.sessionId, earlyRecovered.body.sessionId);
  const coldAttachmentReplay = await attachmentRequest(attachmentPayload);
  assert.equal(coldAttachmentReplay.status, 200, JSON.stringify(coldAttachmentReplay.body));
  assert.equal(coldAttachmentReplay.body.sessionId, attachmentRecovered.body.sessionId);
  const coldExternalReplay = await externalRequest();
  assert.equal(coldExternalReplay.status, 200, JSON.stringify(coldExternalReplay.body));
  assert.equal(coldExternalReplay.body.sessionId, externalRecovered.body.sessionId);
  assert.equal(await countDurableUsers(), 7);
  const coldRooms = await request('/api/rooms');
  const solo = coldRooms.body.rooms.find((room) => room.type === 'solo');
  assert.equal(solo.sessions.length, 5);
  assert.ok(solo.sessions.some((session) => session.id === firstWork.body.sessionId));
  assert.ok(solo.sessions.some((session) => session.id === earlyRecovered.body.sessionId));
  assert.ok(solo.sessions.some((session) => session.id === attachmentRecovered.body.sessionId));
  assert.ok(solo.sessions.some((session) => session.id === externalRecovered.body.sessionId));
  console.log(JSON.stringify({ sessionId, rootStatus: rootPage.status, chatPageStatus: chatPage.status, sendStatus: sent.status, upstreamFailureStatus: upstreamFailure.status, upstreamFailureUserDurable: true, upstreamFailureAssistantError: true, upstreamFailureSocketMessageEnd: true, runningWhileHeld: midTurn.body.running, runningAfterReply: settled.body.running, userMessages: 3, assistantMessages: messages.filter((message) => message.role === 'assistant').length, lostOrdinaryResponse, ordinaryReplayStatus: ordinaryReplay.status, coldOrdinaryReplayStatus: coldOrdinaryReplay.status, lostResponse, lostBeforeReply, lostAttachmentResponse, lostExternalResponse, firstWorkSessionId: firstWork.body.sessionId, earlyWorkSessionId: earlyRecovered.body.sessionId, attachmentWorkSessionId: attachmentRecovered.body.sessionId, externalWorkSessionId: externalRecovered.body.sessionId, retryStatus: firstWork.status, replayStatus: replay.status, conflictStatus: conflict.status, earlyRetryStatus: earlyRecovered.status, coldReplayStatus: coldReplay.status, coldEarlyReplayStatus: coldEarlyReplay.status, coldAttachmentReplayStatus: coldAttachmentReplay.status, coldExternalReplayStatus: coldExternalReplay.status, changedAttachmentStatus: changedAttachment.status, reorderedAttachmentsStatus: reorderedAttachments.status, durableUsers: 7, localModelRequests: modelRequests, mockPort, servicePort: port }, null, 2));
} finally {
  releaseHeldModel();
  if (started) await run(cli, ['stop'], { env, timeout: 30000 }).catch(() => undefined);
  await new Promise((resolve) => mock.close(resolve));
  await rm(home, { recursive: true, force: true });
  await rm(externalRoot, { recursive: true, force: true });
}
