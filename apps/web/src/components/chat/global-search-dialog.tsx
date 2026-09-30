"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BotIcon, LoaderIcon, MessageSquareIcon, RefreshCwIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { listAgents, listManagerWorks, listRooms } from "@/lib/api";
import type { AgentConfig, ManagerWorkIndexItem, RoomSummary } from "@/lib/types";
import { agentResults, filterSearchResults, managerWorkResults, roomResults, withManagerReturn, type SearchResult } from "@/lib/global-search-results";
import { loadSearchSources } from "@/lib/global-search-load";
import { isIMEComposing } from "@/lib/ime";

export function GlobalSearchDialog({ open, onOpenChange, returnSessionId }: { open: boolean; onOpenChange: (open: boolean) => void; returnSessionId?: string | null }) {
	const router = useRouter();
	const [query, setQuery] = useState("");
	const [rooms, setRooms] = useState<RoomSummary[] | null>(null);
	const [agents, setAgents] = useState<AgentConfig[] | null>(null);
	const [works, setWorks] = useState<ManagerWorkIndexItem[] | null>(null);
	const [errors, setErrors] = useState<string[]>([]);
	const [pending, setPending] = useState(3);
	const requestId = useRef(0);
	const invalidate = useCallback(() => {
		return ++requestId.current;
	}, []);
	const refresh = useCallback(() => {
		const currentRequest = invalidate();
		setRooms(null);
		setAgents(null);
		setWorks(null);
		setErrors([]);
		setPending(3);
		void loadSearchSources({ rooms: listRooms, agents: listAgents, works: listManagerWorks }, () => currentRequest === requestId.current, (event) => {
			if (!event.ok) {
				const label = event.source === "rooms" ? "工作与对话" : event.source === "agents" ? "智能体" : "Manager 工作";
				setErrors((previous) => [...previous, `${label}：${event.error instanceof Error ? event.error.message : String(event.error)}`]);
			} else if (event.source === "rooms") setRooms(event.value);
			else if (event.source === "agents") setAgents(event.value);
			else setWorks(event.value);
			setPending((count) => count - 1);
		});
	}, [invalidate]);
	useEffect(() => {
		if (!open) return;
		const timer = setTimeout(() => void refresh(), 0);
		return () => { clearTimeout(timer); invalidate(); };
	}, [open, refresh, invalidate]);
	const results = useMemo(() => {
		const chats = (rooms ?? []).filter((room) => room.type !== "solo");
		const fallbackWork = works === null ? (rooms ?? []).filter((room) => room.type === "solo") : [];
		return filterSearchResults([...managerWorkResults(works ?? []), ...roomResults([...chats, ...fallbackWork]), ...agentResults(agents ?? [])], query);
	}, [rooms, agents, works, query]);
	const searching = pending > 0;
	const allSourcesFailed = !searching && rooms === null && agents === null && works === null;
	const partialResults = errors.length > 0 && !allSourcesFailed;
	const openResult = (result: SearchResult) => {
		invalidate();
		onOpenChange(false);
		const source = returnSessionId ?? (window.location.pathname === "/chats" ? new URLSearchParams(window.location.search).get("returnSession") : null);
		router.push(withManagerReturn(result.href, source));
	};
	return <Dialog open={open} onOpenChange={(next) => { if (!next) invalidate(); onOpenChange(next); }}>
		<DialogContent className="max-h-[min(80dvh,680px)] gap-0 overflow-hidden p-0 sm:max-w-[640px]">
			<DialogHeader className="border-b border-border px-6 pb-4 pt-6">
				<DialogTitle>搜索工作与对话</DialogTitle>
				<DialogDescription>当前搜索工作、对话和智能体的标题与摘要；知识库资料搜索将在接入后开放。</DialogDescription>
			</DialogHeader>
			<div className="relative border-b border-border px-6 py-4">
				<SearchIcon className="pointer-events-none absolute left-9 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input autoFocus aria-label="搜索工作、对话和智能体" placeholder="输入名称或摘要…" value={query} onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || event.repeat || isIMEComposing(event) || searching || !results[0]) return;
						event.preventDefault();
						openResult(results[0]);
					}} className="pl-9" />
			</div>
			<div className="min-h-32 overflow-y-auto px-3 py-3">
				{searching ? <div role="status" className="flex items-center justify-center gap-2 py-3 text-sm text-muted-foreground"><LoaderIcon className="size-4 animate-spin" />{results.length ? "其他来源仍在加载…" : "正在搜索…"}</div> : null}
					{errors.length ? <div role="alert" className="mx-3 mb-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive"><p>{allSourcesFailed ? "搜索来源均暂时无法加载" : "部分结果暂时无法加载"}：{errors.join("；")}</p><Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => refresh()}><RefreshCwIcon className="size-3.5" />重试</Button></div> : null}
					{!searching && results.length === 0 ? <p className="py-12 text-center text-sm text-muted-foreground">{allSourcesFailed ? "搜索服务暂时不可用。" : query.trim() ? `${partialResults ? "已加载的来源中" : ""}没有找到匹配「${query.trim()}」的结果。` : partialResults ? "已加载的来源中暂无可搜索内容。" : "暂无可搜索的工作、对话或智能体。"}</p> : null}
				{results.map((item) => {
					const Icon = item.kind === "work" ? SparklesIcon : item.kind === "chat" ? MessageSquareIcon : BotIcon;
					return <button key={item.id} type="button" onClick={() => openResult(item)} className="flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none">
						<Icon className="mt-0.5 size-4 shrink-0 text-primary" />
						<span className="min-w-0"><strong className="block truncate text-sm font-medium">{item.title}</strong><small className="mt-1 block truncate text-xs text-muted-foreground">{item.description}</small></span>
					</button>;
				})}
			</div>
		</DialogContent>
	</Dialog>;
}
