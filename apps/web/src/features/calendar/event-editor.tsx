"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { findCalendarPeople, getCalendarEvent, retryCalendarInteraction, setCalendarEventStatus, KnowledgeApiError, mutateCalendarEvent, type CalendarEventStatus, type CalendarPeopleSource, type CalendarEventInput, type CalendarEventRecord } from "@/lib/api";
import { plusDay, resolveWallTime, validDay, wallTime } from "./time";
import styles from "./calendar.module.css";

export function EventEditor({ event, day, hour, zone, onClose, onSaved }: { event: CalendarEventRecord | null; day: string; hour: number; zone: string; onClose: () => void; onSaved: (event: CalendarEventRecord) => void }) {
	const [title, setTitle] = useState(event?.title ?? "");
	const [description, setDescription] = useState(event?.description ?? ""), [location, setLocation] = useState(event?.location ?? "");
	const [kind, setKind] = useState<"event" | "focus">(event?.kind ?? "event"), [busy, setBusy] = useState(event?.busy ?? true);
	const [timeZone, setTimeZone] = useState(event?.timeZone ?? zone), [allDay, setAllDay] = useState(event?.allDay ?? false);
	const [start, setStart] = useState(event ? event.allDay ? event.startDate : wallTime(event.start, event.timeZone) : `${day}T${String(hour).padStart(2, "0")}:00`);
	const [end, setEnd] = useState(event ? event.allDay ? event.endDateExclusive : wallTime(event.end, event.timeZone) : hour === 23 ? `${plusDay(day, 1)}T00:00` : `${day}T${String(hour + 1).padStart(2, "0")}:00`);
	const [startFold, setStartFold] = useState<"reject" | "earlier" | "later">("reject"), [endFold, setEndFold] = useState<"reject" | "earlier" | "later">("reject");
	const [error, setError] = useState(""), [pending, setPending] = useState(false), [unconfirmed, setUnconfirmed] = useState(false), [confirmCancel, setConfirmCancel] = useState(false);
	const [latest, setLatest] = useState<CalendarEventRecord | null>(null);
	const [participants, setParticipants] = useState(event?.participants ?? []), [interaction, setInteraction] = useState(event?.interaction);
	const [peopleQuery, setPeopleQuery] = useState(""), [peopleResult, setPeopleResult] = useState<{ query: string; sources: CalendarPeopleSource[]; error?: string }>();
	const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries((event?.participantDetails ?? []).map(p => [JSON.stringify([p.bindingId,p.personId]),p.name])));
	useEffect(() => {
		let active = true;
		const timer = setTimeout(() => { void findCalendarPeople(peopleQuery).then(sources => { if (active) { setPeopleResult({ query: peopleQuery, sources }); setNames(old => ({ ...old, ...Object.fromEntries(sources.flatMap(s => s.people.map(p => [JSON.stringify([s.bindingId,p.personId]),p.name]))) })); } }).catch((e: Error) => { if (active) setPeopleResult({ query: peopleQuery, sources: [], error: e.message }); }); }, peopleQuery ? 250 : 0);
		return () => { active = false; clearTimeout(timer); };
	}, [peopleQuery]);
	const selectedKey = (p: { bindingId: string; personId: string }) => JSON.stringify([p.bindingId,p.personId]);
	const togglePerson = (bindingId: string, personId: string) => {
		const ref = { bindingId, personId }, selected = participants.some(p => selectedKey(p) === selectedKey(ref));
		const next = selected ? participants.filter(p => selectedKey(p) !== selectedKey(ref)) : [...participants,ref];
		setParticipants(next);
		if (!event?.interaction && interaction && (!next.length || next.some(p => p.bindingId !== interaction.bindingId))) setInteraction(undefined);
	};
	const canRecord = !allDay && kind === "event" && participants.length > 0 && participants.every(p => p.bindingId === participants[0].bindingId);
	const operation = useRef<{ action: "create" | "update" | "cancel"; operationId: string; expectedRevision: number; event?: CalendarEventInput } | null>(null);
	const statusOperation = useRef<{ status: CalendarEventStatus; operationId: string } | null>(null);
	const inFlight = useRef(false), locked = pending || unconfirmed;
	const cancelled = event?.status === "cancelled", done = event?.status === "done", settled = cancelled || done;
	const applyStatus = async (status: CalendarEventStatus) => {
		if (!event || inFlight.current) return;
		inFlight.current = true; setError("");
		try {
			if (statusOperation.current?.status !== status) statusOperation.current = { status, operationId: crypto.randomUUID() };
			setPending(true);
			const saved = await setCalendarEventStatus(event.id, status, statusOperation.current.operationId, event.revision);
			statusOperation.current = null; onSaved(saved);
		} catch (failure) {
			if (failure instanceof KnowledgeApiError && failure.status < 500) statusOperation.current = null;
			setError(failure instanceof Error ? failure.message : "日程状态更新失败，请重试");
		} finally { inFlight.current = false; setPending(false); }
	};
	const save = async (cancel = false) => {
		if (inFlight.current) return;
		inFlight.current = true; setError("");
		try {
			if (!operation.current) {
				let input: CalendarEventInput | undefined;
				if (!cancel) {
					const common = { title: title.trim(), description, location, kind, busy, timeZone, participants, ...(interaction ? { interaction } : {}) };
					if (!common.title) throw new Error("请填写日程标题");
					input = allDay ? { ...common, allDay: true, startDate: start.slice(0, 10), endDateExclusive: end.slice(0, 10) } : { ...common, allDay: false, start: event && !event.allDay && start === wallTime(event.start, timeZone) ? event.start : resolveWallTime(start, timeZone, startFold), end: event && !event.allDay && end === wallTime(event.end, timeZone) ? event.end : resolveWallTime(end, timeZone, endFold) };
					if (input.allDay ? !validDay(input.startDate) || !validDay(input.endDateExclusive) || input.endDateExclusive <= input.startDate : input.end <= input.start) throw new Error("结束时间须晚于开始时间；全天结束日期不包含在内");
				}
				operation.current = { action: cancel ? "cancel" : event ? "update" : "create", operationId: crypto.randomUUID(), expectedRevision: event?.revision ?? 0, ...(input ? { event: input } : {}) };
			}
			setPending(true);
			const attempt = operation.current;
			const saved = await mutateCalendarEvent(attempt.action, event?.id, attempt);
			operation.current = null; setUnconfirmed(false); onSaved(saved);
		} catch (failure) {
			if (failure instanceof KnowledgeApiError && failure.status < 500) { operation.current = null; setUnconfirmed(false); }
			else if (operation.current) setUnconfirmed(true);
			setError(failure instanceof Error ? failure.message : "日程保存失败，请重试");
		} finally { inFlight.current = false; setPending(false); }
	};
	return <Dialog open onOpenChange={(open) => { if (!open && !locked) onClose(); }}><DialogContent className={styles.dialog} showCloseButton={!locked}>
		<DialogTitle>{done ? "已完成的日程" : cancelled ? "已取消的日程" : event ? "编辑日程" : "创建日程"}</DialogTitle><DialogDescription>平台本地日程 · 创建后不发送邀请或后台提醒。</DialogDescription>
		<form onSubmit={(e) => { e.preventDefault(); void save(); }} className={styles.form}>
			<fieldset disabled={locked || settled}>
				<label>标题<input autoFocus aria-label="日程标题" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} required /></label>
				<div className={styles.columns}><label>类型<select disabled={Boolean(event?.interaction)} value={kind} onChange={(e) => { setKind(e.target.value as "event" | "focus"); if (e.target.value === "focus") setInteraction(undefined); }}><option value="event">日程</option><option value="focus">专注时段</option></select></label><label>时区<input aria-label="日程时区" value={timeZone} onChange={(e) => setTimeZone(e.target.value)} placeholder="Asia/Shanghai" required /></label></div>
				<label className={styles.check}><input type="checkbox" disabled={Boolean(event?.interaction)} checked={allDay} onChange={(e) => { setAllDay(e.target.checked); if (e.target.checked) setInteraction(undefined); setStart(e.target.checked ? start.slice(0, 10) : `${start.slice(0, 10)}T09:00`); setEnd(e.target.checked ? plusDay(start.slice(0, 10), 1) : `${start.slice(0, 10)}T10:00`); }} />全天</label>
				<div className={styles.columns}><label>开始<input aria-label="开始时间" type={allDay ? "date" : "datetime-local"} value={start} onChange={(e) => setStart(e.target.value)} required /></label><label>{allDay ? "结束日期（不含）" : "结束"}<input aria-label="结束时间" type={allDay ? "date" : "datetime-local"} value={end} onChange={(e) => setEnd(e.target.value)} required /></label></div>
				{!allDay && <details><summary>夏令时重复时间</summary><div className={styles.columns}>{([{ label: "开始时间", value: startFold, set: setStartFold }, { label: "结束时间", value: endFold, set: setEndFold }]).map(({ label, value, set }) => <label key={label}>{label}<select aria-label={`${label}夏令时选择`} value={value} onChange={(e) => set(e.target.value as "reject" | "earlier" | "later")}><option value="reject">重复时先提示确认</option><option value="earlier">第一次</option><option value="later">第二次</option></select></label>)}</div></details>}
				<label className={styles.check}><input type="checkbox" checked={busy} onChange={(e) => setBusy(e.target.checked)} />占用忙闲时间</label>
				<label>地点<input value={location} maxLength={500} onChange={(e) => setLocation(e.target.value)} /></label><label>描述<textarea value={description} maxLength={10000} rows={3} onChange={(e) => setDescription(e.target.value)} /></label>
				<section className={styles.participants} aria-label="日程参与人"><strong>参与人</strong>
					{participants.length > 0 && <div className={styles.peopleChips}>{participants.map(p => <button type="button" key={selectedKey(p)} onClick={() => togglePerson(p.bindingId,p.personId)} aria-label={`移除参与人${names[selectedKey(p)] ?? "联系人"}`}>{names[selectedKey(p)] ?? "联系人暂不可访问"}<span aria-hidden> ×</span></button>)}</div>}
					<input aria-label="搜索日程参与人" placeholder="搜索人脉库中的姓名或公司" value={peopleQuery} onChange={e => setPeopleQuery(e.target.value)} />
					<div className={styles.peopleOptions}>{!peopleResult || peopleResult.query !== peopleQuery ? <p className={styles.hint}>正在查找联系人…</p> : peopleResult.error ? <p role="alert" className={styles.error}>{peopleResult.error}</p> : peopleResult.sources.length === 0 ? <p className={styles.hint}>暂无可用的人脉库，请先在知识库接入人物资料。</p> : peopleResult.sources.map(source => <div key={source.bindingId}><small>{source.name}</small>{source.people.map(person => <button type="button" key={person.personId} aria-pressed={participants.some(p => p.bindingId === source.bindingId && p.personId === person.personId)} onClick={() => togglePerson(source.bindingId,person.personId)}><span>{person.name}</span><small>{person.company}</small></button>)}{source.total === 0 && <p className={styles.hint}>没有匹配的联系人</p>}{source.total > source.people.length && <p className={styles.hint}>输入姓名缩小范围</p>}</div>)}</div>
					<label className={styles.check}><input type="checkbox" checked={Boolean(interaction)} disabled={Boolean(event?.interaction) || !canRecord} onChange={e => setInteraction(e.target.checked ? { bindingId: participants[0].bindingId, kind: "event" } : undefined)} />同时记录为人脉往来</label>
					{interaction && <label>往来类型<select aria-label="往来类型" value={interaction.kind} disabled={Boolean(event?.interaction)} onChange={e => setInteraction({ ...interaction, kind: e.target.value as NonNullable<CalendarEventInput["interaction"]>["kind"] })}><option value="event">活动</option><option value="meal">饭局</option><option value="in_person">见面</option><option value="call">通话</option><option value="message">消息</option><option value="email">邮件</option><option value="other">其他</option></select></label>}
					<p className={styles.hint}>{interaction ? "日程保存后生成待审核的往来记录，审核发布后会出现在人物档案与图谱中。" : "定时日程选择同一人脉库的参与人后，可以同时记录往来。"}</p>
				</section>
			</fieldset>
			{event?.interactionState && <div className={styles.interactionStatus}><p>{event.interactionState.message}{event.interactionState.status === "needs_attention" && event.interactionState.reviewUrl ? "；请核对日程后重新保存生成新候选。" : ""}</p>{event.interactionState.status === "published" && event.interactionState.noteUrl ? <Link href={event.interactionState.noteUrl}>查看往来记录</Link> : event.interactionState.reviewUrl ? <Link href={event.interactionState.reviewUrl}>查看审核</Link> : null}{event.interactionState.status === "needs_attention" && !event.interactionState.reviewUrl && <button type="button" disabled={locked} onClick={() => { setPending(true); void retryCalendarInteraction(event.id).then(onSaved).catch((e: Error) => setError(e.message)).finally(() => setPending(false)); }}>重试往来同步</button>}</div>}
			{error && <p role="alert" className={styles.error}>{error}</p>}
			{unconfirmed && <p className={styles.hint}>保存结果未确认，已保留本次内容与操作身份。重试会核对同一操作。</p>}
			{event && error && !locked && <button type="button" onClick={() => { void getCalendarEvent(event.id).then(setLatest).catch((e: Error) => setError(e.message)); }}>核对最新日程</button>}
			{latest && <p role="status">最新版本 {latest.revision}：{latest.title}（{latest.status === "cancelled" ? "已取消" : latest.status === "done" ? "已完成" : "有效"}）。关闭后重新打开可载入；当前草稿保留。</p>}
			{confirmCancel && !locked && <p role="alert">确定取消此日程？任务和知识库笔记不会被删除。<button type="button" onClick={() => void save(true)}>确认取消日程</button></p>}
			<div className={styles.actions}>{event && !settled && !unconfirmed && <><button type="button" className={styles.danger} disabled={locked} onClick={() => setConfirmCancel(true)}>取消日程</button><button type="button" disabled={locked} onClick={() => void applyStatus("done")}>标记完成</button></>}{event && settled && <button type="button" disabled={locked} onClick={() => void applyStatus("confirmed")}>恢复计划</button>}<span /><button type="button" disabled={locked} onClick={onClose}>关闭</button>{!settled && <button className={styles.primary} disabled={pending} type="submit">{pending ? "保存中…" : unconfirmed ? "重试同一操作" : "保存日程"}</button>}</div>
		</form>
	</DialogContent></Dialog>;
}
