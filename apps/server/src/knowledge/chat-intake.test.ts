import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { KnowledgeObjectStore } from "./objects.js";
import { KnowledgeSourceStore } from "./sources.js";
import { ChatKnowledgeIntake } from "./chat-intake.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=";
async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "pt-chat-intake-"));
	const sources = new KnowledgeSourceStore({ stateDir: root, objects: new KnowledgeObjectStore(path.join(root, "objects")) });
	const service = new ChatKnowledgeIntake({ stateDir: root, sources });
	const branch: Array<{ id: string; type: string; customType?: string; details?: unknown; message?: { role: string; content: unknown[] } }> = [];
	const session = { sessionId: "session", sessionFile: path.join(root, "session.jsonl"), sessionManager: { getBranch: () => branch } } as unknown as AgentSession;
	const flush = () => writeFile(session.sessionFile!, branch.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const input = { ownerId: "owner", windowId: "window", sessionId: "session", operationId: "op", text: "用户原话：项目日期是10月23日。", uploads: [] };
	return { root, sources, service, session, branch, flush, input };
}

test("准入素材幂等、原话保真、图片独立原件；未落盘/不同owner/session无法引用", async () => {
	const f = await fixture();
	try {
		const upload = { name: "camera", mediaType: "image/png", size: Buffer.from(png, "base64").length, base64: png, path: "/never/read/model/path" };
		const input = { ...f.input, text: "  原话与模型整理指令不同。\n", uploads: [upload] };
		const refs = await f.service.prepare(input), replay = await f.service.prepare(input);
		assert.deepEqual(refs, replay); assert.equal(refs.sourceIds.length, 2);
		assert.equal((await f.sources.readText("owner", refs.sourceIds[0]!)).text, input.text);
		const image = (await f.sources.get("owner", refs.sourceIds[1]!))!;
		assert.equal(image.kind, "image"); assert.equal(image.status, "needs_attention"); assert.equal(image.textHash, undefined);
		await assert.rejects(f.service.prepare({ ...input, text: "模型虚构事实" }), /operationId/);
		const disarm = f.service.armManager(f.session, refs, "平台prompt", [upload]);
		f.branch.push({ id: "user", type: "message", message: { role: "user", content: [{ type: "text", text: "平台prompt" }, { type: "image", data: png }] } });
		await assert.rejects(f.service.admitManager(f.session), /ENOENT|未落盘/);
		await f.flush(); await f.service.admitManager(f.session); disarm();
		f.branch.push({ id: "assistant", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "request", name: "knowledge_request_curation" }] } }); await f.flush();
		assert.deepEqual(await f.service.resolve(f.session, "owner", { toolCallId: "request" }), refs);
		await assert.rejects(f.service.resolve(f.session, "other", { toolCallId: "request" }), /没有可整理/);
		await assert.rejects(f.service.resolve({ ...f.session, sessionId: "other-session" } as AgentSession, "owner", { toolCallId: "request" }), /没有可整理/);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("当前工具绑定其前置user；未来/预拒绝素材不能污染旧委派，重启仍按durable entry解析", async () => {
	const f = await fixture();
	try {
		const first = await f.service.prepare(f.input);
		const disarm = f.service.armManager(f.session, first, "first", []);
		f.branch.push({ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "first" }] } }); await f.flush();
		await f.service.admitManager(f.session); disarm();
		f.branch.push({ id: "a1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "delegate-first" }] } });
		const future = await f.service.prepare({ ...f.input, operationId: "future", text: "未来消息的事实，不应进入旧委派" });
		const cancel = f.service.armManager(f.session, future, "future", []); cancel();
		f.branch.push({ id: "u2", type: "message", message: { role: "user", content: [{ type: "text", text: "future" }] } });
		f.branch.push({ id: "a2", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "delegate-future" }] } }); await f.flush();
		const restarted = new ChatKnowledgeIntake({ stateDir: f.root, sources: f.sources });
		assert.deepEqual(await restarted.resolve(f.session, "owner", { toolCallId: "delegate-first" }), first);
		await assert.rejects(restarted.resolve(f.session, "owner", { toolCallId: "delegate-future" }), /没有可整理/);
		await assert.rejects(restarted.resolve(f.session, "owner", { toolCallId: "model-invented-id" }), /关联缺失/);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("模型跨回合重复toolCallId不能默默选择旧原话，也不能按最后匹配猜测", async () => {
	const f = await fixture();
	try {
		for (const [index, text] of ["first", "second"].entries()) {
			const refs = await f.service.prepare({ ...f.input, operationId: `op-${index}`, text });
			const disarm = f.service.armManager(f.session, refs, text, []);
			f.branch.push({ id: `u-${index}`, type: "message", message: { role: "user", content: [{ type: "text", text }] } }); await f.flush(); await f.service.admitManager(f.session); disarm();
			f.branch.push({ id: `a-${index}`, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "same-model-id" }] } }); await f.flush();
		}
		await assert.rejects(f.service.resolve(f.session, "owner", { toolCallId: "same-model-id" }), /不唯一/);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("image字节替换不能绑定；同内容旧user不可冒充新入站；direct operation精确关联", async () => {
	const f = await fixture();
	try {
		f.branch.push({ id: "old", type: "message", message: { role: "user", content: [{ type: "text", text: "same" }] } }); await f.flush();
		const refs = await f.service.prepare(f.input), disarm = f.service.armManager(f.session, refs, "same", []);
		await assert.rejects(f.service.admitManager(f.session), /不匹配/); disarm();
		const upload = { name: "a.png", mediaType: "image/png", size: 1, path: "unread", base64: png };
		const stop = f.service.armManager(f.session, refs, "new", [upload]);
		f.branch.push({ id: "changed", type: "message", message: { role: "user", content: [{ type: "text", text: "new" }, { type: "image", data: "changed" }] } }); await f.flush();
		await assert.rejects(f.service.admitManager(f.session), /附件.*不匹配/); stop();
		f.branch.push({ id: "direct-user", type: "custom_message", customType: "pudding:user_message", details: { operationId: refs.operationId, sourceRefs: refs } }); await f.flush();
		await f.service.admitDirect(f.session, refs);
		assert.deepEqual(await f.service.resolve(f.session, "owner", { operationId: refs.operationId }), refs);
		await assert.rejects(f.service.resolve(f.session, "owner", { operationId: "future" }), /没有获准/);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});

test("unsupported附件不伪装完整来源，整理请求明确失败", async () => {
	const f = await fixture();
	try {
		const refs = await f.service.prepare({ ...f.input, text: "", uploads: [{ name: "book.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 1, path: "unread", base64: "YQ==" }] });
		f.branch.push({ id: "direct", type: "custom_message", customType: "pudding:user_message", details: { operationId: refs.operationId, sourceRefs: refs } }); await f.flush(); await f.service.admitDirect(f.session, refs);
		await assert.rejects(f.service.resolve(f.session, "owner", { operationId: refs.operationId }), /尚不支持.*book.docx/);
	} finally { await rm(f.root, { recursive: true, force: true }); }
});
