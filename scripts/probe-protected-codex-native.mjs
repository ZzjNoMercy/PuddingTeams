import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CodexDriver } from '../extensions/connectors/codex/driver/index.ts';
import { issueCompileSandbox } from '../apps/server/src/knowledge/compile-sandbox.ts';

const commandPath = process.argv[2];
if (process.platform !== 'darwin' || !commandPath || !path.isAbsolute(commandPath)) {
  throw new Error('Usage on macOS: apps/server/node_modules/.bin/tsx scripts/probe-protected-codex-native.mjs /absolute/canonical/native/codex');
}

const command = await realpath(commandPath);
assert.equal(command, commandPath, 'native Codex path must be canonical');
const commandSha256 = createHash('sha256').update(await readFile(command)).digest('hex');
const root = await realpath(await mkdtemp('/private/tmp/puddingteams-t03-native-'));
const source = path.join(root, 'source');
const staging = path.join(root, 'staging');
const privateRoot = path.join(root, 'private');
const wiki = path.join(root, 'wiki');
const control = path.join(root, 'control');
await Promise.all([source, staging, privateRoot, wiki, control].map((dir) => mkdir(dir, { mode: 0o700 })));
await writeFile(path.join(source, 'input.md'), 'synthetic approved source\n');
await writeFile(path.join(wiki, 'page.md'), 'formal wiki unchanged\n');
await writeFile(path.join(control, 'secret'), 'synthetic control secret\n');

const protectedCompile = await issueCompileSandbox({
  jobId: 'native-codex-cold-profile', sourceSnapshotRoot: source, stagingRoot: staging,
  privateRoot, commandPath: command, commandSha256,
});
const driver = new CodexDriver({ timeoutMs: 20_000 });
const events = [];
for await (const event of driver.run({
  requestId: 'native-codex-cold-profile',
  message: 'Read only input.md and answer with the word OK. Do not access other paths.',
}, { cwd: staging, env: { HOST_SENTINEL: 'must-not-inherit' }, protectedCompile })) events.push(event);

assert.equal(await readFile(path.join(wiki, 'page.md'), 'utf8'), 'formal wiki unchanged\n');
assert.equal(await readFile(path.join(control, 'secret'), 'utf8'), 'synthetic control secret\n');
assert.ok(events.length > 0, 'real native CLI must produce an observable Driver outcome');
const terminal = events.at(-1);
assert.ok(terminal?.type === 'completed' || terminal?.type === 'failed', 'Driver must reach a terminal boundary');
console.log(JSON.stringify({
  command, commandSha256, root,
  issuedEnvKeys: Object.keys(protectedCompile.env).sort(),
  eventTypes: events.map((event) => event.type),
  terminalType: terminal.type,
  terminalErrorCode: terminal.type === 'failed' ? terminal.result.errorCode : undefined,
  terminalError: terminal.type === 'failed' ? terminal.result.error : undefined,
  wikiUnchanged: true, controlUnchanged: true,
  t03Admitted: false,
}, null, 2));
