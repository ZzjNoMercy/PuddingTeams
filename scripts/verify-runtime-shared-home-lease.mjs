import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

const bundle = path.resolve(process.argv[2] ?? 'packages/puddingteams-cli/runtime/apps/server/src/server.bundle.mjs');
const home = await mkdtemp('/private/tmp/puddingteams-shared-home-');
const directory = path.join(home, 'runtime', 'backend.leases');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function start(port) {
  const child = spawn(process.execPath, [bundle], {
    env: { ...process.env, PUDDINGTEAMS_HOME: home, PORT: String(port), PI_OFFLINE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return { child, port, output: () => output };
}

async function waitHealth(port, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`server exited before health: ${child.exitCode ?? child.signalCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(300) });
      if (response.ok) return;
    } catch { /* waiting for startup */ }
    await sleep(100);
  }
  throw new Error(`health timeout on port ${port}`);
}

async function waitExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('process exit timeout')), 15_000);
    timeout.unref();
    child.once('exit', (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
  });
}

const firstPort = await freePort();
const secondPort = await freePort();
const thirdPort = await freePort();
let first;
let second;
let third;
let fourth;
let fifth;
let sixth;
try {
  first = start(firstPort);
  await waitHealth(firstPort, first.child);
  second = start(secondPort);
  const refused = await waitExit(second.child);
  assert.notEqual(refused.code, 0, second.output());
  assert.match(second.output(), /同一数据目录拒绝第二个实例/);
  assert.equal((await readdir(directory)).length, 1);
  assert.equal((await fetch(`http://127.0.0.1:${firstPort}/api/health`)).status, 200);

  first.child.kill('SIGKILL');
  const killed = await waitExit(first.child);
  assert.equal(killed.signal, 'SIGKILL');
  third = start(thirdPort);
  await waitHealth(thirdPort, third.child);
  const files = await readdir(directory);
  assert.equal(files.length, 1, `stale candidate not reclaimed: ${files.join(', ')}`);
  const recovered = JSON.parse(await readFile(path.join(directory, files[0]), 'utf8'));
  assert.equal(recovered.pid, third.child.pid);

  third.child.kill('SIGTERM');
  await waitExit(third.child);
  fourth = start(await freePort());
  fifth = start(await freePort());
  const race = await Promise.allSettled([
    waitHealth(fourth.port, fourth.child),
    waitHealth(fifth.port, fifth.child),
  ]);
  const acquired = race.filter((result) => result.status === 'fulfilled').length;
  assert.ok(acquired <= 1, `two contenders acquired same Home: ${race.map((result) => result.status).join(', ')}`);
  if (acquired === 0) {
    sixth = start(await freePort());
    await waitHealth(sixth.port, sixth.child);
  }
  console.log(JSON.stringify({ home, bundle, firstPid: first.child.pid, refusedSecond: refused.code, firstSignal: killed.signal, recoveredPid: third.child.pid, liveLeaseCount: files.length, simultaneousWinners: acquired }, null, 2));
} finally {
  for (const current of [first, second, third, fourth, fifth, sixth]) {
    if (current && current.child.exitCode === null && current.child.signalCode === null) current.child.kill('SIGTERM');
  }
}
