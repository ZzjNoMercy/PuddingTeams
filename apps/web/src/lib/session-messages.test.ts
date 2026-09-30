import assert from "node:assert/strict";
import test from "node:test";
import { fetchMessages, SessionMessagesError } from "./api.js";

test("message history preserves HTTP 404 and 409 separately from their display text", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => Response.json({ error: "session not found" }, { status: 404 });
		await assert.rejects(fetchMessages("deleted"), (error: unknown) => {
			assert.ok(error instanceof SessionMessagesError);
			assert.equal(error.status, 404);
			assert.equal(error.code, "session not found");
			return true;
		});

		globalThis.fetch = async () => Response.json({ error: "session_context_inactive" }, { status: 409 });
		await assert.rejects(fetchMessages("parked"), (error: unknown) => {
			assert.ok(error instanceof SessionMessagesError);
			assert.equal(error.status, 409);
			assert.equal(error.code, "session_context_inactive");
			assert.match(error.message, /切回对应项目/);
			return true;
		});

		globalThis.fetch = async () => Response.json({ messages: [], running: true });
		assert.equal((await fetchMessages("active")).running, true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
