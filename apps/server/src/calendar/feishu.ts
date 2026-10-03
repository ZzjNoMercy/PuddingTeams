import type { LarkConnection } from "@puddingteams/capability-lark-cli/connection";
import { CalendarProviderError, type CalendarProvider, type ExternalCalendarEvent, type ExternalCalendarSource } from "./providers.js";

const validDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
const nextDay = (day: string) => new Date(Date.parse(day + "T00:00:00Z") + 86400_000).toISOString().slice(0, 10);
function zone(value: unknown): string { try { if (typeof value === "string") { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return value; } } catch {} return "Asia/Shanghai"; }
function instant(value: unknown): string | undefined { if (typeof value !== "string" || !/^\d{1,12}$/.test(value)) return; const milliseconds = Number(value) * 1000; if (!Number.isFinite(milliseconds) || milliseconds > 253402300799000) return; return new Date(milliseconds).toISOString(); }
function appLink(value: unknown): string | undefined { try { const u = new URL(String(value)); if (u.protocol === "https:" && !u.username && !u.password && /(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/.test(u.hostname)) return u.href; } catch {} }
function normalizeEvent(calendarId: string, raw: Record<string, unknown>): ExternalCalendarEvent | undefined {
	if (raw.status === "cancelled") return;
	if (typeof raw.event_id !== "string") throw new CalendarProviderError("unavailable", "飞书返回了无法识别的日程");
	const start = raw.start_time as Record<string, unknown> | undefined, end = raw.end_time as Record<string, unknown> | undefined;
	const common = {
		id: `feishu:${encodeURIComponent(calendarId)}:${encodeURIComponent(raw.event_id)}`, sourceId: `feishu:${calendarId}`, readonly: true as const,
		title: typeof raw.summary === "string" && raw.summary ? raw.summary : "未命名日程",
		description: typeof raw.description === "string" ? raw.description : "",
		location: typeof (raw.location as { name?: unknown } | undefined)?.name === "string" ? (raw.location as { name: string }).name : "",
		kind: "event" as const, busy: raw.free_busy_status !== "free", timeZone: zone(start?.timezone),
		...(appLink(raw.app_link) ? { appLink: appLink(raw.app_link) } : {}),
	};
	if (validDay(start?.date) && validDay(end?.date) && end.date >= start.date) return { ...common, allDay: true, startDate: start.date, endDateExclusive: nextDay(end.date) };
	const startTime = instant(start?.timestamp), endTime = instant(end?.timestamp);
	if (!startTime || !endTime || endTime <= startTime) throw new CalendarProviderError("unavailable", "飞书日程时间格式无效，请刷新重试");
	return { ...common, allDay: false, start: startTime, end: endTime };
}

/** Read-through only. Uses the same connection authority as CLI; no second vault,
 * bot fallback, imported event copies or writes to remote calendars. */
export class FeishuCalendar {
	constructor(private readonly connection: Pick<LarkConnection, "settings" | "accessToken">, private readonly fetcher: typeof fetch = fetch) {}
	private async token(): Promise<string> {
		if (!(await this.connection.settings()).configured) throw new CalendarProviderError("not_configured", "请先配置飞书默认应用，再完成用户授权");
		try { return await this.connection.accessToken("user"); }
		catch (e) {
			const auth = e instanceof Error && /尚未完成用户授权|授权已失效|重新授权/.test(e.message);
			throw new CalendarProviderError(auth ? "authorization_required" : "unavailable", auth ? "请先完成飞书用户授权，再添加日历" : "飞书连接暂不可用，请稍后重试");
		}
	}
	private async request(path: string, token: string, signal: AbortSignal): Promise<Record<string, unknown>> {
		try {
			const response = await this.fetcher(`https://open.feishu.cn/open-apis/calendar/v4/${path}`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal });
			const body = await response.json() as { code?: number; data?: Record<string, unknown> };
			if (body.code === 99991672 || body.code === 99991679 || response.status === 403) throw new CalendarProviderError("permission_required", "需要补充飞书日历读取权限，请完成日历授权；若仍失败，请检查应用后台权限");
			if (response.status === 401 || [99991663, 99991664, 99991665, 99991668, 99991671].includes(body.code ?? 0)) throw new CalendarProviderError("authorization_required", "飞书用户授权已失效，请重新授权");
			if (!response.ok || body.code !== 0 || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) throw new CalendarProviderError("unavailable", "飞书日历读取失败，请稍后重试");
			return body.data;
		} catch (e) { if (e instanceof CalendarProviderError) throw e; throw new CalendarProviderError("unavailable", "飞书请求超时或网络不可用，请稍后重试"); }
	}
	async calendars(): Promise<ExternalCalendarSource[]> {
		const token = await this.token(), signal = AbortSignal.timeout(20_000), result: ExternalCalendarSource[] = [];
		const seen = new Set<string>(); let page = "";
		for (let i = 0; i < 20; i++) {
			const data = await this.request(`calendars?${new URLSearchParams({ page_size: "50", ...(page ? { page_token: page } : {}) })}`, token, signal);
			if (data.calendar_list != null && !Array.isArray(data.calendar_list)) throw new CalendarProviderError("unavailable", "飞书日历列表格式无效");
			for (const raw of (data.calendar_list ?? []) as Record<string, unknown>[]) {
				if (raw.is_deleted || typeof raw.calendar_id !== "string" || raw.role === "free_busy_reader" || raw.role === "unknown") continue;
				if (!seen.has(raw.calendar_id)) { seen.add(raw.calendar_id); result.push({ id: raw.calendar_id, name: typeof raw.summary === "string" && raw.summary ? raw.summary : "飞书日历", type: typeof raw.type === "string" ? raw.type : "shared", writable: false }); }
			}
			if (!data.has_more) return result;
			if (typeof data.page_token !== "string" || !data.page_token || data.page_token === page) break;
			page = data.page_token;
		}
		throw new CalendarProviderError("unavailable", "飞书日历列表分页未完成，请重试");
	}
	async events(calendarId: string, start: string, end: string): Promise<ExternalCalendarEvent[]> {
		if (typeof calendarId !== "string" || typeof start !== "string" || typeof end !== "string") throw new CalendarProviderError("invalid_input", "请选择有效日历和明确查询区间");
		const from = Date.parse(start), to = Date.parse(end);
		if (!calendarId || calendarId.length > 512 || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(start) || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(end) || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 62 * 86400_000) throw new CalendarProviderError("invalid_input", "请选择有效日历和不超过 62 天的明确查询区间");
		const token = await this.token(), signal = AbortSignal.timeout(20_000), result = new Map<string, ExternalCalendarEvent>();
		// Month grid spans 42 days; upstream requires each window to be <40 days.
		for (let cursor = from; cursor < to; cursor += 39 * 86400_000) {
			const query = new URLSearchParams({ start_time: String(Math.floor(cursor / 1000)), end_time: String(Math.ceil(Math.min(to, cursor + 39 * 86400_000) / 1000)) });
			const data = await this.request(`calendars/${encodeURIComponent(calendarId)}/events/instance_view?${query}`, token, signal);
			if (data.items != null && !Array.isArray(data.items)) throw new CalendarProviderError("unavailable", "飞书日程列表格式无效");
			for (const raw of (data.items ?? []) as Record<string, unknown>[]) { const event = normalizeEvent(calendarId, raw); if (event) result.set(event.id, event); }
		}
		return [...result.values()];
	}
}

export function createFeishuCalendarProvider(connection: LarkConnection, calendar = new FeishuCalendar(connection)): CalendarProvider {
	return {
		descriptor: { id: "feishu", name: "飞书", description: "读取飞书账号的日历与日程", color: "#818cf8", readOnly: true, setupUrl: "/settings?section=feishu", authorization: { description: "先完成飞书用户授权，允许平台读取你的日历和日程。" } },
		calendars: () => calendar.calendars(),
		events: (id, start, end) => calendar.events(id, start, end),
		authorization: {
			begin: () => connection.begin({ scope: "calendar:calendar:readonly" }),
			status: id => connection.authorizationStatus(id),
			cancel: id => connection.cancel(id),
		},
	};
}
