import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { LarkConnection } from "@puddingteams/capability-lark-cli/connection";
import { FeishuCalendar, createFeishuCalendarProvider } from "../calendar/feishu.js";
import { CalendarProviderError, CalendarProviderRegistry } from "../calendar/providers.js";
import { registerCalendarProviderRoutes } from "./calendar-providers.js";
const register = (app: ReturnType<typeof Fastify>, con: LarkConnection, service: FeishuCalendar) => registerCalendarProviderRoutes(app, new CalendarProviderRegistry([createFeishuCalendarProvider(con, service)]));

const user = { accessToken: "private-user-token", refreshToken: "private-refresh", expiresAt: Date.now() + 3600_000, refreshExpiresAt: Date.now() + 86400_000, scope: "calendar:calendar:readonly offline_access" };
const connection = () => {
	let raw: string | undefined = JSON.stringify({ appId: "cli_test", appSecret: "private-secret", user });
	return new LarkConnection({ read: async () => raw, write: async value => { raw = value; } });
};
const response = (data: unknown, code = 0, status = 200) => new Response(JSON.stringify({ code, data }), { status });
const source = { calendar_id: "primary-id", summary: "我的飞书日历", type: "primary", role: "owner" };

test("通用来源目录不探测外部系统，按来源隔离列表、事件与授权", async () => {
	let calls = 0, starts = 0;
	const timed = { id: "same-event", sourceId: "same-calendar", readonly: true as const, title: "测试", description: "", location: "", kind: "event" as const, timeZone: "Asia/Shanghai", busy: true, allDay: false as const, start: "2026-10-01T01:00:00Z", end: "2026-10-01T02:00:00Z" };
	const a = { descriptor: { id: "test-a", name: "测试来源 A", description: "测试", color: "#123456", readOnly: true, authorization: { description: "授权 A" } }, calendars: async () => { calls++; return [{ id: "same-calendar", name: "A 日历", type: "primary", writable: false }]; }, events: async () => [timed], authorization: { begin: async () => { starts++; return { id: "a-session", state: "pending" as const, expiresAt: "2026-10-01T10:00:00Z" }; }, status: async () => undefined, cancel: async () => {} } };
	const b = { ...a, descriptor: { id: "test-b", name: "测试来源 B", description: "测试", color: "#abcdef", readOnly: true }, authorization: undefined, calendars: async () => [{ id: "same-calendar", name: "B 日历", type: "shared", writable: false }] };
	const app = Fastify(); registerCalendarProviderRoutes(app, new CalendarProviderRegistry([a, b]));
	try {
		const catalog = await app.inject({ method: "GET", url: "/api/calendar/providers" });
		assert.equal(catalog.statusCode, 200); assert.equal(catalog.json().providers.length, 2); assert.equal(calls, 0); assert.equal(starts, 0); assert.equal(catalog.headers["cache-control"], "no-store"); assert.doesNotMatch(catalog.body, /accessToken|secret|begin/);
		assert.equal((await app.inject({ method: "GET", url: "/api/calendar/providers/test-b/calendars" })).json().calendars[0].name, "B 日历"); assert.equal(calls, 0);
		const events = await Promise.all(["test-a", "test-b"].map(id => app.inject({ method: "GET", url: `/api/calendar/providers/${id}/events?calendarId=same-calendar&start=2026-10-01T00:00:00Z&end=2026-10-02T00:00:00Z` })));
		assert.notEqual(events[0]!.json().events[0].id, events[1]!.json().events[0].id);
		assert.notEqual(events[0]!.json().events[0].sourceId, events[1]!.json().events[0].sourceId);
		assert.equal(events[1]!.json().events[0].providerName, "测试来源 B"); assert.equal(events[1]!.json().events[0].color, "#abcdef");
		assert.equal((await app.inject({ method: "GET", url: "/api/calendar/providers/missing/calendars" })).statusCode, 404);
		assert.equal((await app.inject({ method: "POST", url: "/api/calendar/providers/test-b/authorizations" })).statusCode, 404); assert.equal(starts, 0);
		assert.equal((await app.inject({ method: "POST", url: "/api/calendar/providers/test-a/authorizations" })).json().session.id, "a-session"); assert.equal(starts, 1);
		assert.equal((await app.inject({ method: "GET", url: "/api/calendar/feishu/calendars" })).statusCode, 404);
		assert.throws(() => new CalendarProviderRegistry([a, a]), /重复/);
		assert.throws(() => new CalendarProviderRegistry([{ ...b, descriptor: { ...b.descriptor, color: "url(https://evil.test)" } }]), /无效/);
	} finally { await app.close(); }
});

test("飞书日历来源分页、用户身份、空列表及无凭证泄漏", async () => {
	const requests: string[] = [];
	const service = new FeishuCalendar(connection(), async (url, init) => {
		assert.equal((init!.headers as Record<string, string>).Authorization, "Bearer private-user-token");
		requests.push(String(url));
		return requests.length === 1 ? response({ calendar_list: [source], has_more: true, page_token: "next" }) : response({ calendar_list: [], has_more: false });
	});
	const app = Fastify(); register(app, connection(), service);
	try {
		const result = await app.inject({ method: "GET", url: "/api/calendar/providers/feishu/calendars" });
		assert.equal(result.statusCode, 200); assert.equal(result.headers["cache-control"], "no-store");
		assert.deepEqual(result.json().calendars, [{ id: "primary-id", name: "我的飞书日历", type: "primary", writable: false }]);
		assert.match(requests[1]!, /page_token=next/);
		assert.doesNotMatch(result.body, /private-user-token|private-refresh|private-secret/);
		assert.deepEqual(await new FeishuCalendar(connection(), async () => response({})).calendars(), []);
	} finally { await app.close(); }
});

test("未配置、未授权、已过期、缺权限与网络失败分别提示，不退回 bot", async () => {
	for (const [configured, message, expected] of [[false, "", "not_configured"], [true, "尚未完成用户授权", "authorization_required"], [true, "用户授权已失效，请重新授权", "authorization_required"], [true, "飞书请求超时或网络不可用", "unavailable"]] as const) {
		let identity: string | undefined;
		const service = new FeishuCalendar({ settings: async () => ({ configured, appId: "", secretConfigured: false, scope: "", accountName: undefined }), accessToken: async as => { identity = as; throw new Error(message); } });
		await assert.rejects(service.calendars(), (e: unknown) => e instanceof CalendarProviderError && e.code === expected);
		assert.equal(identity, configured ? "user" : undefined);
	}
	for (const [fetcher, expected] of [[async () => response({}, 99991672), "permission_required"], [async () => response({}, 99991663), "authorization_required"], [async () => { throw new Error("private-token-in-network-error"); }, "unavailable"]] as const) {
		const app = Fastify(); const con = connection(); register(app, con, new FeishuCalendar(con, fetcher));
		try { const res = await app.inject({ method: "GET", url: "/api/calendar/providers/feishu/calendars" }); assert.equal(res.json().code, expected); assert.doesNotMatch(res.body, /private-token/); assert.equal(res.statusCode, expected === "permission_required" ? 403 : expected === "authorization_required" ? 401 : 502); } finally { await app.close(); }
	}
});

test("42 天月视图拆分、重复实例去重、全天结束日期和只读投影", async () => {
	const urls: string[] = [];
	const service = new FeishuCalendar(connection(), async url => {
		urls.push(String(url));
		return response({ items: [
			{ event_id: "timed_1", summary: "测试日程", start_time: { timestamp: "1790816400", timezone: "Asia/Shanghai" }, end_time: { timestamp: "1790820000" }, free_busy_status: "free", app_link: "https://evil.example/" },
			{ event_id: "all_day", summary: "假期", start_time: { date: "2026-10-01" }, end_time: { date: "2026-10-03" } },
			{ event_id: "cancelled", status: "cancelled" },
		] });
	});
	const events = await service.events("primary/id", "2026-09-28T00:00:00+08:00", "2026-11-09T00:00:00+08:00");
	assert.equal(urls.length, 2); assert.match(urls[0]!, /primary%2Fid/);
	const first = new URL(urls[0]!), second = new URL(urls[1]!);
	assert.equal(first.searchParams.get("end_time"), second.searchParams.get("start_time"));
	assert.equal(events.length, 2); assert.ok(events.every(e => e.readonly && e.sourceId === "feishu:primary/id"));
	assert.equal(events[0]!.busy, false); assert.equal(events[0]!.appLink, undefined);
	assert.equal(events[1]!.allDay && events[1]!.endDateExclusive, "2026-10-04");
	assert.deepEqual(await new FeishuCalendar(connection(), async () => response({})).events("id", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"), []);
	await assert.rejects(service.events("id", "2026-10-01", "2026-10-02"), { code: "invalid_input" });
	await assert.rejects(service.events("id", "2026-10-01T00:00:00Z", "2027-10-02T00:00:00Z"), { code: "invalid_input" });
	await assert.rejects(new FeishuCalendar(connection(), async () => response({ items: {} })).events("id", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"), { code: "unavailable" });
});

test("日历增权使用同一连接，只有点击 POST 才发起，取消不退出原授权", async () => {
	let raw: string | undefined = JSON.stringify({ appId: "cli_test", appSecret: "secret", user });
	let starts = 0;
	const con = new LarkConnection({ read: async () => raw, write: async value => { raw = value; } }, { fetch: async (_url, init) => {
		starts++; assert.ok(String(init?.body).includes("calendar%3Acalendar%3Areadonly"));
		return new Response(JSON.stringify({ device_code: "private-code", verification_uri_complete: "https://accounts.feishu.cn/oauth/test", expires_in: 300 }));
	} });
	const app = Fastify(); register(app, con, new FeishuCalendar(con, async () => response({})));
	try {
		await app.inject({ method: "GET", url: "/api/calendar/providers/feishu/calendars" }); assert.equal(starts, 0);
		const result = await app.inject({ method: "POST", url: "/api/calendar/providers/feishu/authorizations" });
		assert.equal(result.statusCode, 200); assert.equal(starts, 1); assert.doesNotMatch(result.body, /private-code|private-user-token|private-refresh/);
		const id = result.json().session.id;
		assert.equal((await app.inject({ method: "DELETE", url: `/api/calendar/providers/feishu/authorizations/${id}` })).statusCode, 204);
		assert.equal((await con.authorizationStatus(id))?.state, "cancelled"); assert.ok(JSON.parse(raw!).user);
		assert.equal((await app.inject({ method: "GET", url: "/api/calendar/providers/feishu/authorizations/not-found" })).statusCode, 404);
	} finally { con.close(); await app.close(); }
});
