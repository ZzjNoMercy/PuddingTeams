import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

// Synthetic T03 probe. This tests an OS process boundary, not a product profile.
const run = promisify(execFile);
const root = await mkdtemp('/private/tmp/puddingteams-t03-');
const source = path.join(root, 'source');
const staging = path.join(root, 'staging');
const wiki = path.join(root, 'wiki');
const control = path.join(root, 'control');
await Promise.all([source, staging, wiki, control].map((dir) => mkdir(dir)));
await writeFile(path.join(source, 'input.md'), 'synthetic source\n');
await writeFile(path.join(wiki, 'page.md'), 'protected wiki\n');
await writeFile(path.join(control, 'secret'), 'synthetic secret\n');
let confirmCalls = 0;
const server = createServer((_request, response) => {
  confirmCalls++;
  response.writeHead(200).end('synthetic confirmation endpoint');
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const url = `http://127.0.0.1:${server.address().port}/confirm`;
const quoted = (value) => JSON.stringify(value);
const profile = path.join(root, 'worker.sb');
await writeFile(profile, `(version 1)
(allow default)
(deny file-read* (subpath ${quoted(control)}))
(deny file-read* (subpath ${quoted(wiki)}))
(deny file-write* (subpath ${quoted(control)}))
(deny file-write* (subpath ${quoted(wiki)}))
(deny network*)
`);
assert.equal((await readFile(path.join(control, 'secret'), 'utf8')).trim(), 'synthetic secret');
assert.equal((await fetch(url)).status, 200, 'mock confirm endpoint must be reachable without isolation');
assert.equal(confirmCalls, 1);
const probe = async (label, command, expected) => {
  let result;
  let failure;
  try {
    result = await run('/usr/bin/sandbox-exec', ['-f', profile, '/bin/sh', '-c', command], { timeout: 5000 });
  } catch (error) {
    failure = error;
  }
  if (expected === 'allowed') {
    assert.ifError(failure);
    return { label, result: 'allowed', stdout: result.stdout.trim() };
  }
  assert.ok(failure, `${label} unexpectedly succeeded: ${result?.stdout ?? ''}`);
  assert.notEqual(failure.killed, true, `${label} timed out rather than being denied`);
  const diagnostic = `${failure.stderr ?? ''}`;
  assert.match(diagnostic, /operation not permitted|permission denied|sandbox/i, `${label} failed without a sandbox denial: ${diagnostic}`);
  return { label, result: 'denied', exitCode: failure.code, diagnostic: diagnostic.trim() };
};
try {
  const results = [];
  results.push(await probe('read approved source', `/bin/cat ${quoted(path.join(source, 'input.md'))}`, 'allowed'));
  results.push(await probe('write staging', `/bin/sh -c 'echo draft > ${quoted(path.join(staging, 'draft.md'))}'`, 'allowed'));
  results.push(await probe('start installed Codex CLI', '/Users/pet/.npm-global/bin/codex --version', 'allowed'));
  results.push(await probe('read control secret', `/bin/cat ${quoted(path.join(control, 'secret'))}`, 'denied'));
  results.push(await probe('read formal wiki', `/bin/cat ${quoted(path.join(wiki, 'page.md'))}`, 'denied'));
  results.push(await probe('write formal wiki', `/bin/sh -c 'echo attack > ${quoted(path.join(wiki, 'page.md'))}'`, 'denied'));
  results.push(await probe('call local confirm API', `/usr/bin/curl --fail --show-error --verbose --max-time 2 ${quoted(url)}`, 'denied'));
  assert.equal(await readFile(path.join(wiki, 'page.md'), 'utf8'), 'protected wiki\n');
  assert.equal(await readFile(path.join(staging, 'draft.md'), 'utf8'), 'draft\n');
  assert.equal(confirmCalls, 1, 'sandboxed Worker must not add a confirmation call');
  process.stdout.write(JSON.stringify({ root, results, wikiUnchanged: true, unconfinedConfirmCalls: 1, sandboxedConfirmCalls: 0 }, null, 2) + '\n');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
