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
if (!cli || !path.isAbsolute(cli)) throw new Error('Usage: node scripts/verify-installed-manager-native-tools.mjs /absolute/path/to/puddingteams');
const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-native-tools-');
const env = { ...process.env, PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
const worker = path.join(home, 'native-worker.sh');
await writeFile(worker, `#!/bin/sh
printf '%s\\n' invoked >> '${home}/worker-invocations.log'
/bin/cat > /dev/null
printf '%s\\n' '{"status":"completed","session_id":"native-worker-session","run_id":"native-run","final_response":"委派验证完成"}'
`);
await chmod(worker, 0o700);
const sockets = new Set();
const toolNamesSeen = [];
const mock = createServer(async (req, res) => {
	if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return void res.writeHead(404).end();
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const body = JSON.parse(Buffer.concat(chunks).toString());
	const names = (body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
	if (names.length) toolNamesSeen.push(names);
	const id = `fixture-${toolNamesSeen.length}-${Date.now()}`;
	const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1780000000, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
	res.writeHead(200, { 'content-type': 'text/event-stream' });
	if (JSON.stringify(body).includes('请为下面这段对话')) {
		send({ role: 'assistant', content: '原生工具验证' });
		send({}, 'stop');
	} else if (JSON.stringify(body.messages).includes('delegate-proof') && !(body.messages ?? []).some(message => message.role === 'tool')) {
		send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-delegate-proof', type: 'function', function: { name: 'delegation', arguments: JSON.stringify({ workerId: 'puddingclaw', task: '验证委派门禁已释放' }) } }] });
		send({}, 'tool_calls');
	} else if (JSON.stringify(body.messages).includes('group-scope-check') && !(body.messages ?? []).some(message => message.role === 'tool')) {
		assert.deepEqual([...body.tools.find(tool => tool.function.name === 'delegation').function.parameters.properties.workerId.enum].sort(), ['codex', 'puddingclaw']);
		send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-group-allowed', type: 'function', function: { name: 'delegation', arguments: JSON.stringify({ workerId: 'puddingclaw', task: '范围内委派' }) } }, { index: 1, id: 'call-group-outside', type: 'function', function: { name: 'delegation', arguments: JSON.stringify({ workerId: 'pi-b', task: '范围外调用必须拒绝' }) } }] });
		send({}, 'tool_calls');
	} else if (!(body.messages ?? []).some((message) => message.role === 'tool')) {
		send({ role: 'assistant', tool_calls: [{ index: 0, id: 'call-native-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'native-proof.txt', content: 'native evidence\n' }) } }] });
		send({}, 'tool_calls');
	} else {
		send({ role: 'assistant', content: '原生写入完成。' });
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
	for (const members of [[], ['pi-b'], ['pi-b', 'pi-b']]) {
		const invalid = await request('POST', '/api/rooms', { type: 'group', members });
		assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
	}
	const group = await ok('POST', '/api/rooms', { type: 'group', members: ['puddingclaw', 'codex'], name: '范围验证群聊' });
	for (const members of [[], ['puddingclaw'], ['puddingclaw', 'puddingclaw']]) {
		const invalid = await request('PATCH', `/api/rooms/${group.room.id}`, { members });
		assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
	}
	assert.deepEqual((await ok('GET', `/api/rooms/${group.room.id}`)).room.members.map(member => member.name).sort(), ['codex', 'puddingclaw']);
	await ok('POST', `/api/sessions/${sessionId}/messages`, { content: '请直接用原生工具写入 native-proof.txt。' });
	await waitFor(async () => (await ok('GET', `/api/sessions/${sessionId}/messages`)).messages.some((message) => message.role === 'assistant' && JSON.stringify(message.content).includes('原生写入完成')), 'Manager final reply');
	// Manager 原生工具恢复：模型可见 bash/read/edit/write，且仍有委派工具。
	const exposed = new Set(toolNamesSeen.flat());
	for (const name of ['bash', 'read', 'edit', 'write']) assert.ok(exposed.has(name), `Manager 缺少原生工具 ${name}`);
	assert.ok(exposed.has('delegation'), 'Manager 缺少统一委派工具');
	// 证据台账：write 真实执行、封存为 completed + clean，并捕获 ChangeSet。
	const ledger = JSON.parse(await readFile(path.join(home, 'state', 'native-executions.json'), 'utf8'));
	assert.equal(ledger.version, 1);
	const record = ledger.executions.find((entry) => entry.toolCallId === 'call-native-write');
	assert.ok(record, 'native-executions.json 缺少 write 记录');
	assert.equal(record.toolName, 'write');
	assert.equal(record.status, 'completed');
	assert.equal(record.integrity, 'clean');
	assert.ok(record.sealedAt);
	assert.ok(record.changeSet?.changedPaths?.some((changed) => changed.endsWith('native-proof.txt')), JSON.stringify(record.changeSet));
	const written = await findFile(home, 'native-proof.txt');
	assert.ok(written, 'native-proof.txt 未落盘');
	assert.equal(await readFile(written, 'utf8'), 'native evidence\n');
	// 委派门禁：原生执行已封存，assertDelegationReady 不拦截后续流程（台账无 started/unknown）。
	assert.equal(ledger.executions.some((entry) => entry.status === 'started' || entry.status === 'unknown'), false);
	await run(cli, ['stop'], { env, timeout: 20000 });
	started = false;
	await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
	started = true;
	// 冷启动后台账仍可读且记录保持封存态（不被误判为中断）。
	const cold = JSON.parse(await readFile(path.join(home, 'state', 'native-executions.json'), 'utf8'));
	assert.equal(cold.executions.find((entry) => entry.toolCallId === 'call-native-write')?.status, 'completed');
	const freshSolo = (await ok('POST', `/api/rooms/${solo.id}/sessions`, {})).session;
	const delegateSession = freshSolo?.id ?? (await ok('GET', `/api/rooms/${solo.id}`)).room.activeSession;
	await ok('POST', `/api/sessions/${delegateSession}/model`, { model: 'fixture/fixture-model' });
	await ok('POST', `/api/sessions/${delegateSession}/messages`, { content: 'delegate-proof' });
	await waitFor(async () => (await ok('GET', `/api/sessions/${delegateSession}/messages`)).messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('原生写入完成')), 'actual delegation after cold restart');
	await ok('POST', `/api/sessions/${group.room.activeSession}/model`, { model: 'fixture/fixture-model' });
	await ok('POST', `/api/sessions/${group.room.activeSession}/messages`, { content: 'group-scope-check' });
	const groupHistory = await waitFor(async () => { const history = await ok('GET', `/api/sessions/${group.room.activeSession}/messages`); return !history.running && history.messages.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('原生写入完成')) ? history : undefined; }, 'group scope tool results');
	const invocations = (await readFile(path.join(home, 'worker-invocations.log'), 'utf8')).trim().split('\n');
	assert.equal(invocations.length, 2, 'only the two allowed fixture delegations execute');
	assert(JSON.stringify(groupHistory).includes('call-group-outside'));
	assert(/not found|未知|不存在|pi-b|enum|Invalid/i.test(JSON.stringify(groupHistory)), 'forged out-of-scope tool was not rejected');
	console.log(JSON.stringify({ home, sessionId, groupRoom: group.room.id, nativeExecution: record.id, changeSet: record.changeSet.id, changedPaths: record.changeSet.changedPaths, tools: [...exposed].filter((name) => ['bash', 'read', 'edit', 'write'].includes(name) || name === 'delegation') }, null, 2));
} finally {
	if (started) await run(cli, ['stop'], { env, timeout: 20000 }).catch(() => {});
	for (const socket of sockets) socket.destroy();
	await new Promise((resolve) => mock.close(resolve));
}
