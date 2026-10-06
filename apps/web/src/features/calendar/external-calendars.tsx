"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { CalendarDaysIcon, ChevronLeftIcon, ChevronRightIcon, LoaderIcon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { ConnectionAuthorizationDialog } from "@/components/agents/connection-authorization-dialog";
import { CalendarProviderApiError, listCalendarProviders, listProviderCalendars, listProviderCalendarEvents, type CalendarDisplayEvent, type CalendarProviderDescriptor, type ExternalCalendarSource } from "@/lib/api";
import type { ExtensionConnectionStatus } from "@/lib/types";
import styles from "./calendar.module.css";
import { appendCalendarSelections, calendarSelectionKey as key, type CalendarSelection as Selection } from "./sources";

const STORAGE = "puddingteams-calendar-selection";
const MAX = 10;
const failure = (e: unknown) => e instanceof Error ? e : new Error("日历加载失败，请重试");
const colorStyle = (color: string): CSSProperties => ({ "--calendar-color": color } as CSSProperties);

export function ExternalCalendars({ start, end, onEvents, onLoadingChange, refreshKey }: { start: string; end: string; onEvents: (events: CalendarDisplayEvent[]) => void; onLoadingChange: (loading: boolean) => void; refreshKey: number }) {
	const router = useRouter();
	const [selection, setSelection] = useState<Selection[]>([]), [ready, setReady] = useState(false);
	const [providers, setProviders] = useState<CalendarProviderDescriptor[] | null>(null), [catalogError, setCatalogError] = useState<Error | null>(null);
	const [activeId, setActiveId] = useState<string | null>(null), [picker, setPicker] = useState(false), [auth, setAuth] = useState(false);
	const [sources, setSources] = useState<ExternalCalendarSource[] | null>(null), [draft, setDraft] = useState<string[]>([]);
	const [loading, setLoading] = useState(false), [error, setError] = useState<Error | null>(null);
	const [eventsErrors, setEventsErrors] = useState<{ providerId: string; error: Error }[]>([]), [retry, setRetry] = useState(0);
	const eventsSequence = useRef(0), lists = useRef(0), catalogs = useRef(0);
	const active = providers?.find(p => p.id === activeId);
	const connection = useMemo<ExtensionConnectionStatus>(() => ({ id: `calendar:${activeId}`, extensionId: activeId ?? "calendar", connectionId: "default", extensionName: active?.name ?? "日历", name: `${active?.name ?? "日历"}日历`, state: "disconnected", checkedAt: "" }), [activeId, active?.name]);
	const loadProviders = useCallback(async () => {
		const serial = ++catalogs.current; setCatalogError(null);
		try { const next = await listCalendarProviders(); if (serial === catalogs.current) setProviders(next); }
		catch (e) { if (serial === catalogs.current) setCatalogError(failure(e)); }
	}, []);
	useEffect(() => {
		let mounted = true; const listState = lists, catalogState = catalogs;
		queueMicrotask(() => {
			if (!mounted) return;
			try {
				const saved: unknown = JSON.parse(localStorage.getItem(STORAGE) ?? "[]");
				if (Array.isArray(saved)) {
					const seen = new Set<string>();
					setSelection(saved.filter((s): s is Selection => {
						if (!s || typeof s.providerId !== "string" || typeof s.id !== "string" || typeof s.name !== "string" || typeof s.visible !== "boolean") return false;
						const id = key(s); if (seen.has(id)) return false; seen.add(id); return true;
					}).slice(0, MAX));
				}
			} catch {}
			setReady(true); void loadProviders();
		});
		return () => { mounted = false; listState.current++; catalogState.current++; };
	}, [loadProviders]);
	useEffect(() => { if (ready) { try { localStorage.setItem(STORAGE, JSON.stringify(selection)); } catch {} } }, [ready, selection]);
	const loadSources = useCallback(async (id: string) => {
		const serial = ++lists.current; setLoading(true); setError(null); setSources(null);
		try { const next = await listProviderCalendars(id); if (serial === lists.current) { setSources(next); setDraft(previous => previous.filter(value => next.some(source => source.id === value))); } }
		catch (e) { if (serial === lists.current) setError(failure(e)); }
		finally { if (serial === lists.current) setLoading(false); }
	}, []);
	const choose = (id: string) => { setActiveId(id); setDraft([]); void loadSources(id); };
	const completed = useCallback(() => { setAuth(false); setRetry(n => n + 1); if (activeId) void loadSources(activeId); }, [activeId, loadSources]);
	useEffect(() => {
		const state = eventsSequence, serial = ++state.current;
		const selected = selection.filter(s => s.visible && providers?.some(p => p.id === s.providerId));
		const load = async () => {
			onEvents([]); setEventsErrors([]); onLoadingChange(Boolean(ready && selected.length && start && end));
			if (!ready || !selected.length || !start || !end) return;
			const results = await Promise.allSettled(selected.map(async source => (await listProviderCalendarEvents(source.providerId, source.id, start, end)).map(event => ({ ...event, sourceName: source.name }))));
			if (state.current !== serial) return;
			onEvents(results.flatMap(result => result.status === "fulfilled" ? result.value : []));
			const errors = new Map<string, Error>();
			results.forEach((result, i) => { if (result.status === "rejected") errors.set(selected[i].providerId, failure(result.reason)); });
			setEventsErrors([...errors].map(([providerId, error]) => ({ providerId, error }))); onLoadingChange(false);
		};
		void load(); return () => { state.current++; onLoadingChange(false); };
	}, [ready, selection, providers, start, end, onEvents, onLoadingChange, retry, refreshKey]);
	const help = (e: Error, provider?: CalendarProviderDescriptor, inline = false) => <div className={styles.sourceError} role="alert">
		<p>{inline && provider ? `${provider.name}：` : ""}{e.message}</p>
		{e instanceof CalendarProviderApiError && e.code === "not_configured" && provider?.setupUrl ? <Button size="sm" variant="outline" onClick={() => router.push(provider.setupUrl!)}>配置{provider.name}应用</Button>
			: e instanceof CalendarProviderApiError && ["authorization_required", "permission_required"].includes(e.code) && provider?.authorization ? <Button size="sm" onClick={() => { if (inline) { setPicker(true); choose(provider.id); } setAuth(true); }}>用户授权</Button>
				: <Button size="sm" variant="outline" onClick={() => { if (inline) setRetry(n => n + 1); else if (provider) void loadSources(provider.id); else void loadProviders(); }}>重试</Button>}
	</div>;
	const alreadyAdded = (id: string) => selection.some(s => s.providerId === activeId && s.id === id);
	return <>
		<div className={styles.externalSources}>
			{selection.map(source => {
				const provider = providers?.find(p => p.id === source.providerId);
				const label = `${provider?.name ?? "外部日历"} · ${source.name}`;
				return <div key={key(source)} className={styles.sourceRow} style={colorStyle(provider?.color ?? "#818cf8")}><label className={styles.check}><input type="checkbox" checked={source.visible} onChange={e => setSelection(previous => previous.map(s => key(s) === key(source) ? { ...s, visible: e.target.checked } : s))} /><span className={`${styles.dot} ${styles.sourceDot}`} /><span title={label}>{label}</span></label><button className={styles.removeSource} aria-label={`移除${label}`} title="仅从本页移除，不撤销授权" onClick={() => setSelection(previous => previous.filter(s => key(s) !== key(source)))}><XIcon size={12} /></button></div>;
			})}
			<button className={styles.addSource} onClick={() => { lists.current++; setActiveId(null); setPicker(true); if (!providers || catalogError) void loadProviders(); }}><PlusIcon size={13} />添加日历</button>
			{catalogError && help(catalogError)}
			{eventsErrors.map(({ providerId, error }) => <div key={providerId}>{help(error, providers?.find(p => p.id === providerId), true)}</div>)}
		</div>
		<Dialog open={picker} onOpenChange={setPicker}><DialogContent className={styles.dialog}>
			<DialogTitle>{active ? `${active.name}日历` : "添加日历"}</DialogTitle>
			<DialogDescription>{active ? `追加到「我的日历」，保留已添加日历。${active.readOnly ? "此来源的日程暂为只读。" : ""}最多添加 ${MAX} 个外部日历。` : "选择日历来源，连接后追加到「我的日历」。平台日历及已添加日历保持不变。"}</DialogDescription>
			{active ? <>
				<button className={styles.backSource} onClick={() => { lists.current++; setActiveId(null); }}><ChevronLeftIcon size={14} />选择其他来源</button>
				{loading ? <p className={styles.hint} role="status"><LoaderIcon className="inline size-4 animate-spin" /> 正在读取日历…</p> : error ? help(error, active) : sources?.length ? <div className={styles.sourceChoices} style={colorStyle(active.color)}>{sources.map(source => <label key={source.id} className={styles.check}><input type="checkbox" checked={alreadyAdded(source.id) || draft.includes(source.id)} disabled={alreadyAdded(source.id) || (!draft.includes(source.id) && draft.length + selection.length >= MAX)} onChange={e => setDraft(previous => e.target.checked ? [...previous, source.id] : previous.filter(id => id !== source.id))} /><span className={`${styles.dot} ${styles.sourceDot}`} /><span>{source.name}{source.type === "primary" && <small>主日历</small>}{alreadyAdded(source.id) && <small>已添加</small>}</span></label>)}</div> : sources ? <p className={styles.hint}>连接正常，暂无可添加的日历。</p> : null}
			</> : catalogError ? help(catalogError) : providers ? <div className={styles.providerChoices}>{providers.map(provider => <button key={provider.id} className={styles.providerCard} style={colorStyle(provider.color)} onClick={() => choose(provider.id)}><span className={styles.providerIcon}><CalendarDaysIcon size={21} /></span><span className={styles.providerText}><strong>{provider.name}</strong><span>{provider.description}</span><small>{provider.readOnly ? "只读日历" : "日历来源"}{selection.some(s => s.providerId === provider.id) ? " · 可继续追加日历" : ""}</small></span><ChevronRightIcon size={16} /></button>)}{!providers.length && <p className={styles.hint}>暂无可接入的外部日历来源。</p>}</div> : <p className={styles.hint} role="status">正在读取日历来源…</p>}
			<DialogFooter><Button variant="ghost" onClick={() => setPicker(false)}>取消</Button>{active && <Button disabled={loading || Boolean(error) || sources === null || !draft.length} onClick={() => {
				const added = (sources ?? []).filter(s => draft.includes(s.id)).map(s => ({ providerId: active.id, id: s.id, name: s.name, visible: true }));
				setSelection(previous => appendCalendarSelections(previous, added)); setPicker(false);
			}}>追加日历</Button>}</DialogFooter>
		</DialogContent></Dialog>
		{auth && active?.authorization && <ConnectionAuthorizationDialog connection={connection} actionId="authorize-user" authorizationBase={`/api/calendar/providers/${encodeURIComponent(active.id)}/authorizations`} scopeDescription={active.authorization.description} onClose={() => setAuth(false)} onCompleted={completed} />}
	</>;
}
