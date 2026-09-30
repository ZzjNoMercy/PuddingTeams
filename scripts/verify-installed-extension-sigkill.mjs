import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli)) throw new Error('Usage: node scripts/verify-installed-extension-sigkill.mjs /absolute/path/to/puddingteams');
const home = await mkdtemp('/private/tmp/puddingteams-extension-sigkill-');
const childPath = path.join(process.cwd(), 'apps/server/scripts/extension-sigkill-child.ts');
const child = spawnSync(process.execPath, ['--import', 'tsx', childPath, home], {
  cwd: path.join(process.cwd(), 'apps/server'), encoding: 'utf8', timeout: 30000,
});
assert.equal(child.signal, 'SIGKILL', `fixture child must die at revision write: ${child.status}\n${child.stderr}`);

const registry = JSON.parse(await readFile(path.join(home, 'extensions', 'registry.json'), 'utf8'));
const installed = registry.extensions.find((entry) => entry.manifest.id === 'fixture-extension');
assert.equal(installed?.version, '1.0.1', 'new Extension version must be durable before SIGKILL');
const agents = JSON.parse(await readFile(path.join(home, 'state', 'agents.json'), 'utf8'));
const before = agents.agents.find((agent) => agent.name === 'pi-b');
assert.ok(before);
assert.equal(before.extensionRevision, 2, 'Agent revision must still be old at SIGKILL');
assert.equal(before.runConfigRevision, 2);
const pendingPath = path.join(home, 'state', 'extension-mutation-pending.json');
const pending = JSON.parse(await readFile(pendingPath, 'utf8'));
assert.deepEqual(pending.agentIds, ['pi-b']);

const run = promisify(execFile);
const env = { ...process.env, HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
const reserve = createServer();
await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const base = `http://127.0.0.1:${port}`;
let started = false;
try {
  await run(cli, ['start', '--port', String(port)], { env, timeout: 30000 });
  started = true;
  const agentResponse = await fetch(base + '/api/agents', { signal: AbortSignal.timeout(15000) });
  assert.equal(agentResponse.status, 200);
  const after = (await agentResponse.json()).agents.find((agent) => agent.name === 'pi-b');
  assert.equal(after.extensionRevision, before.extensionRevision + 1);
  assert.equal(after.runConfigRevision, before.runConfigRevision + 1);
  await assert.rejects(() => access(pendingPath), { code: 'ENOENT' });
  const catalogResponse = await fetch(base + '/api/extensions/catalog?kind=capability', { signal: AbortSignal.timeout(15000) });
  assert.equal(catalogResponse.status, 200);
  const extension = (await catalogResponse.json()).extensions.find((entry) => entry.manifest.id === 'fixture-extension');
  assert.equal(extension?.version, '1.0.1');
  assert.equal(extension?.loaded, true);
  console.log(JSON.stringify({ home, cli, childSignal: child.signal, durableExtensionVersion: installed.version, revisionAtKill: before.runConfigRevision, revisionAfterRestart: after.runConfigRevision, pendingCleared: true }, null, 2));
} finally {
  if (started) await run(cli, ['stop'], { env, timeout: 20000 }).catch(() => {});
}
