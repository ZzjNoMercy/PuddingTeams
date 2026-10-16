import assert from "node:assert/strict";
import { test } from "node:test";
import { deepLinkToAppUrl } from "./deep-link.js";

const BASE = "http://127.0.0.1:8933";

test("标准深链映射为 /chats 查询串", () => {
	assert.equal(
		deepLinkToAppUrl("puddingteams://rooms/solo/sessions/01a1423c-9447-74d9-ba04-d063588c3df8", BASE),
		`${BASE}/chats?room=solo&session=01a1423c-9447-74d9-ba04-d063588c3df8`,
	);
	assert.equal(
		deepLinkToAppUrl("puddingteams://rooms/room_abc-1/sessions/sess_XYZ2/", BASE),
		`${BASE}/chats?room=room_abc-1&session=sess_XYZ2`,
	);
});

test("非深链形态一律拒绝", () => {
	for (const raw of [
		"puddingteams://rooms/solo", // 缺 session 段
		"puddingteams://rooms/solo/sessions/x/extra", // 多余段
		"puddingteams://rooms/solo/sessions/x?foo=bar", // 查询串
		"puddingteams://rooms//sessions/x", // 空 roomId
		"puddingteams://rooms/a b/sessions/x", // 非法字符
		"puddingteams://rooms/a/sessions/x.y", // 点号不属于 id 字符集
		"puddingteams://evil.example/rooms/a/sessions/b", // host 伪装
		"https://attacker.example/rooms/a/sessions/b", // 非 puddingteams scheme
		"javascript:alert(1)",
		"",
	]) {
		assert.equal(deepLinkToAppUrl(raw, BASE), undefined, raw);
	}
});
