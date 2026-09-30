import assert from "node:assert/strict";
import test from "node:test";
import { MessageDeliveryUnconfirmedError, MessageOperationRejectedError, sendMessage } from "./api.js";

test("ordinary send reports an unconfirmed outcome when the HTTP response is lost", async () => {
	const previous = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error("connection reset"); };
	try {
		await assert.rejects(() => sendMessage("session-1", "需要处理的工作", [], "operation-0001"), (error: unknown) =>
			error instanceof MessageDeliveryUnconfirmedError && /结果未确认.*核对会话历史/.test(error.message));
	} finally { globalThis.fetch = previous; }
});

test("inactive session does not offer a new operation key as a recovery path", async () => {
	const previous = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ error: "session_context_inactive" }), { status: 409, headers: { "content-type": "application/json" } });
	try {
		await assert.rejects(() => sendMessage("session-1", "hello", [], "operation-0001"), (error: unknown) =>
			error instanceof Error && !(error instanceof MessageDeliveryUnconfirmedError) && /切回对应项目/.test(error.message));
	} finally { globalThis.fetch = previous; }
});

test("durable preflight rejection reports its reason without an unconfirmed recovery prompt", async () => {
	const previous = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ error: "绝对路径不存在", code: "message_operation_rejected" }), { status: 400, headers: { "content-type": "application/json" } });
	try {
		await assert.rejects(() => sendMessage("session-1", "hello", [], "operation-0001"), (error: unknown) =>
			error instanceof MessageOperationRejectedError && /绝对路径不存在/.test(error.message));
	} finally { globalThis.fetch = previous; }
});

test("ordinary send treats a rejected HTTP response as potentially committed", async () => {
	const previous = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ error: "模型准入失败" }), { status: 400, headers: { "content-type": "application/json" } });
	try {
		await assert.rejects(() => sendMessage("session-1", "需要处理的工作", [], "operation-0001"), (error: unknown) =>
			error instanceof MessageDeliveryUnconfirmedError && /模型准入失败/.test(error.message));
	} finally { globalThis.fetch = previous; }
});

test("ordinary send carries its stable operation key", async () => {
	const previous = globalThis.fetch;
	let seen: string | null = null;
	globalThis.fetch = async (_input, init) => { seen = new Headers(init?.headers).get("idempotency-key"); return new Response(JSON.stringify({ accepted: true }), { status: 200 }); };
	try { await sendMessage("session-1", "hello", [], "operation-0001"); }
	finally { globalThis.fetch = previous; }
	assert.equal(seen, "operation-0001");
});
