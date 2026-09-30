import { test } from "node:test";
import assert from "node:assert/strict";
import { setSessionModel } from "./api";
import { getPreferredModel, setPreferredModel } from "./model-pref";

test("会话模型写入只接受服务端返回的真实模型 ID", async () => {
	const originalFetch = globalThis.fetch;
	try {
		globalThis.fetch = async () => Response.json({ model: { id: "provider/confirmed" } });
		assert.equal(await setSessionModel("session-a", "provider/requested"), "provider/confirmed");
		globalThis.fetch = async () => Response.json({ ok: true });
		await assert.rejects(() => setSessionModel("session-a", "provider/requested"), /服务端响应未确认/);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("本地存储被拒绝时模型选择仍可继续", () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	try {
		Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
		Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("storage denied"); } });
		assert.equal(getPreferredModel(), null);
		assert.doesNotThrow(() => setPreferredModel("provider/model"));
	} finally {
		if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
		else Reflect.deleteProperty(globalThis, "window");
		if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
		else Reflect.deleteProperty(globalThis, "localStorage");
	}
});
