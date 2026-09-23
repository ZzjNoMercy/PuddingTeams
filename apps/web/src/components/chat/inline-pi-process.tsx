"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useWorkerProcess } from "@/hooks/useWorkerProcess";
import { fetchRoomDelegationProcesses, type WorkerProcessListItem } from "@/lib/api";
import { groupForRender } from "@/lib/events";
import { AssistantGroup, Message } from "./message";
import { WorkerProcessProvider } from "./worker-process-context";

const HistoryReadiness = createContext({ enabled: false, indexReady: false, pending: [] as string[] });

/** Keep message components mounted to load history, but reveal the whole transcript together. */
export function InlinePiHistoryGate({ ids, historyLoading, children }: { ids: string[]; historyLoading: boolean; children: ReactNode }) {
	const state = useContext(HistoryReadiness);
	return <HistoryGate key={String(state.enabled)} loading={historyLoading || (state.enabled && (!state.indexReady || state.pending.some((id) => ids.includes(id))))}>{children}</HistoryGate>;
}

function HistoryGate({ loading, children }: { loading: boolean; children: ReactNode }) {
	const [revealed, setRevealed] = useState(false);
	// Latch once: later live turns must not hide an already visible conversation.
	if (!loading && !revealed) setRevealed(true);
	const waiting = loading && !revealed;
	return <>
		{waiting ? <p role="status" className="py-16 text-center text-sm text-muted-foreground">正在加载对话…</p> : null}
		<div hidden={waiting} aria-busy={waiting} className={waiting ? undefined : "contents"}>{children}</div>
	</>;
}

function InlinePiProcess({ item, until, fallback, onReady }: { item: WorkerProcessListItem; until: number; fallback?: string; onReady: (id: string) => void }) {
	const active = ["running", "waiting_input", "cancel_requested", "reconciling"].includes(item.executionState);
	const process = useWorkerProcess(item.delegationId, false, item.live && active && until === Infinity);
	useEffect(() => {
		if (!process.loading) onReady(item.delegationId);
	}, [process.loading, item.delegationId, onReady]);
	// Shared Pi sessions contain later delegations too. Never replay those in an older turn.
	const messages = process.messages.filter((message) => message.timestamp < until && message.role !== "user");
	if (process.loading) return <p role="status" className="py-3 text-xs text-muted-foreground">正在加载 Worker 对话…</p>;
	if (process.error || messages.length === 0) return <div className="whitespace-pre-wrap text-sm">{fallback || (process.error ? "执行记录暂时无法加载，可关闭开关查看任务卡片。" : "等待 Worker 回复…")}</div>;
	return <div className="flex min-w-0 flex-col gap-5" aria-label="Worker 执行对话">
		{groupForRender(messages).map((entry) => "kind" in entry
			? <AssistantGroup key={entry.id} roomId="" messages={entry.messages} windowType="direct" assistantAs={item.agentId} />
			: <Message key={entry.id} roomId="" message={entry} windowType="direct" assistantAs={item.agentId} />)}
	</div>;
}

/** Display preference only: dispatch, approvals and cancellation keep their existing owners. */
export function InlinePiProcessProvider({ enabled, roomId, sessionId, openWorkerProcess, children }: {
	enabled: boolean; roomId: string; sessionId: string;
	openWorkerProcess: (id: string) => void; children: ReactNode;
}) {
	const [items, setItems] = useState<WorkerProcessListItem[]>([]);
	const [indexReady, setIndexReady] = useState(false);
	const [readyIds, setReadyIds] = useState<Set<string>>(() => new Set());
	const [previousEnabled, setPreviousEnabled] = useState(enabled);
	if (previousEnabled !== enabled) {
		setPreviousEnabled(enabled);
		setIndexReady(false);
		setReadyIds(new Set());
	}
	const onReady = useCallback((id: string) => setReadyIds((previous) => previous.has(id) ? previous : new Set([...previous, id])), []);
	useEffect(() => {
		if (!enabled) return;
		let disposed = false;
		let timer: ReturnType<typeof setTimeout>;
		const refresh = async () => {
			try {
				const next = await fetchRoomDelegationProcesses(roomId, sessionId);
				if (!disposed) setItems(next.filter((item) => item.view === "session"));
			} finally {
				if (!disposed) setIndexReady(true);
				if (!disposed) timer = setTimeout(() => void refresh().catch(() => undefined), 2500);
			}
		};
		void refresh().catch(() => undefined);
		return () => { disposed = true; clearTimeout(timer); };
	}, [enabled, roomId, sessionId]);
	return <HistoryReadiness.Provider value={{ enabled, indexReady, pending: items.filter((item) => item.workerStarted && !readyIds.has(item.delegationId)).map((item) => item.delegationId) }}><WorkerProcessProvider value={{ openWorkerProcess, renderInlineProcess: enabled ? (id, fallback) => {
		const item = items.find((candidate) => candidate.delegationId === id);
		if (!item?.workerStarted) return null;
		const sealedAt = item.receipt?.sealedAt ? Date.parse(item.receipt.sealedAt) : NaN;
		const until = Math.min(Number.isFinite(sealedAt) ? sealedAt + 1 : Infinity, ...items.filter((candidate) => candidate.agentId === item.agentId
			&& candidate.sessionHandle === item.sessionHandle && Date.parse(candidate.createdAt) > Date.parse(item.createdAt))
			.map((candidate) => Date.parse(candidate.createdAt)));
		return <WorkerProcessProvider value={{ openWorkerProcess }}><InlinePiProcess key={id} item={item} until={until} fallback={fallback} onReady={onReady} /></WorkerProcessProvider>;
	} : undefined }}>{children}</WorkerProcessProvider></HistoryReadiness.Provider>;
}
