"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useWorkerProcess } from "@/hooks/useWorkerProcess";
import { fetchRoomDelegationProcesses, type WorkerProcessListItem } from "@/lib/api";
import { groupForRender } from "@/lib/events";
import { delegationMessageEnd } from "@/lib/worker-process-scope";
import { workerProcessEmptyState } from "@/lib/worker-process-presentation";
import { useAgentLabel } from "@/lib/avatars";
import { Loader } from "@/components/ai-elements/loader";
import { AssistantGroup, Message } from "./message";
import { WorkerAvatar } from "./worker-avatar";
import { WorkerProcessProvider } from "./worker-process-context";

const HistoryReadiness = createContext({ enabled: false, indexReady: false, indexed: [] as string[], pending: [] as string[], unconfirmed: [] as string[], indexError: null as string | null, indexRetrying: false, retryIndex: () => {} });

/** Keep message components mounted to load history, but reveal the whole transcript together. */
export function InlinePiHistoryGate({ ids, historyLoading, onReady, onReadinessChange, children }: { ids: string[]; historyLoading: boolean; onReady?: () => void; onReadinessChange?: (ready: boolean) => void; children: ReactNode }) {
	const state = useContext(HistoryReadiness);
	const readReady = !state.enabled || (state.indexReady && !state.indexError && ids.every((id) => state.indexed.includes(id) && !state.unconfirmed.includes(id)));
	return <>
		{state.enabled && state.indexError && !historyLoading ? <div role="alert" className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-foreground">
			<span>Worker 执行记录暂不可用，主会话仍可查看。</span>
			<button type="button" disabled={state.indexRetrying} className="font-medium text-primary underline underline-offset-2 disabled:opacity-50" onClick={state.retryIndex}>{state.indexRetrying ? "正在重试…" : "重试执行记录"}</button>
		</div> : null}
		<HistoryGate key={String(state.enabled)} loading={historyLoading || (state.enabled && (!state.indexReady || state.pending.some((id) => ids.includes(id))))} readReady={readReady} onReady={onReady} onReadinessChange={onReadinessChange}>{children}</HistoryGate>
	</>;
}

function HistoryGate({ loading, readReady, onReady, onReadinessChange, children }: { loading: boolean; readReady: boolean; onReady?: () => void; onReadinessChange?: (ready: boolean) => void; children: ReactNode }) {
	const [revealed, setRevealed] = useState(false);
	// Latch once: later live turns must not hide an already visible conversation.
	if (!loading && !revealed) setRevealed(true);
	useEffect(() => { if (revealed && readReady) onReady?.(); }, [revealed, readReady, onReady]);
	useEffect(() => { onReadinessChange?.(revealed && readReady); }, [revealed, readReady, onReadinessChange]);
	const waiting = loading && !revealed;
	return <>
		{waiting ? <p role="status" className="py-16 text-center text-sm text-muted-foreground">正在加载对话…</p> : null}
		<div hidden={waiting} aria-busy={waiting} className={waiting ? undefined : "contents"}>{children}</div>
	</>;
}

type InlinePiProcessProps = { item: WorkerProcessListItem; until: number; fallback?: string; onReady: (id: string, confirmed: boolean) => void; openWorkerProcess: (id: string, fullSession?: boolean) => void };

function InlinePiProcess({ item, until, fallback, onReady, openWorkerProcess }: InlinePiProcessProps) {
	return <InlinePiProcessAttempt item={item} until={until} fallback={fallback} onReady={onReady} openWorkerProcess={openWorkerProcess} />;
}

function InlinePiProcessAttempt({ item, until, fallback, onReady, openWorkerProcess }: InlinePiProcessProps) {
	const active = ["running", "waiting_input", "cancel_requested", "reconciling"].includes(item.executionState);
	const process = useWorkerProcess(item.delegationId, false, item.live && active && until === Infinity);
	const label = useAgentLabel(item.agentId);
	const emptyState = workerProcessEmptyState(item.executionState, process.live, Boolean(process.connectionError));
	useEffect(() => {
		if (!process.loading) onReady(item.delegationId, !process.error);
	}, [process.loading, process.error, item.delegationId, onReady]);
	// Shared Pi sessions contain later delegations too. Never replay those in an older turn.
	const messages = process.messages.filter((message) => message.timestamp < until && message.role !== "user");
	if (process.loading) return <p role="status" className="py-3 text-xs text-muted-foreground">正在加载 Worker 对话…</p>;
	if (process.error) return <div role="alert" className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-foreground">
		<p>{process.scopeError ? process.error : "Worker 执行记录暂时无法加载。"}</p>
		{fallback ? <p className="whitespace-pre-wrap text-muted-foreground">{fallback}</p> : null}
		{process.scopeError
			? <button type="button" className="font-medium text-primary underline underline-offset-2" onClick={() => openWorkerProcess(item.delegationId, true)}>核对完整会话</button>
			: <button type="button" disabled={process.refreshing} className="font-medium text-primary underline underline-offset-2 disabled:opacity-50" onClick={process.refresh}>{process.refreshing ? "正在重新读取…" : "重试这条执行记录"}</button>}
	</div>;
	const connectionWarning = process.connectionError ? <div role="alert" className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-foreground"><p>{process.connectionError}</p><button type="button" disabled={process.refreshing} className="font-medium text-primary underline underline-offset-2 disabled:opacity-50" onClick={process.refresh}>{process.refreshing ? "正在重新读取…" : "重新读取执行记录"}</button></div> : null;
	if (messages.length === 0) return <>{connectionWarning}<div className="flex items-start gap-2.5" role={emptyState.pending && !fallback ? "status" : undefined}>
		<WorkerAvatar name={item.agentId} size={34} />
		<div className="min-w-0 pt-1"><p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p><div className="flex items-center gap-2 whitespace-pre-wrap text-sm">{emptyState.pending && !fallback ? <Loader size={14} /> : null}{fallback || emptyState.text}</div></div>
	</div></>;
	return <>{connectionWarning}<div className="flex min-w-0 flex-col gap-5" aria-label="Worker 执行对话">
		{groupForRender(messages).map((entry) => "kind" in entry
			? <AssistantGroup key={entry.id} roomId="" messages={entry.messages} windowType="direct" assistantAs={item.agentId} />
			: <Message key={entry.id} roomId="" message={entry} windowType="direct" assistantAs={item.agentId} />)}
	</div></>;
}

/** Display preference only: dispatch, approvals and cancellation keep their existing owners. */
export function InlinePiProcessProvider({ enabled, roomId, sessionId, openWorkerProcess, children }: {
	enabled: boolean; roomId: string; sessionId: string;
	openWorkerProcess: (id: string, fullSession?: boolean) => void; children: ReactNode;
}) {
	const [items, setItems] = useState<WorkerProcessListItem[]>([]);
	const [indexReady, setIndexReady] = useState(false);
	const [indexError, setIndexError] = useState<string | null>(null);
	const [indexRetrying, setIndexRetrying] = useState(false);
	const [indexRetry, setIndexRetry] = useState(0);
	const retryIndex = useCallback(() => { if (!indexRetrying) { setIndexRetrying(true); setIndexRetry((value) => value + 1); } }, [indexRetrying]);
	const [readyIds, setReadyIds] = useState<Set<string>>(() => new Set());
	const [confirmedIds, setConfirmedIds] = useState<Set<string>>(() => new Set());
	const [previousEnabled, setPreviousEnabled] = useState(enabled);
	if (previousEnabled !== enabled) {
		setPreviousEnabled(enabled);
		setIndexReady(false);
		setIndexError(null);
		setIndexRetrying(false);
		setReadyIds(new Set());
		setConfirmedIds(new Set());
	}
	const onReady = useCallback((id: string, confirmed: boolean) => {
		setReadyIds((previous) => previous.has(id) ? previous : new Set([...previous, id]));
		setConfirmedIds((previous) => {
			if (previous.has(id) === confirmed) return previous;
			const next = new Set(previous);
			if (confirmed) next.add(id);
			else next.delete(id);
			return next;
		});
	}, []);
	useEffect(() => {
		if (!enabled) return;
		let disposed = false;
		let timer: ReturnType<typeof setTimeout>;
		const refresh = async () => {
			try {
				const next = await fetchRoomDelegationProcesses(roomId, sessionId);
				if (!disposed) { setItems(next.filter((item) => item.view === "session")); setIndexError(null); }
			} catch (error) {
				if (!disposed) setIndexError(error instanceof Error ? error.message : String(error));
			} finally {
				if (!disposed) setIndexReady(true);
				if (!disposed) setIndexRetrying(false);
				if (!disposed) timer = setTimeout(() => void refresh().catch(() => undefined), 2500);
			}
		};
		void refresh();
		return () => { disposed = true; clearTimeout(timer); };
	}, [enabled, roomId, sessionId, indexRetry]);
	const workerItems = items.filter((item) => item.workerStarted);
	return <HistoryReadiness.Provider value={{ enabled, indexReady, indexed: items.map((item) => item.delegationId), pending: workerItems.filter((item) => !readyIds.has(item.delegationId)).map((item) => item.delegationId), unconfirmed: workerItems.filter((item) => !confirmedIds.has(item.delegationId)).map((item) => item.delegationId), indexError, indexRetrying, retryIndex }}><WorkerProcessProvider value={{ openWorkerProcess, renderInlineProcess: enabled ? (id, fallback) => {
		const item = items.find((candidate) => candidate.delegationId === id);
		if (!item?.workerStarted) return null;
		const until = delegationMessageEnd(item, items);
		return <WorkerProcessProvider value={{ openWorkerProcess }}><InlinePiProcess key={id} item={item} until={until} fallback={fallback} onReady={onReady} openWorkerProcess={openWorkerProcess} /></WorkerProcessProvider>;
	} : undefined }}>{children}</WorkerProcessProvider></HistoryReadiness.Provider>;
}
