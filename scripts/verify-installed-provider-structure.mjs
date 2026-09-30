import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli)) throw new Error('Usage: node scripts/verify-installed-provider-structure.mjs /absolute/path/to/installed/bin/puddingteams');
const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-provider-structure-');
const agentDir = path.join(home, 'agent-dir');
const env = { PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1' };
const reserve = createServer();
await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
const request = async (method, route, body, headers = {}) => {
  const response = await fetch(base + route, {
    method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000),
  });
  return { status: response.status, body: await response.json() };
};
let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const initial = await request('GET', '/api/providers/custom');
  assert.equal(initial.status, 200);
  const valid = await request('PUT', '/api/providers/custom/fixture', { expectedRevision: initial.body.revision, name: 'Fixture', baseUrl: 'http://127.0.0.1/v1', api: 'openai-completions', models: [{ id: 'model' }] });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
  const file = path.join(agentDir, 'models.json');
  const malformed = '{"providers":{"fixture":{"models":[null]}}}\n';
  await writeFile(file, malformed);
  const listed = await request('GET', '/api/providers/custom');
  assert.equal(listed.status, 422);
  assert.equal(listed.body.code, 'provider_catalog_invalid');
  const save = await request('PUT', '/api/providers/custom/another', { expectedRevision: initial.body.revision, name: 'Another', baseUrl: 'http://127.0.0.1/v1', api: 'openai-completions', models: [{ id: 'model' }] });
  assert.equal(save.status, 422);
  assert.match(save.body.error, /models.json providers/);
  const remove = await request('DELETE', '/api/providers/custom/fixture', undefined, { 'x-expected-revision': initial.body.revision });
  assert.equal(remove.status, 422);
  assert.match(remove.body.error, /models.json providers/);
  assert.equal(await readFile(file, 'utf8'), malformed, 'malformed external bytes must not be rewritten');
  console.log(JSON.stringify({ home, listedStatus: listed.status, saveStatus: save.status, deleteStatus: remove.status, originalBytesPreserved: true }, null, 2));
} finally {
  if (started) await run(cli, ['stop'], { env, timeout: 30000 }).catch(() => undefined);
}
