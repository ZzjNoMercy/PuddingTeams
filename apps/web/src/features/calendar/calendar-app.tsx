"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CalendarDaysIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { SectionTopbar } from "@/components/section-topbar";
import { getCalendarEvent, listCalendarEvents, type CalendarEventRecord, type CalendarDisplayEvent } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { dayBoundary, plusDay, validDay, wallTime, weekStart } from "./time";
import { EventEditor } from "./event-editor";
import { ExternalCalendars } from "./external-calendars";
import styles from "./calendar.module.css";
import { calendarSourceLabel } from "./sources";

const sourceStyle = (event: CalendarDisplayEvent): CSSProperties => ({ "--calendar-color": event.sourceId === "platform" ? "var(--home-accent)" : event.color ?? "#818cf8" } as CSSProperties);

function SourceBadge({ event, compact = false }: { event: CalendarDisplayEvent; compact?: boolean }) {
	const label = calendarSourceLabel(event);
	const text = compact ? event.sourceId === "platform" ? "平台" : event.providerName ?? "外部" : label;
	return <span className={`${styles.sourceBadge} ${compact ? styles.compactBadge : ""}`} title={`来源：${label}`}>{text}</span>;
}

type View = "day" | "week" | "month";
type Segment = { event: CalendarDisplayEvent; start: number; end: number; lane: number; lanes: number };
function minutes(local: string) { return +local.slice(11, 13) * 60 + +local.slice(14, 16); }
function visibleOn(event: CalendarDisplayEvent, day: string, zone: string) {
	if (event.allDay) return event.startDate <= day && event.endDateExclusive > day;
	const start = wallTime(event.start, zone), end = wallTime(event.end, zone);
	return start.slice(0, 10) <= day && (end.slice(0, 10) > day || (end.slice(0, 10) === day && end.slice(11) > "00:00"));
}
function daySegments(events: CalendarDisplayEvent[], day: string, zone: string): Segment[] {
	const segments = events.filter((e) => !e.allDay && visibleOn(e, day, zone)).map((event) => {
		if (event.allDay) throw new Error("timed only");
		const start = wallTime(event.start, zone), end = wallTime(event.end, zone);
		return { event, start: start.slice(0, 10) < day ? 0 : minutes(start), end: end.slice(0, 10) > day ? 1440 : minutes(end), lane: 0, lanes: 1 };
	}).sort((a, b) => a.start - b.start || b.end - a.end);
	let group: Segment[] = [], end = -1;
	const settle = () => { const ends: number[] = []; for (const segment of group) { let lane = ends.findIndex((value) => value <= segment.start); if (lane < 0) lane = ends.length; ends[lane] = Math.max(segment.start + 1, segment.end); segment.lane = lane; } for (const segment of group) segment.lanes = ends.length; };
	for (const segment of segments) { if (group.length && segment.start >= end) { settle(); group = []; end = -1; } group.push(segment); end = Math.max(end, segment.end); } settle();
	return segments;
}
function eventTime(event: CalendarDisplayEvent, zone: string) { return event.allDay ? "全天" : `${wallTime(event.start, zone).slice(11)} — ${wallTime(event.end, zone).slice(11)}`; }

export function CalendarApp() {
	const router = useRouter(), query = useSearchParams();
	const [today, setToday] = useState(""), [zone, setZone] = useState("Asia/Shanghai"), [narrow, setNarrow] = useState(false);
	const [events, setEvents] = useState<CalendarEventRecord[] | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(true), [notice, setNotice] = useState("");
	const [showPlatform, setShowPlatform] = useState(true), [editing, setEditing] = useState<CalendarEventRecord | "new" | null>(null), [eventError, setEventError] = useState("");
	const [slot, setSlot] = useState({ day: "", hour: 9 });
	const [externalEvents, setExternalEvents] = useState<CalendarDisplayEvent[]>([]), [remoteDetail, setRemoteDetail] = useState<CalendarDisplayEvent | null>(null), [refreshKey, setRefreshKey] = useState(0);
	const requests = useRef(0), scroll = useRef<HTMLDivElement>(null);
	const dayParam = query.get("date"), viewParam = query.get("view"), eventId = query.get("event");
	const selected = dayParam && validDay(dayParam) ? dayParam : today;
	const view: View = viewParam === "day" || viewParam === "week" || viewParam === "month" ? viewParam : narrow ? "day" : "week";
	useEffect(() => {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const media = window.matchMedia("(max-width: 700px)"), change = () => setNarrow(media.matches);
		const frame = requestAnimationFrame(() => { setZone(zone); setToday(wallTime(Date.now(), zone).slice(0, 10)); change(); });
		media.addEventListener("change", change); return () => { cancelAnimationFrame(frame); media.removeEventListener("change", change); };
	}, []);
	const load = useCallback(async () => {
		const serial = ++requests.current; setLoading(true); setError("");
		try { const next = await listCalendarEvents(); if (serial === requests.current) setEvents(next); } catch (e) { if (serial === requests.current) setError(e instanceof Error ? e.message : "日历加载失败"); }
		finally { if (serial === requests.current) setLoading(false); }
	}, []);
	useEffect(() => { let active = true; const state = requests; queueMicrotask(() => { if (active) void load(); }); return () => { active = false; state.current++; }; }, [load]);
	useEffect(() => {
		if (!eventId) { const frame = requestAnimationFrame(() => setEditing((previous) => previous === "new" ? previous : null)); return () => cancelAnimationFrame(frame); }
		let active = true;
		void getCalendarEvent(eventId).then((event) => { if (active) { setEventError(""); if (event.status === "cancelled") setEventError("此日程已取消"); else setEditing(event); } }).catch((e: Error) => { if (active) setEventError(e.message); });
		return () => { active = false; };
	}, [eventId]);
	useEffect(() => { if (scroll.current) scroll.current.scrollTop = view === "month" ? 0 : 8 * 68; }, [view, selected, loading]);
	const navigate = (date: string, nextView: View = view, event?: string) => { const q = new URLSearchParams({ date, view: nextView }); if (event) q.set("event", event); router.replace(`/calendar?${q}`); };
	const close = () => { setEditing(null); setEventError(""); if (selected) navigate(selected); };
	const open = (event: CalendarDisplayEvent) => { if (event.readonly) setRemoteDetail(event); else navigate(selected, view, event.id); };
	const create = (day = selected, hour = 9) => { setSlot({ day, hour }); setEditing("new"); };
	const days = useMemo(() => selected ? view === "month" ? Array.from({ length: 42 }, (_, i) => plusDay(weekStart(`${selected.slice(0, 7)}-01`), i)) : view === "week" ? Array.from({ length: 7 }, (_, i) => plusDay(weekStart(selected), i)) : [selected] : [], [selected, view]);
	const miniDays = selected ? Array.from({ length: 42 }, (_, i) => plusDay(weekStart(`${selected.slice(0, 7)}-01`), i)) : [];
	const range = useMemo(() => { if (!days.length) return { start: "", end: "", error: "" }; try { return { start: dayBoundary(days[0], zone), end: dayBoundary(plusDay(days.at(-1)!, 1), zone), error: "" }; } catch (e) { return { start: "", end: "", error: e instanceof Error ? e.message : "无法解析日历时间区间" }; } }, [days, zone]);
	const visible: CalendarDisplayEvent[] = [...(showPlatform ? events ?? [] : []), ...externalEvents];
	const shift = (n: number) => { if (view === "month") { const d = new Date(`${selected.slice(0, 7)}-01T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); navigate(d.toISOString().slice(0, 10)); } else navigate(plusDay(selected, n * (view === "week" ? 7 : 1))); };
	const zoneLabel = selected ? new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(new Date(`${selected}T12:00:00Z`)).find((part) => part.type === "timeZoneName")?.value ?? zone : zone;
	const title = selected ? view === "month" ? `${selected.slice(0, 4)} 年 ${+selected.slice(5, 7)} 月` : view === "day" ? selected : `${days[0]} — ${days.at(-1)}` : "日历";
	return <><SectionTopbar title="日历" /><section className={styles.layout} aria-label="日历">
<aside className={styles.aside}><button className={styles.primary} onClick={() => create()} disabled={!selected}><PlusIcon size={15} />创建日程</button><div className={styles.mini}><strong>{selected.slice(0, 7)}</strong><div className={styles.miniGrid}>{"一二三四五六日".split("").map((s) => <span key={s}>{s}</span>)}{miniDays.map((date) => <button aria-label={`选择 ${date}`} key={date} className={date === selected ? styles.selected : date.slice(0, 7) !== selected.slice(0, 7) ? styles.outside : ""} onClick={() => navigate(date)}>{+date.slice(8)}</button>)}</div></div><h3>我的日历</h3><label className={styles.check}><input type="checkbox" checked={showPlatform} onChange={(e) => setShowPlatform(e.target.checked)} /><span className={styles.dot} />平台日历</label>{!narrow && <ExternalCalendars start={range.start} end={range.end} onEvents={setExternalEvents} refreshKey={refreshKey} />}<p className={styles.hint}>管理日程与专注时段。任务截止日期不占用忙闲时间。</p><p className={styles.asideNote}><CalendarDaysIcon size={17} />让时间与资料相连</p></aside>
		<div className={styles.main}><div className={styles.toolbar}><div className={styles.row}><button onClick={() => navigate(today)} disabled={!today}>今天</button><button aria-label="上一时段" onClick={() => shift(-1)} disabled={!selected}><ChevronLeftIcon size={17} /></button><button aria-label="下一时段" onClick={() => shift(1)} disabled={!selected}><ChevronRightIcon size={17} /></button><input aria-label="跳转日期" type="date" value={selected} onChange={(e) => { if (validDay(e.target.value)) navigate(e.target.value); }} /><h2>{title}</h2></div><div className={styles.row}><div className={styles.segmented} aria-label="日历视图">{(["day", "week", "month"] as View[]).map((v, i) => <button key={v} aria-pressed={view === v} onClick={() => navigate(selected, v)} disabled={!selected}>{["日", "周", "月"][i]}</button>)}</div><button className={styles.mobileCreate} aria-label="创建日程" onClick={() => create()} disabled={!selected}><PlusIcon size={17} /></button><button aria-label="刷新日历" onClick={() => { void load(); setRefreshKey(n => n + 1); }} disabled={loading}><RefreshCwIcon size={15} /></button></div></div>
		{narrow && <div className={styles.mobileSources}><label className={styles.check}><input type="checkbox" checked={showPlatform} onChange={e => setShowPlatform(e.target.checked)} /><span className={styles.dot} />平台日历</label><ExternalCalendars start={range.start} end={range.end} onEvents={setExternalEvents} refreshKey={refreshKey} /></div>}
		{range.error && <p className={styles.error} role="alert">{range.error}</p>}{notice && <p className={styles.banner} role="status">{notice}</p>}{error && <p className={styles.error} role="alert">{error} <button onClick={() => void load()}>重试加载</button>{events !== null && " · 正在显示上次成功加载的日程"}</p>}{eventError && <p className={styles.error} role="alert">{eventError}<button onClick={close}>返回日历</button></p>}
		{loading && events === null ? <p className={styles.banner} role="status">正在加载日历…</p> : selected && <div ref={scroll} className={styles.scroll}>
			{view === "month" ? <div className={styles.month}><div className={styles.monthLabels}>{"一二三四五六日".split("").map((s) => <span key={s}>周{s}</span>)}</div><div className={styles.monthGrid}>{days.map((day) => <div key={day} className={`${styles.monthCell} ${day.slice(0, 7) !== selected.slice(0, 7) ? styles.outside : ""}`}><button className={day === today ? styles.today : ""} aria-label={`打开 ${day} 日视图`} onClick={() => navigate(day, "day")}>{+day.slice(8)}</button>{visible.filter((e) => visibleOn(e, day, zone)).map((event) => <button key={event.id} className={`${styles.monthEvent} ${event.readonly ? styles.externalEvent : ""}`} style={sourceStyle(event)} onClick={() => open(event)} title={`${event.title} · 来源：${calendarSourceLabel(event)}`} aria-label={`${event.title} · ${eventTime(event, zone)} · 来源：${calendarSourceLabel(event)}`}><SourceBadge event={event} compact /><span className={styles.compactTitle}>{event.allDay ? "全天" : wallTime(event.start, zone).slice(0, 10) < day ? "延续" : wallTime(event.start, zone).slice(11)} · {event.title}</span></button>)}</div>)}</div></div> : <div className={styles.week} style={{ gridTemplateColumns: `55px repeat(${days.length}, minmax(0, 1fr))`, minWidth: days.length > 1 ? 650 : 0 }}>
				<header className={styles.weekHeader} aria-label="日期与全天日程">
					<div className={styles.zone} title={zone} aria-label={`显示时区：${zone}`}>{zoneLabel}</div>{days.map((day) => <button key={day} className={`${styles.dayHeading} ${day === today ? styles.today : ""}`} onClick={() => navigate(day, "day")}><span>周{"日一二三四五六"[new Date(`${day}T12:00Z`).getUTCDay()]}</span><strong>{+day.slice(8)}</strong></button>)}<div className={styles.allDayLabel}>全天</div>{days.map((day) => <div className={styles.allDay} key={day}>{visible.filter((event) => event.allDay && visibleOn(event, day, zone)).map((event) => <button key={event.id} className={`${styles.compactEvent} ${event.readonly ? styles.externalEvent : ""}`} style={sourceStyle(event)} onClick={() => open(event)} title={`${event.title} · 来源：${calendarSourceLabel(event)}`} aria-label={`${event.title} · 全天 · 来源：${calendarSourceLabel(event)}`}><SourceBadge event={event} /><span className={styles.compactTitle}>{event.title}</span></button>)}</div>)}
				</header>
				<div className={styles.hours}>{Array.from({ length: 24 }, (_, i) => <div key={i}>{String(i).padStart(2, "0")}:00</div>)}</div>{days.map((day) => <div className={styles.dayColumn} key={day}>{Array.from({ length: 24 }, (_, i) => <button key={i} className={styles.hourSlot} aria-label={`${day} ${i}:00 创建日程`} onClick={() => create(day, i)} />)}{daySegments(visible, day, zone).map(({ event, start, end, lane, lanes }) => <button className={`${styles.event} ${event.busy ? "" : styles.free} ${event.readonly ? styles.externalEvent : ""}`} key={event.id} onClick={() => open(event)} style={{ ...sourceStyle(event), top: start / 60 * 68, height: Math.max(38, (end - start) / 60 * 68 - 4), left: `calc(${lane / lanes * 100}% + 3px)`, width: `calc(${100 / lanes}% - 6px)` }} title={`${event.title} · ${eventTime(event, zone)} · 来源：${calendarSourceLabel(event)}`} aria-label={`${event.title} · ${eventTime(event, zone)} · 来源：${calendarSourceLabel(event)}`}><strong className={styles.eventHeading}><SourceBadge event={event} /><span className={styles.compactTitle}>{event.kind === "focus" ? "◦ " : ""}{event.title}</span></strong><span>{eventTime(event, zone)}</span>{event.location && <small>{event.location}</small>}</button>)}</div>)}</div>}
		</div>}
		<footer className={styles.footer}><span><i className={styles.dot} />平台日程可编辑</span><span><CalendarDaysIcon size={11} />外部日程只读</span><span>显示时区：{zone}</span><span>无后台提醒</span>{visible.length === 0 && !loading && !error && <span>暂无日程，可点击创建日程</span>}</footer>
		</div>
	</section>{editing && selected && <EventEditor key={editing === "new" ? `new-${slot.day}-${slot.hour}` : `${editing.id}:${editing.revision}`} event={editing === "new" ? null : editing} day={slot.day || selected} hour={slot.hour} zone={zone} onClose={close} onSaved={() => { close(); setNotice("日程已保存。"); void load(); }} />}
	{remoteDetail && <Dialog open onOpenChange={open => { if (!open) setRemoteDetail(null); }}><DialogContent className={styles.dialog}><DialogTitle>{remoteDetail.title}</DialogTitle><DialogDescription>来源：{calendarSourceLabel(remoteDetail)} · 只读日程</DialogDescription><p className={styles.hint}>{remoteDetail.allDay ? `${remoteDetail.startDate} — ${plusDay(remoteDetail.endDateExclusive, -1)} · 全天` : `${wallTime(remoteDetail.start, zone).replace("T", " ")} — ${wallTime(remoteDetail.end, zone).replace("T", " ")}`}</p>{remoteDetail.location && <p>地点：{remoteDetail.location}</p>}{remoteDetail.description && <p className="whitespace-pre-wrap break-words text-sm">{remoteDetail.description}</p>}{remoteDetail.appLink && <a className="text-sm text-primary underline" href={remoteDetail.appLink} target="_blank" rel="noopener noreferrer">在来源系统中查看</a>}<button onClick={() => setRemoteDetail(null)}>关闭</button></DialogContent></Dialog>}
	</>;
}
