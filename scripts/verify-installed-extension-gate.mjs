import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli)) throw new Error('Usage: node scripts/verify-installed-extension-gate.mjs /absolute/path/to/puddingteams');

const run = promisify(execFile);
const home = await mkdtemp('/private/tmp/puddingteams-extension-gate-home-');
const source = path.join(home, 'fixture-extension');
await mkdir(source);
const manifestPath = path.join(source, 'pudding-extension.json');
const manifest = (version) => ({
  id: 'fixture-extension', publisher: 'test', displayName: 'Fixture Extension', version,
  source: 'external', kind: 'capability', engines: { puddingteams: '>=1 <2' }, entry: 'index.mjs',
  capability: { id: 'fixture-extension', displayName: 'Fixture Extension', apiVersion: '1', tools: [{ name: 'check', activation: 'always' }] },
});
await writeFile(manifestPath, JSON.stringify(manifest('1.0.0')));
await writeFile(path.join(source, 'index.mjs'), 'export const extension = { manifest: { id: "fixture-extension", kind: "capability", name: "Fixture", version: "1", tools: [{ name: "check", activation: "always" }] }, register() {} };');

const env = { ...process.env, HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
const reserve = createServer();
await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
const request = async (method, route, body) => {
  const response = await fetch(base + route, {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: await response.json() };
};

let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const enabled = await request('PUT', '/api/extensions/developer-mode', { enabled: true });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const installed = await request('POST', '/api/extensions/install', { path: source });
  assert.equal(installed.status, 200, JSON.stringify(installed.body));
  const initial = await request('GET', '/api/agents/manager/extensions');
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  const bound = await request('POST', '/api/agents/manager/extensions', {
    extensionId: 'fixture-extension', capabilityId: 'fixture-extension', expectedRevision: initial.body.revision,
  });
  assert.equal(bound.status, 200, JSON.stringify(bound.body));
  const afterBinding = await request('GET', '/api/agents/manager/extensions');
  assert.equal(afterBinding.body.revision, initial.body.revision + 1);

  await writeFile(manifestPath, JSON.stringify(manifest('1.0.1')));
  const updated = await request('POST', '/api/extensions/fixture-extension/update', {});
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const afterUpdate = await request('GET', '/api/agents/manager/extensions');
  assert.equal(afterUpdate.body.revision, afterBinding.body.revision + 1);
  const disabled = await request('PUT', '/api/extensions/developer-mode', { enabled: false });
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  const afterDisable = await request('GET', '/api/agents/manager/extensions');
  assert.equal(afterDisable.body.revision, afterUpdate.body.revision + 1);
  const catalog = await request('GET', '/api/extensions/catalog?kind=capability');
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.extensions.find((entry) => entry.manifest.id === 'fixture-extension')?.loaded, false);
  const managerPatch = await request('PATCH', '/api/agents/manager/manager', {
    description: 'Installed Manager PATCH', expectedRevision: afterDisable.body.revision,
  });
  assert.equal(managerPatch.status, 200, JSON.stringify(managerPatch.body));
  assert.equal(managerPatch.body.revision, afterDisable.body.revision + 1);
  await run(cli, ['stop'], { env, timeout: 20000 });
  started = false;
  const pending = path.join(home, 'state', 'extension-mutation-pending.json');
  await writeFile(pending, JSON.stringify({ version: 1, agentIds: ['manager'] }) + '\n');
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const afterRecovery = await request('GET', '/api/agents/manager/extensions');
  assert.equal(afterRecovery.body.revision, managerPatch.body.revision + 1, '启动必须先完成 Extension 待对账修订');
  await assert.rejects(() => access(pending), { code: 'ENOENT' });
  console.log(JSON.stringify({ home, cli, initialRevision: initial.body.revision, bindingRevision: afterBinding.body.revision, updateRevision: afterUpdate.body.revision, developerModeOffRevision: afterDisable.body.revision, managerPatchRevision: managerPatch.body.revision, recoveryRevision: afterRecovery.body.revision }, null, 2));
} finally {
  if (started) await run(cli, ['stop'], { env, timeout: 20000 }).catch(() => {});
}
