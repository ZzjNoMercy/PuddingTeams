import { registerPuddingClawFixture } from './installed-worker-fixture.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

// 第一阶段安装态验证：Manager 原生工具恢复（write 真实落盘）、
// NativeExecution 证据台账封存、群聊人数与范围约束、实际委派。
const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli)) throw new Error('Usage: node scripts/verify-installed-delegation-single-use.mjs /absolute/path/to/puddingteams');
const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-native-tools-');
const env = { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
const worker = path.join(home, 'native-worker.sh');
await writeFile(worker, `#!/bin/sh
printf '%s\\n' invoked >> '${home}/worker-invocations.log'
/bin/cat > /dev/null
workerCount=$(/usr/bin/wc -l < '${home}/worker-invocations.log' | /usr/bin/tr -d ' ')
printf '{"status":"completed","session_id":"fresh-%s","run_id":"run-%s","final_response":"${process.argv[3] === "large" ? "x".repeat(100000) : "委派验证完成"}"}\\n' "$workerCount" "$workerCount"
`);
await chmod(worker, 0o700);
const sockets = new Set();
const toolNamesSeen = [];
const mock = createServer(async (req, res) => {
 if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
 const chunks = []; for await (const chunk of req) chunks.push(chunk);
 const body = JSON.parse(Buffer.concat(chunks).toString());
 const names = (body.tools ?? []).map(tool => tool.function.name); if (names.length) toolNamesSeen.push(names);
 const messages = body.messages ?? []; const text = JSON.stringify(messages);
 const latestUser = messages.findLastIndex(message => message.role === 'user' && /fresh-one|fresh-two/.test(JSON.stringify(message.content)));
 const answered = messages.slice(latestUser + 1).some(message => message.role === 'tool');
 const id = `fixture-${Date.now()}`;
 const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1780000000, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
 res.writeHead(200, { 'content-type': 'text/event-stream' });
 if (text.includes('请为下面这段对话')) { send({ role: 'assistant', content: '单次委派验证' }); send({}, 'stop'); }
 else if (!answered) {
  assert(names.includes('delegation')); assert(!names.some(name => name.endsWith('__delegate')));
  const sequence = text.includes('fresh-two') ? 2 : 1;
  send({ role: 'assistant', tool_calls: [{ index: 0, id: `call-fresh-${sequence}`, type: 'function', function: { name: 'delegation', arguments: JSON.stringify({ workerId: 'puddingclaw', task: `explicit-task-${sequence}` }) } }] }); send({}, 'tool_calls');
 } else { send({ role: 'assistant', content: '单次委派已完成。' }); send({}, 'stop'); }
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
const request = async (method, route, body) => {
	const headers = body === undefined ? {} : { 'content-type': 'application/json' };
	if (method === 'POST' && (/^\/api\/sessions\/[^/]+\/messages$/.test(route) || route === '/api/rooms')) headers['idempotency-key'] = randomUUID();
	const response = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
	return { status: response.status, body: await response.json().catch(() => ({})) };
};
const ok = async (method, route, body) => { const result = await request(method, route, body); assert.equal(result.status, 200, `${method} ${route}: ${JSON.stringify(result.body)}`); return result.body; };
const waitFor = async (fn, label, timeout = 20000) => {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const result = await fn();
		if (result) return result;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timeout waiting for ${label}`);
};
const findFile = async (dir, name) => {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) { const found = await findFile(full, name).catch(() => undefined); if (found) return found; }
		else if (entry.name === name) return full;
	}
	return undefined;
};
let started = false;
try {
	await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
	started = true;
	const catalog = await ok('GET', '/api/providers/custom');
	await ok('PUT', '/api/providers/custom/fixture', { expectedRevision: catalog.revision, name: 'Fixture', baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: 'openai-completions', models: [{ id: 'fixture-model' }] });
	await ok('POST', '/api/providers/fixture/key', { apiKey: 'fixture-only' });
	const solo = (await ok('GET', '/api/rooms')).rooms.find((room) => room.type === 'solo');
	assert.ok(solo?.activeSession);
	const sessionId = solo.activeSession;
	await ok('POST', `/api/sessions/${sessionId}/model`, { model: 'fixture/fixture-model' });
	await registerPuddingClawFixture(base, worker);
	const group = (await ok('POST', '/api/rooms', { type: 'group', members: ['puddingclaw', 'codex'] })).room;
	await ok('POST', `/api/sessions/${group.activeSession}/model`, { model: 'fixture/fixture-model' });
	for (const content of ['fresh-one', 'fresh-two']) {
	 await ok('POST', `/api/sessions/${group.activeSession}/messages`, { content });
	 await waitFor(async () => { const history = await ok('GET', `/api/sessions/${group.activeSession}/messages`); return !history.running && history.messages.filter(message => message.role === 'assistant' && JSON.stringify(message.content).includes('单次委派已完成')).length === (content === 'fresh-one' ? 1 : 2); }, content);
	}
	const readRecords = async () => Object.values(JSON.parse(await readFile(path.join(home, 'state', 'delegations.json'), 'utf8')).delegations);
	const records = (await readRecords()).filter(record => record.managerSessionId === group.activeSession);
	assert.equal(records.length, 2); assert.equal(new Set(records.map(record => record.id)).size, 2);
	assert(records.every(record => record.operation === 'run' && record.invocationKind === 'manager_tool' && record.windowId === group.id));
	assert.equal(new Set(records.map(record => record.operationId)).size, 2);
	assert.equal(new Set(records.map(record => record.sessionHandle)).size, 2);
	if (process.argv[3] === 'large') for (const record of records) { assert.equal(record.result.content.length, 100000); assert.equal((await readFile(path.join(home, 'state', 'large-worker-results', record.id + '.txt'), 'utf8')).length, 100000); }
	assert.equal((await ok('GET', '/api/rooms')).rooms.some(room => room.type === 'direct'), false);
	assert.equal(Object.hasOwn((await ok('GET', `/api/rooms/${group.id}`)).room, 'workerSessions'), false);
	for (const record of records) { await ok('GET', `/api/delegations/${record.id}/process`); await ok('GET', `/api/delegations/${record.id}/process/timeline`); }
	const denied = await request('POST', `/api/sessions/${records[0].sessionHandle}/messages`, { content: '不得续写' }); assert.equal(denied.status, 410);
 const index=(await ok('GET',`/api/delegation-records?sourceSessionId=${group.activeSession}&workerId=puddingclaw`)).delegations;
 assert.deepEqual(new Set(index.map(item=>item.delegationId)),new Set(records.map(record=>record.id)));
 assert.equal((await ok('GET',`/api/delegation-records?sourceSessionId=${sessionId}`)).delegations.length,0);
 for(const operation of [
  ['GET',`/api/sessions/${records[0].sessionHandle}/messages`,undefined,410],
  ['POST',`/api/rooms/${group.id}/sessions/${records[0].sessionHandle}/activate`,{},400],
  ['PATCH',`/api/rooms/${group.id}/sessions/${records[0].sessionHandle}`,{name:'forbidden'},404],
  ['DELETE',`/api/rooms/${group.id}/sessions/${records[0].sessionHandle}`,{},404],
 ]) { const [method,url,payload,status]=operation;assert.equal((await request(method,url,payload)).status,status); }
 assert.equal((await ok('GET',`/api/rooms/${group.id}`)).room.activeSession,group.activeSession);

	const count = (await readFile(path.join(home, 'worker-invocations.log'), 'utf8')).trim().split('\n').length;
	assert.equal(count, 2);
	await run(cli, ['stop'], { env, timeout: 20000 }); started = false;
	await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 }); started = true;
	await new Promise(resolve => setTimeout(resolve, 2500));
	assert.equal((await readRecords()).filter(record => record.managerSessionId === group.activeSession).length, 2);
	assert.equal((await readFile(path.join(home, 'worker-invocations.log'), 'utf8')).trim().split('\n').length, 2, 'cold recovery never reruns Worker');
	const outbox = JSON.parse(await readFile(path.join(home, 'state', 'delegation-delivery.json'), 'utf8'));
	assert.equal(outbox.deliveries.length, 2); assert(outbox.deliveries.every(record => record.kind === 'tool_result' && record.state === 'appended'));
	console.log(JSON.stringify({ home, group: group.id, session: group.activeSession, ids: records.map(record => record.id), operations: records.map(record => record.operationId), driverStarts: count, deliveries: outbox.deliveries }, null, 2));

} finally {
	if (started) await run(cli, ['stop'], { env, timeout: 20000 }).catch(() => {});
	for (const socket of sockets) socket.destroy();
	await new Promise((resolve) => mock.close(resolve));
}
