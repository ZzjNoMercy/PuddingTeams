import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli)) throw new Error('Usage: node scripts/verify-installed-mcp-secret-sigkill.mjs /absolute/path/to/puddingteams');
const childPath = path.join(process.cwd(), 'apps/server/scripts/mcp-secret-sigkill-child.ts');
const run = promisify(execFile);
const results = [];

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

for (const phase of ['before-catalog', 'after-catalog']) {
  const home = await mkdtemp('/private/tmp/puddingteams-mcp-secret-');
  const child = spawnSync(process.execPath, ['--import', 'tsx', childPath, home, 'update', phase], {
    cwd: path.join(process.cwd(), 'apps/server'), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(child.signal, 'SIGKILL', `${phase}: ${child.status}\n${child.stderr}`);
  const port = await freePort();
  const env = { ...process.env, HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
  let started = false;
  try {
    await run(cli, ['start', '--port', String(port)], { env, timeout: 30_000 });
    started = true;
    const response = await fetch(`http://127.0.0.1:${port}/api/extensions/mcp/servers`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200);
    const server = (await response.json()).servers.find((item) => item.id === 'docs');
    const expected = phase === 'before-catalog' ? 'Old' : 'New';
    assert.equal(server?.displayName, expected);
    assert.deepEqual(server?.secretKeys, ['API_TOKEN']);
    await assert.rejects(() => access(path.join(home, 'secrets', 'mcp', 'binding-transaction.json')), { code: 'ENOENT' });
    results.push({ phase, home, expectedCatalog: expected, pendingCleared: true });
  } finally {
    if (started) await run(cli, ['stop'], { env, timeout: 20_000 }).catch(() => {});
  }
}
{
  const home = await mkdtemp('/private/tmp/puddingteams-mcp-agent-');
  const agentChild = spawnSync(process.execPath, ['--import', 'tsx', path.join(process.cwd(), 'apps/server/scripts/mcp-agent-sigkill-child.ts'), home], {
    cwd: path.join(process.cwd(), 'apps/server'), encoding: 'utf8', timeout: 30_000,
  });
  assert.equal(agentChild.signal, 'SIGKILL', `agent: ${agentChild.status}\n${agentChild.stderr}`);
  const before = JSON.parse(await readFile(path.join(home, 'state', 'agents.json'), 'utf8')).agents.find((item) => item.name === 'pi-b');
  assert.ok(before);
  const port = await freePort();
  const env = { ...process.env, HOME: home, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, 'agent-dir'), PI_OFFLINE: '1' };
  let started = false;
  try {
    await run(cli, ['start', '--port', String(port)], { env, timeout: 30_000 });
    started = true;
    const agentResponse = await fetch(`http://127.0.0.1:${port}/api/agents`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(agentResponse.status, 200);
    const after = (await agentResponse.json()).agents.find((item) => item.name === 'pi-b');
    assert.equal(after.extensionRevision, before.extensionRevision + 1);
    assert.equal(after.runConfigRevision, before.runConfigRevision + 1);
    await assert.rejects(() => access(path.join(home, 'state', 'mcp-mutation-pending.json')), { code: 'ENOENT' });
    results.push({ phase: 'after-catalog-before-agent-revision', home, beforeRevision: before.runConfigRevision, afterRevision: after.runConfigRevision, pendingCleared: true });
  } finally {
    if (started) await run(cli, ['stop'], { env, timeout: 20_000 }).catch(() => {});
  }
}
console.log(JSON.stringify({ cli, results }, null, 2));
