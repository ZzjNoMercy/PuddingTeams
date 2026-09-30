import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { authorization, listConnections } from "./index.js";

async function fixture(mode = "success", expiresIn = 10) {
	const root = await mkdtemp(path.join(tmpdir(), "pt-lark-auth-test-"));
	const cli = path.join(root, "lark-cli");
	const marker = path.join(root, "authorized");
	const log = path.join(root, "calls.jsonl");
	await writeFile(cli, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const marker = ${JSON.stringify(marker)};
if (args[0] === '--version') { console.log('1.0.93'); process.exit(0); }
if (args[1] === 'status') {
  const active = fs.existsSync(marker);
  console.log(JSON.stringify({verified:true,identity:active?'user':'bot',identities:{user:{userName:'测试账号',status:active?'active':'missing',tokenStatus:active?'valid':'expired',scope:'calendar:calendar:readonly drive:drive:readonly'}}}));
} else if (args[1] === 'qrcode') {
  fs.writeFileSync(args[args.indexOf('--output')+1], Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));
} else if (args.includes('--no-wait')) {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+'\\n');
  console.log(JSON.stringify({verification_url:'https://accounts.feishu.cn/authorize?code=test',device_code:'private-device-code',expires_in:${expiresIn}}));
} else if (args.includes('--device-code')) {
  setTimeout(() => {
    if (${JSON.stringify(mode)} === 'reject') { console.error('private-device-code access_token=never-expose'); process.exit(3); }
    fs.writeFileSync(marker, 'ok'); console.log(JSON.stringify({ok:true}));
  }, ${mode === "slow" ? 10_000 : 80});
} else process.exit(2);
`);
	await chmod(cli, 0o755);
	return { ctx: { env: { PATH: root }, stateDir: path.join(root, "shared") }, log, marker };
}

async function waitForTerminal(ctx: Awaited<ReturnType<typeof fixture>>["ctx"], id: string) {
	for (let i = 0; i < 100; i++) {
		const session = await authorization.status("default", id, ctx);
		if (session?.state !== "pending") return session;
		await delay(20);
	}
	throw new Error("授权测试等待超时");
}

test("机器人已连接但用户凭证过期：明确状态并提供重新授权", async () => {
	const { ctx } = await fixture();
	const [connection] = await listConnections(ctx);
	assert.ok(connection);
	assert.equal(connection.state, "connected");
	assert.equal(connection.identity, "机器人身份");
	assert.equal(connection.userAuthorization, "expired");
	assert.match(connection.message!, /授权已过期/);
	assert.equal(connection.actions?.[0]?.label, "重新授权");
	assert.equal(connection.actions?.[0]?.kind, "authorization");
});

test("复用既有授权范围、展示入口后异步确认、成功刷新用户身份且不公开设备码", async () => {
	const { ctx, log } = await fixture();
	const [session, duplicate] = await Promise.all([
		authorization.begin("default", "authorize-user", ctx), authorization.begin("default", "authorize-user", ctx),
	]);
	assert.equal(session.id, duplicate.id);
	assert.match(session.qrCodeDataUrl!, /^data:image\/png;base64,/);
	assert.equal(session.verificationUrl, "https://accounts.feishu.cn/authorize?code=test");
	assert.doesNotMatch(JSON.stringify(session), /private-device-code|access_token/);
	const args = JSON.parse((await readFile(log, "utf8")).trim()) as string[];
	assert.equal(args[args.indexOf("--scope") + 1], "calendar:calendar:readonly drive:drive:readonly");
	assert.ok(!args.includes("--recommend"));
	assert.equal((await waitForTerminal(ctx, session.id))?.state, "completed");
	assert.equal((await listConnections(ctx))[0]?.userAuthorization, "authorized");
	assert.equal(await authorization.status("default", session.id, { ...ctx, stateDir: path.join(ctx.stateDir, "another") }), undefined);
});

test("关闭弹窗取消等待；过期、拒绝均不泄露 CLI 原始认证输出", async () => {
	const { ctx, marker } = await fixture("slow");
	const session = await authorization.begin("default", "authorize-user", ctx);
	await authorization.status("default", session.id, ctx);
	await authorization.cancel("default", session.id, ctx);
	assert.equal((await authorization.status("default", session.id, ctx))?.state, "cancelled");
	await assert.rejects(readFile(marker));
	const expiring = await fixture("slow", 0.2);
	const expired = await authorization.begin("default", "authorize-user", expiring.ctx);
	assert.equal((await waitForTerminal(expiring.ctx, expired.id))?.state, "expired");
	const rejecting = await fixture("reject");
	const rejected = await authorization.begin("default", "authorize-user", rejecting.ctx);
	const failed = await waitForTerminal(rejecting.ctx, rejected.id);
	assert.equal(failed?.state, "failed");
	assert.doesNotMatch(JSON.stringify(failed), /private-device-code|access_token|never-expose/);
});
