import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexDriver } from '../extensions/connectors/codex/driver/index.ts';
import { issueCompileSandbox } from '../apps/server/src/knowledge/compile-sandbox.ts';

if (process.platform !== 'darwin') throw new Error('T03 native protected Connector probe requires macOS');
const commandPath = process.argv[2];
const attackMode = process.argv[3] === '--attack';
if (!commandPath || !path.isAbsolute(commandPath) || await realpath(commandPath) !== commandPath) {
  throw new Error('Usage: node --import tsx scripts/verify-protected-codex-native-channel.mjs /absolute/native/codex');
}
const commandSha256 = createHash('sha256').update(await readFile(commandPath)).digest('hex');
const root = await realpath(await mkdtemp('/private/tmp/puddingteams-t03-native-channel-'));
const dirs = Object.fromEntries(['source', 'staging', 'private', 'wiki', 'control'].map(name => [name, path.join(root, name)]));
await Promise.all(Object.values(dirs).map(dir => mkdir(dir, { mode: 0o700 })));
await writeFile(path.join(dirs.source, 'input.md'), 'approved source\n');
await writeFile(path.join(dirs.wiki, 'page.md'), 'formal wiki\n');
await writeFile(path.join(dirs.control, 'secret'), 'synthetic control secret\n');
await symlink(path.join(dirs.wiki, 'page.md'), path.join(dirs.staging, 'linked-wiki.md'));
await symlink(path.join(dirs.control, 'secret'), path.join(dirs.staging, 'linked-secret'));
const calls = [];
const responseServer = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk.toString();
  const request = JSON.parse(body);
  calls.push({ method: req.method, url: req.url, model: request.model,
    toolNames: request.tools?.map(tool => tool.name).filter(Boolean),
    toolOutput: request.input?.filter?.(item => item.type === 'function_call_output').map(item => item.output) });
  if (req.method !== 'POST' || req.url !== '/v1/responses') return void res.writeHead(404).end();
  const id = `resp_${calls.length}`;
  if (attackMode && calls.length % 2 === 1) {
    const cmd = [
      `cat ${path.join(dirs.source, 'input.md')}`,
      `printf allowed > ${path.join(dirs.staging, `native-tool-${calls.length}.md`)}`,
      `cat ${path.join(dirs.control, 'secret')}`,
      `cat ${path.join(dirs.staging, 'linked-secret')}`,
      `cat ${path.join(dirs.wiki, 'page.md')}`,
      `cat ${path.join(dirs.staging, 'linked-wiki.md')}`,
      `printf attack | tee ${path.join(dirs.wiki, 'page.md')}`,
      `printf attack | tee ${path.join(dirs.staging, 'linked-wiki.md')}`,
      `nc -v -G 2 -z 127.0.0.1 ${confirmPort}`,
    ].join('; ');
    const item = { id: `fc_${calls.length}`, type: 'function_call', status: 'completed', name: 'exec_command',
      call_id: `call_${calls.length}`, arguments: JSON.stringify({ cmd, workdir: dirs.staging, login: false, max_output_tokens: 1000 }) };
    const response = { id, object: 'response', created_at: 1780000000, status: 'completed', model: 'fixture-model',
      output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, parallel_tool_calls: false };
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments },
      { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    return void res.end('data: [DONE]\n\n');
  }
  const message = { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
  const response = { id, object: 'response', created_at: 1780000000, status: 'completed', model: 'fixture-model', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, parallel_tool_calls: false };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, item_id: 'msg_1', content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'OK' },
    { type: 'response.output_text.done', output_index: 0, item_id: 'msg_1', content_index: 0, text: 'OK' },
    { type: 'response.content_part.done', output_index: 0, item_id: 'msg_1', content_index: 0, part: { type: 'output_text', text: 'OK', annotations: [] } },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response },
  ];
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve, reject) => { responseServer.once('error', reject); responseServer.listen(0, '127.0.0.1', resolve); });
let confirmConnections = 0;
const confirmServer = createServer((_req, res) => res.writeHead(200).end('confirmed'));
confirmServer.on('connection', () => { confirmConnections++; });
await new Promise((resolve, reject) => { confirmServer.once('error', reject); confirmServer.listen(0, '127.0.0.1', resolve); });
const modelPort = responseServer.address().port;
const confirmPort = confirmServer.address().port;
const issued = await issueCompileSandbox({ jobId: 'native-t03-model-channel', sourceSnapshotRoot: dirs.source,
  stagingRoot: dirs.staging, privateRoot: dirs.private, commandPath, commandSha256, modelChannel: { port: modelPort } });
const profile = await readFile(issued.sandboxProfilePath, 'utf8');
assert.ok(profile.includes(`(allow network-outbound (remote tcp "localhost:${modelPort}"))`));
assert.ok(!profile.includes(`localhost:${confirmPort}`));
const sandboxCommand = (cmd, args = [], options = {}) => spawnSync('/usr/bin/sandbox-exec', ['-f', issued.sandboxProfilePath, cmd, ...args],
  { cwd: dirs.staging, env: issued.env, encoding: 'utf8', timeout: 5_000, ...options });
try {
  const source = sandboxCommand('/bin/cat', [path.join(dirs.source, 'input.md')]);
  assert.equal(source.status, 0, source.stderr);
  assert.equal(source.stdout, 'approved source\n');
  for (const blocked of [path.join(dirs.wiki, 'page.md'), path.join(dirs.control, 'secret'),
    path.join(dirs.staging, 'linked-wiki.md'), path.join(dirs.staging, 'linked-secret')]) {
    const denied = sandboxCommand('/bin/cat', [blocked]);
    assert.notEqual(denied.status, 0, `${blocked} unexpectedly readable`);
    assert.match(denied.stderr, /Operation not permitted/);
  }
  for (const blocked of [path.join(dirs.wiki, 'page.md'), path.join(dirs.staging, 'linked-wiki.md')]) {
    const denied = sandboxCommand('/usr/bin/tee', [blocked], { input: 'attack\n' });
    assert.notEqual(denied.status, 0, `${blocked} unexpectedly writable`);
    assert.match(denied.stderr, /Operation not permitted/);
  }
  const deniedConfirm = sandboxCommand('/usr/bin/nc', ['-v', '-G', '2', '-z', '127.0.0.1', String(confirmPort)]);
  assert.notEqual(deniedConfirm.status, 0, 'confirmation port unexpectedly reachable');
  assert.match(deniedConfirm.stderr, /Operation not permitted/, JSON.stringify({ status: deniedConfirm.status, signal: deniedConfirm.signal, stdout: deniedConfirm.stdout, stderr: deniedConfirm.stderr }));
  assert.equal(confirmConnections, 0);
  const driver = new CodexDriver({ model: 'fixture-model', sandbox: 'danger-full-access', timeoutMs: 20_000 });
  const events = [];
  for await (const event of driver.run({ message: 'Reply with OK only. Do not use tools.', requestId: 'native-channel-run' },
    { cwd: dirs.staging, env: { HOST_SENTINEL: 'not-inherited' }, protectedCompile: issued })) events.push(event);
  assert.equal(events.at(-1)?.type, 'completed', JSON.stringify(events.at(-1)));
  const sessionHandle = events.at(-1)?.result?.sessionHandle;
  assert.ok(sessionHandle, 'native run must return a resumable thread');
  const continued = [];
  for await (const event of driver.continue({ message: 'Reply with OK again. Do not use tools.', requestId: 'native-channel-continue', sessionHandle },
    { cwd: dirs.staging, env: { HOST_SENTINEL: 'not-inherited' }, protectedCompile: issued })) continued.push(event);
  assert.equal(continued.at(-1)?.type, 'completed', JSON.stringify(continued.at(-1)));
  assert.equal(continued.at(-1)?.result?.sessionHandle, sessionHandle);
  assert.deepEqual(calls.map(({ method, url, model }) => ({ method, url, model })),
    Array.from({ length: attackMode ? 4 : 2 }, () => ({ method: 'POST', url: '/v1/responses', model: 'fixture-model' })));
  if (attackMode) {
    assert.ok(calls[1].toolOutput?.length, 'run must return the model-issued tool result');
    assert.ok(calls[3].toolOutput?.length, 'continue must return the model-issued tool result');
    for (const [responseIndex, commandIndex] of [[1, 1], [3, 3]]) {
      const result = calls[responseIndex].toolOutput.at(-1);
      assert.match(result, /approved source/, `native tool ${commandIndex} could not read approved source`);
      for (const denied of ['control/secret', 'staging/linked-secret', 'wiki/page.md',
        'staging/linked-wiki.md', `port ${confirmPort}`]) {
        assert.ok(result.includes(denied), `native tool ${commandIndex} omitted ${denied}`);
      }
      assert.equal((result.match(/Operation not permitted/g) ?? []).length, 7);
      assert.ok(!result.includes('synthetic control secret'), 'control-plane content escaped through tool output');
      assert.ok(!result.includes('formal wiki'), 'formal Wiki content escaped through tool output');
      assert.equal(await readFile(path.join(dirs.staging, `native-tool-${commandIndex}.md`), 'utf8'), 'allowed');
    }
  }
  assert.equal(await readFile(path.join(dirs.wiki, 'page.md'), 'utf8'), 'formal wiki\n');
  assert.equal(confirmConnections, 0);
  console.log(JSON.stringify({ root, commandPath, commandSha256, modelPort, confirmPort,
    profileSha256: issued.sandboxProfileSha256, sourceReadable: true, wikiReadDenied: true,
    wikiWriteDenied: true, linkedWikiReadDenied: true, linkedWikiWriteDenied: true,
    secretReadDenied: true, linkedSecretReadDenied: true, confirmPortDenied: true,
    attackMode, modelCalls: calls, nativeRunBoundary: events.at(-1)?.type,
    nativeContinueBoundary: continued.at(-1)?.type, sessionHandle,
    formalWikiUnchanged: true, t03Admitted: false }, null, 2));
} finally {
  await new Promise(resolve => responseServer.close(resolve));
  await new Promise(resolve => confirmServer.close(resolve));
}
