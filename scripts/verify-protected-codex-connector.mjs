import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexDriver } from '../extensions/connectors/codex/driver/index.ts';
import { issueCompileSandbox } from '../apps/server/src/knowledge/compile-sandbox.ts';

if (process.platform !== 'darwin') throw new Error('T03 protected Connector probe requires macOS sandbox-exec');
const root = await realpath(await mkdtemp('/private/tmp/puddingteams-t03-codex-connector-'));
const dirs = Object.fromEntries(['trusted', 'private', 'source', 'staging', 'wiki', 'control'].map((name) => [name, path.join(root, name)]));
await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { mode: 0o700 })));
await writeFile(path.join(dirs.source, 'input.md'), 'approved source\n');
await writeFile(path.join(dirs.wiki, 'page.md'), 'formal wiki\n');
await writeFile(path.join(dirs.control, 'secret'), 'synthetic control secret\n');
await symlink(path.join(dirs.control, 'secret'), path.join(dirs.staging, 'linked-secret'));
await symlink(path.join(dirs.wiki, 'page.md'), path.join(dirs.staging, 'linked-wiki.md'));

let confirmCalls = 0;
let confirmConnections = 0;
const server = createServer((_request, response) => { confirmCalls++; response.writeHead(200).end('confirmed'); });
server.on('connection', () => { confirmConnections++; });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const confirmUrl = `http://127.0.0.1:${server.address().port}/confirm`;
assert.equal((await fetch(confirmUrl)).status, 200, 'mock confirm must be reachable outside the sandbox');
assert.equal(confirmCalls, 1);
const command = path.join(dirs.trusted, 'fake-codex');
const fakeCli = `#!/bin/sh
set +e
printf '%s\\n' "$@" > "$STAGING/cli-args.txt"
/bin/cat "$SOURCE/input.md" > "$STAGING/source-observed.txt" 2> "$STAGING/source-error.txt"
echo $? > "$STAGING/source-status.txt"
echo draft > "$STAGING/draft.md"
echo $? > "$STAGING/staging-status.txt"
/bin/cat "$CONTROL/secret" > "$STAGING/secret-observed.txt" 2> "$STAGING/secret-error.txt"
echo $? > "$STAGING/secret-status.txt"
/bin/cat "$STAGING/linked-secret" > "$STAGING/linked-secret-observed.txt" 2> "$STAGING/linked-secret-error.txt"
echo $? > "$STAGING/linked-secret-status.txt"
/bin/cat "$WIKI/page.md" > "$STAGING/wiki-observed.txt" 2> "$STAGING/wiki-error.txt"
echo $? > "$STAGING/wiki-read-status.txt"
/bin/cat "$STAGING/linked-wiki.md" > "$STAGING/linked-wiki-observed.txt" 2> "$STAGING/linked-wiki-error.txt"
echo $? > "$STAGING/linked-wiki-status.txt"
echo attack > "$WIKI/page.md" 2> "$STAGING/wiki-write-error.txt"
echo $? > "$STAGING/wiki-write-status.txt"
echo attack > "$STAGING/linked-wiki.md" 2> "$STAGING/linked-wiki-write-error.txt"
echo $? > "$STAGING/linked-wiki-write-status.txt"
/usr/bin/nc -v -G 2 -z 127.0.0.1 "$CONFIRM_PORT" > "$STAGING/confirm-observed.txt" 2> "$STAGING/confirm-error.txt"
echo $? > "$STAGING/confirm-status.txt"
(printenv HOST_SENTINEL || echo absent) > "$STAGING/host-env.txt"
printf '%s\\n' '{"type":"thread.started","thread_id":"synthetic-protected-thread"}' '{"type":"turn.started"}' '{"type":"item.completed","item":{"type":"agent_message","text":"synthetic protected connector"}}' '{"type":"turn.completed"}'
`;
await writeFile(command, fakeCli);
await chmod(command, 0o755);
const hash = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const issued = await issueCompileSandbox({ jobId: 'synthetic-t03-job', sourceSnapshotRoot: dirs.source, stagingRoot: dirs.staging, privateRoot: dirs.private, commandPath: command, commandSha256: await hash(command) });
assert.deepEqual(Object.keys(issued.env).sort(), ['HOME', 'PATH', 'TEMP', 'TMP', 'TMPDIR']);
const ctx = {
  cwd: dirs.staging,
  env: { PATH: '/usr/bin:/bin', HOST_SENTINEL: 'host-secret-must-not-leak' },
  protectedCompile: {
    ...issued,
    // Synthetic attack coordinates only; the issuer's production environment
    // above contains exactly five non-secret OS variables.
    env: { ...issued.env, SOURCE: dirs.source, STAGING: dirs.staging, WIKI: dirs.wiki, CONTROL: dirs.control, CONFIRM_PORT: String(server.address().port) },
  },
};
const driver = new CodexDriver({ sandbox: 'danger-full-access' });
async function collect(events) { const result = []; for await (const event of events) result.push(event); return result; }
try {
  const inspect = async (label) => {
    const args = (await readFile(path.join(dirs.staging, 'cli-args.txt'), 'utf8')).trimEnd().split('\n');
    const policy = ['-s', 'danger-full-access', '-c', 'approval_policy="never"', '--ignore-user-config', '--ignore-rules'];
    assert.deepEqual(args, label === 'run'
      ? ['exec', '--json', '--skip-git-repo-check', '-C', dirs.staging, ...policy, 'synthetic attack']
      : ['exec', ...policy, 'resume', '--json', '--skip-git-repo-check', 'synthetic-protected-thread', 'synthetic attack']);
    const status = async (name) => Number((await readFile(path.join(dirs.staging, `${name}-status.txt`), 'utf8')).trim());
    assert.equal(await status('source'), 0, `${label}: approved source should be readable`);
    assert.equal(await status('staging'), 0, `${label}: staging should be writable`);
    for (const name of ['secret', 'linked-secret', 'wiki-read', 'linked-wiki', 'wiki-write', 'linked-wiki-write', 'confirm']) assert.notEqual(await status(name), 0, `${label}: ${name} unexpectedly allowed`);
    assert.equal((await readFile(path.join(dirs.staging, 'host-env.txt'), 'utf8')).trim(), 'absent', `${label}: host env leaked`);
    for (const name of ['secret', 'linked-secret', 'wiki', 'linked-wiki', 'confirm']) assert.match(await readFile(path.join(dirs.staging, `${name}-error.txt`), 'utf8'), /Operation not permitted/i, `${label}: ${name} failed for an unrelated reason`);
    assert.equal(await readFile(path.join(dirs.wiki, 'page.md'), 'utf8'), 'formal wiki\n');
    assert.equal(confirmCalls, 1, `${label}: mock confirm request reached server`);
    assert.equal(confirmConnections, 1, `${label}: sandbox connected to mock confirm socket`);
    return { policyArgvValidated: true, sourceAllowed: true, stagingWritable: true, controlSecretDenied: true, formalWikiReadDenied: true, formalWikiWriteDenied: true, linkedSecretDenied: true, linkedWikiReadDenied: true, linkedWikiWriteDenied: true, localConfirmSocketDenied: true, hostEnvAbsent: true };
  };
  const run = await collect(driver.run({ message: 'synthetic attack', requestId: 'run' }, ctx));
  assert.equal(run.at(-1)?.type, 'completed', `run: ${JSON.stringify(run.at(-1))}`);
  const runAttack = await inspect('run');
  // A continuation must generate its own evidence rather than reuse run files.
  await Promise.all(['source', 'staging', 'secret', 'linked-secret', 'wiki-read', 'linked-wiki', 'wiki-write', 'linked-wiki-write', 'confirm'].map((name) => rm(path.join(dirs.staging, `${name}-status.txt`))));
  await Promise.all(['secret', 'linked-secret', 'wiki', 'linked-wiki', 'confirm'].map((name) => rm(path.join(dirs.staging, `${name}-error.txt`))));
  await rm(path.join(dirs.staging, 'host-env.txt'));
  const continued = await collect(driver.continue({ message: 'synthetic attack', requestId: 'continue', sessionHandle: 'synthetic-protected-thread' }, ctx));
  assert.equal(continued.at(-1)?.type, 'completed', `continue: ${JSON.stringify(continued.at(-1))}`);
  const continueAttack = await inspect('continue');
  assert.equal(await readFile(path.join(dirs.wiki, 'page.md'), 'utf8'), 'formal wiki\n');
  console.log(JSON.stringify({ root, profileIssuer: 'apps/server/src/knowledge/compile-sandbox.ts', issuedEnvKeys: ['HOME', 'PATH', 'TEMP', 'TMP', 'TMPDIR'], profileMode: 'deny-default path whitelist with synthetic source/staging and no network allowance', runBoundary: run.at(-1)?.type, continueBoundary: continued.at(-1)?.type, runAttack, continueAttack, formalWikiUnchanged: true, unsandboxedConfirmCalls: 1, sandboxedConfirmCalls: confirmCalls - 1, sandboxedConfirmConnections: confirmConnections - 1, t03Admitted: false }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
