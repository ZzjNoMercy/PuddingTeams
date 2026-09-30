"use client";
import { useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { getCalendarEvent, KnowledgeApiError, mutateCalendarEvent, type CalendarEventInput, type CalendarEventRecord } from "@/lib/api";
import { plusDay, resolveWallTime, validDay, wallTime } from "./time";
import styles from "./calendar.module.css";

export function EventEditor({ event, day, hour, zone, onClose, onSaved }: { event: CalendarEventRecord | null; day: string; hour: number; zone: string; onClose: () => void; onSaved: () => void }) {
	const [title, setTitle] = useState(event?.title ?? "");
	const [description, setDescription] = useState(event?.description ?? ""), [location, setLocation] = useState(event?.location ?? "");
	const [kind, setKind] = useState<"event" | "focus">(event?.kind ?? "event"), [busy, setBusy] = useState(event?.busy ?? true);
	const [timeZone, setTimeZone] = useState(event?.timeZone ?? zone), [allDay, setAllDay] = useState(event?.allDay ?? false);
	const [start, setStart] = useState(event ? event.allDay ? event.startDate : wallTime(event.start, event.timeZone) : `${day}T${String(hour).padStart(2, "0")}:00`);
	const [end, setEnd] = useState(event ? event.allDay ? event.endDateExclusive : wallTime(event.end, event.timeZone) : hour === 23 ? `${plusDay(day, 1)}T00:00` : `${day}T${String(hour + 1).padStart(2, "0")}:00`);
	const [startFold, setStartFold] = useState<"reject" | "earlier" | "later">("reject"), [endFold, setEndFold] = useState<"reject" | "earlier" | "later">("reject");
	const [error, setError] = useState(""), [pending, setPending] = useState(false), [unconfirmed, setUnconfirmed] = useState(false), [confirmCancel, setConfirmCancel] = useState(false);
	const [latest, setLatest] = useState<CalendarEventRecord | null>(null);
	const operation = useRef<{ action: "create" | "update" | "cancel"; operationId: string; expectedRevision: number; event?: CalendarEventInput } | null>(null);
	const inFlight = useRef(false), locked = pending || unconfirmed;
	const save = async (cancel = false) => {
		if (inFlight.current) return;
		inFlight.current = true; setError("");
		try {
			if (!operation.current) {
				let input: CalendarEventInput | undefined;
				if (!cancel) {
					const common = { title: title.trim(), description, location, kind, busy, timeZone };
					if (!common.title) throw new Error("请填写日程标题");
					input = allDay ? { ...common, allDay: true, startDate: start.slice(0, 10), endDateExclusive: end.slice(0, 10) } : { ...common, allDay: false, start: event && !event.allDay && start === wallTime(event.start, timeZone) ? event.start : resolveWallTime(start, timeZone, startFold), end: event && !event.allDay && end === wallTime(event.end, timeZone) ? event.end : resolveWallTime(end, timeZone, endFold) };
					if (input.allDay ? !validDay(input.startDate) || !validDay(input.endDateExclusive) || input.endDateExclusive <= input.startDate : input.end <= input.start) throw new Error("结束时间须晚于开始时间；全天结束日期不包含在内");
				}
				operation.current = { action: cancel ? "cancel" : event ? "update" : "create", operationId: crypto.randomUUID(), expectedRevision: event?.revision ?? 0, ...(input ? { event: input } : {}) };
			}
			setPending(true);
			const attempt = operation.current;
			await mutateCalendarEvent(attempt.action, event?.id, attempt);
			operation.current = null; setUnconfirmed(false); onSaved();
		} catch (failure) {
			if (failure instanceof KnowledgeApiError && failure.status < 500) { operation.current = null; setUnconfirmed(false); }
			else if (operation.current) setUnconfirmed(true);
			setError(failure instanceof Error ? failure.message : "日程保存失败，请重试");
		} finally { inFlight.current = false; setPending(false); }
	};
	return <Dialog open onOpenChange={(open) => { if (!open && !locked) onClose(); }}><DialogContent className={styles.dialog} showCloseButton={!locked}>
		<DialogTitle>{event ? "编辑日程" : "创建日程"}</DialogTitle><DialogDescription>平台本地日程 · 创建后不发送邀请或后台提醒。</DialogDescription>
		<form onSubmit={(e) => { e.preventDefault(); void save(); }} className={styles.form}>
			<fieldset disabled={locked}>
				<label>标题<input autoFocus aria-label="日程标题" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} required /></label>
				<div className={styles.columns}><label>类型<select value={kind} onChange={(e) => setKind(e.target.value as "event" | "focus")}><option value="event">日程</option><option value="focus">专注时段</option></select></label><label>时区<input aria-label="日程时区" value={timeZone} onChange={(e) => setTimeZone(e.target.value)} placeholder="Asia/Shanghai" required /></label></div>
				<label className={styles.check}><input type="checkbox" checked={allDay} onChange={(e) => { setAllDay(e.target.checked); setStart(e.target.checked ? start.slice(0, 10) : `${start.slice(0, 10)}T09:00`); setEnd(e.target.checked ? plusDay(start.slice(0, 10), 1) : `${start.slice(0, 10)}T10:00`); }} />全天</label>
				<div className={styles.columns}><label>开始<input aria-label="开始时间" type={allDay ? "date" : "datetime-local"} value={start} onChange={(e) => setStart(e.target.value)} required /></label><label>{allDay ? "结束日期（不含）" : "结束"}<input aria-label="结束时间" type={allDay ? "date" : "datetime-local"} value={end} onChange={(e) => setEnd(e.target.value)} required /></label></div>
				{!allDay && <details><summary>夏令时重复时间</summary><div className={styles.columns}>{([{ label: "开始时间", value: startFold, set: setStartFold }, { label: "结束时间", value: endFold, set: setEndFold }]).map(({ label, value, set }) => <label key={label}>{label}<select aria-label={`${label}夏令时选择`} value={value} onChange={(e) => set(e.target.value as "reject" | "earlier" | "later")}><option value="reject">重复时先提示确认</option><option value="earlier">第一次</option><option value="later">第二次</option></select></label>)}</div></details>}
				<label className={styles.check}><input type="checkbox" checked={busy} onChange={(e) => setBusy(e.target.checked)} />占用忙闲时间</label>
				<label>地点<input value={location} maxLength={500} onChange={(e) => setLocation(e.target.value)} /></label><label>描述<textarea value={description} maxLength={10000} rows={3} onChange={(e) => setDescription(e.target.value)} /></label>
			</fieldset>
			{error && <p role="alert" className={styles.error}>{error}</p>}
			{unconfirmed && <p className={styles.hint}>保存结果未确认，已保留本次内容与操作身份。重试会核对同一操作。</p>}
			{event && error && !locked && <button type="button" onClick={() => { void getCalendarEvent(event.id).then(setLatest).catch((e: Error) => setError(e.message)); }}>核对最新日程</button>}
			{latest && <p role="status">最新版本 {latest.revision}：{latest.title}（{latest.status === "cancelled" ? "已取消" : "有效"}）。关闭后重新打开可载入；当前草稿保留。</p>}
			{confirmCancel && !locked && <p role="alert">确定取消此日程？任务和知识库笔记不会被删除。<button type="button" onClick={() => void save(true)}>确认取消日程</button></p>}
			<div className={styles.actions}>{event && !unconfirmed && <button type="button" className={styles.danger} disabled={locked} onClick={() => setConfirmCancel(true)}>取消日程</button>}<span /><button type="button" disabled={locked} onClick={onClose}>关闭</button><button className={styles.primary} disabled={pending} type="submit">{pending ? "保存中…" : unconfirmed ? "重试同一操作" : "保存日程"}</button></div>
		</form>
	</DialogContent></Dialog>;
}
