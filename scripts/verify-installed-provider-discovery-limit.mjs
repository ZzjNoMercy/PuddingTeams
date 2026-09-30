import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli)) throw new Error('Usage: node scripts/verify-installed-provider-discovery-limit.mjs /absolute/path/to/installed/bin/puddingteams');
const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-provider-discovery-');
const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
const upstream = createHttpServer((req, res) => {
  if (req.url === '/small/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
    return;
  }
  if (req.url === '/large/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'fixture-model' }], padding: 'x'.repeat(1_100_000) }));
    return;
  }
  if (req.url === '/chunked/models') {
    res.writeHead(200, { 'content-type': 'application/json', 'transfer-encoding': 'chunked' });
    res.write('{"data":[{"id":"fixture-model"}],"padding":"');
    res.write('x'.repeat(600_000));
    res.end(`${'x'.repeat(500_000)}"}`);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
const reserve = createTcpServer();
await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const request = async (route, endpoint) => {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: `${upstreamBase}/${endpoint}` }), signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  return response.json();
};
let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const normal = await request('/api/providers/discover', 'small');
  assert.equal(normal.ok, true);
  assert.deepEqual(normal.models, [{ id: 'fixture-model' }]);
  for (const endpoint of ['large', 'chunked']) {
    const result = await request('/api/providers/discover', endpoint);
    assert.equal(result.ok, false, endpoint);
    assert.match(result.error ?? '', /过大/, endpoint);
    assert.deepEqual(result.models, [], endpoint);
  }
  const test = await request('/api/providers/test', 'large');
  assert.equal(test.ok, true);
  assert.equal(Object.hasOwn(test, 'body'), false);
  console.log(JSON.stringify({ home, normalModels: normal.models.length, oversizedModesRejected: ['content-length', 'chunked'], connectionTestStatusOnly: true }, null, 2));
} finally {
  if (started) await run(cli, ['stop'], { env, timeout: 30000 }).catch(() => undefined);
  await new Promise((resolve) => upstream.close(resolve));
}
