"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { InboxIcon, Layers3Icon, LoaderCircleIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { SectionTopbar } from "@/components/section-topbar";
import { Button } from "@/components/ui/button";
import {
	createMemo,
	deleteMemo,
	listMemos,
	restoreMemo,
	updateMemo,
	type Memo,
	type MemoCounts,
	type PromoteMemoResult,
} from "@/lib/memos";
import {
	EMPTY_MEMO_COUNTS,
	hasActiveAttempt,
	mergeMemoPage,
	mergeMemoStatus,
	pruneMemoSelection,
	selectedMemos,
	type MemoListState,
} from "@/lib/memo-list";
import { canSelectMemo } from "@/lib/memo-presentation";
import { newMemoOperationId, operationIdFor } from "@/lib/memo-draft";
import { notifyMemosChanged, MEMO_CHANGED_EVENT } from "@/lib/memo-inbox-count";
import { MemoComposer } from "./memo-composer";
import { MemoTimeline } from "./memo-timeline";
import { PromoteMemosDialog } from "./promote-memos-dialog";
import { MEMO_CAPTURE_EVENT } from "./memo-capture";
import "./memos.css";

const FILTERS = [
	{ id: "unorganized", label: "未整理" },
	{ id: "promoting", label: "整理中" },
	{ id: "organized", label: "已整理" },
	{ id: "all", label: "全部" },
] as const;
const SELECT_LIMIT = 50;

function normalizeFilter(value: string | null): string {
	return FILTERS.some((filter) => filter.id === value) ? value! : "unorganized";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "请求失败，请重试";
}

export function MemosApp() {
	const router = useRouter();
	const params = useSearchParams();
	const filter = normalizeFilter(params.get("filter"));
	const tag = params.get("tag") ?? "";
	const urlQuery = params.get("q") ?? "";

	const [query, setQuery] = useState(urlQuery);
	const [search, setSearch] = useState(urlQuery);
	const [list, setList] = useState<MemoListState | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState("");
	const [composer, setComposer] = useState("");
	const [creating, setCreating] = useState(false);
	const [creatingError, setCreatingError] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [promoteOpen, setPromoteOpen] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const listEpoch = useRef(0);
	const createAttempt = useRef<{ text: string; operationId: string } | null>(null);
	const paramsRef = useRef({ filter, tag, search });
	const itemsRef = useRef<Memo[]>([]);
	const countsRef = useRef<MemoCounts>(EMPTY_MEMO_COUNTS);

	useEffect(() => { paramsRef.current = { filter, tag, search }; }, [filter, tag, search]);
	useEffect(() => { itemsRef.current = list?.items ?? []; }, [list]);

	/** 计数变化时同步侧栏徽标；同一请求链内只触发一次。 */
	const syncCounts = useCallback((next: MemoCounts) => {
		const changed = next.unorganized !== countsRef.current.unorganized;
		countsRef.current = next;
		if (changed) notifyMemosChanged();
	}, []);

	const navigate = useCallback((patch: Record<string, string>) => {
		const next = new URLSearchParams(params.toString());
		for (const [key, value] of Object.entries(patch)) {
			if (value) next.set(key, value);
			else next.delete(key);
		}
		router.replace(`/memos${next.size ? `?${next}` : ""}`);
	}, [params, router]);

	useEffect(() => {
		const timer = setTimeout(() => {
			if (query !== urlQuery) {
				setSearch(query);
				navigate({ q: query });
			}
		}, 250);
		return () => clearTimeout(timer);
	}, [query, urlQuery, navigate]);

	const fetchPage = useCallback(async (cursor?: string) => {
		const request = { filter, tag, search };
		const epoch = ++listEpoch.current;
		try {
			const data = await listMemos({ ...request, ...(cursor ? { before: cursor } : {}) });
			if (epoch !== listEpoch.current) return null;
			// 响应回来时查询身份已变：丢弃，避免旧筛选写进新列表。
			const current = paramsRef.current;
			if (current.filter !== request.filter || current.tag !== request.tag || current.search !== request.search) return null;
			setLoadError("");
			return data;
		} catch (error) {
			if (epoch === listEpoch.current) setLoadError(errorMessage(error));
			return null;
		}
	}, [filter, tag, search]);

	const reload = useCallback(async (cursor?: string) => {
		const data = await fetchPage(cursor);
		// 首屏/筛选请求无论成功失败都要结束 loading，否则空列表会一直显示「正在读取」。
		if (!cursor) setLoading(false);
		if (!data) return;
		setList((previous) => mergeMemoPage(previous, data, cursor));
		if (!cursor) setSelected((previous) => pruneMemoSelection(previous, data.items, canSelectMemo));
		syncCounts(data.counts);
	}, [fetchPage, syncCounts]);

	/** 轮询与重新可见：更新状态、插入新条目，但保留已加载的后续页。 */
	const refresh = useCallback(async () => {
		const data = await fetchPage();
		if (!data) return;
		const merged = mergeMemoStatus(itemsRef.current, data.items);
		setList((previous) => previous
			? { ...previous, items: mergeMemoStatus(previous.items, data.items), counts: data.counts, tags: data.tags }
			: { items: data.items, counts: data.counts, tags: data.tags, nextBefore: data.nextBefore });
		setSelected((previous) => pruneMemoSelection(previous, merged, canSelectMemo));
		syncCounts(data.counts);
	}, [fetchPage, syncCounts]);

	useEffect(() => {
		const timer = setTimeout(() => { setLoading(true); void reload(); }, 0);
		return () => clearTimeout(timer);
	}, [reload]);

	useEffect(() => {
		// 全局捕获或其它入口改了数据：首屏重载，删除的条目才会消失。
		const onChanged = () => { void reload(); };
		const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
		window.addEventListener(MEMO_CHANGED_EVENT, onChanged);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			window.removeEventListener(MEMO_CHANGED_EVENT, onChanged);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [reload, refresh]);

	const polling = list ? hasActiveAttempt(list.items) : false;
	useEffect(() => {
		if (!polling) return;
		const timer = setInterval(() => void refresh(), 2500);
		return () => clearInterval(timer);
	}, [polling, refresh]);

	const counts = list?.counts ?? EMPTY_MEMO_COUNTS;
	const items = useMemo(() => list?.items ?? [], [list]);
	const selectedItems = useMemo(() => selectedMemos(items, selected), [items, selected]);

	const openCapture = () => window.dispatchEvent(new Event(MEMO_CAPTURE_EVENT));

	const remove = async (memo: Memo) => {
		await deleteMemo(memo.id, { operationId: newMemoOperationId(), expectedRevision: memo.revision });
		setSelected((previous) => { const next = new Set(previous); next.delete(memo.id); return next; });
		notifyMemosChanged();
		await reload();
	};

	const undoCreate = async (memo: Memo) => {
		try {
			await remove(memo);
			toast.success("已撤销");
		} catch (error) {
			toast.error(errorMessage(error));
		}
	};

	const create = async (text: string) => {
		if (creating) return;
		const operationId = operationIdFor(text, createAttempt.current);
		createAttempt.current = { text, operationId };
		setCreating(true);
		setCreatingError("");
		try {
			const { memo } = await createMemo({ operationId, text });
			createAttempt.current = null;
			setComposer((previous) => (previous === text ? "" : previous));
			toast.success("已记下", { action: { label: "撤销", onClick: () => void undoCreate(memo) } });
			notifyMemosChanged();
			await reload();
		} catch (error) {
			setCreatingError(errorMessage(error));
		} finally {
			setCreating(false);
		}
	};

	const save = async (memo: Memo, text: string) => {
		await updateMemo(memo.id, { text, expectedRevision: memo.revision });
		toast.success("已保存修改");
		notifyMemosChanged();
		await reload();
	};

	const removeWithUndo = async (memo: Memo) => {
		try {
			await remove(memo);
			toast.success("已删除", {
				action: {
					label: "撤销",
					onClick: () => void restoreMemo(memo.id, { operationId: newMemoOperationId() })
						.then(() => { notifyMemosChanged(); return reload(); })
						.then(() => toast.success("已恢复"))
						.catch((error) => toast.error(errorMessage(error))),
				},
			});
		} catch (error) {
			toast.error(errorMessage(error));
		}
	};

	const toggleSelect = (id: string) => {
		setSelected((previous) => {
			const next = new Set(previous);
			if (next.has(id)) next.delete(id);
			else if (next.size >= SELECT_LIMIT) {
				toast.error(`一次最多整理 ${SELECT_LIMIT} 条`);
				return previous;
			} else next.add(id);
			return next;
		});
	};

	const promoteOne = (memo: Memo) => {
		setSelected(new Set([memo.id]));
		setPromoteOpen(true);
	};

	const submitted = async (result: PromoteMemoResult) => {
		setPromoteOpen(false);
		setSelected(new Set());
		toast.success(`已提交 ${result.memos.length} 条整理，生成候选后需要审核`);
		notifyMemosChanged();
		await reload();
	};

	const loadMore = async () => {
		if (!list?.nextBefore || loadingMore) return;
		setLoadingMore(true);
		try { await reload(list.nextBefore); } finally { setLoadingMore(false); }
	};

	const empty = loading
		? { title: "正在读取速记", body: "从本机服务加载收件箱。" }
		: loadError
			? { title: "读取速记失败", body: "本机服务暂时不可用，稍后重试。" }
			: search || tag
				? { title: "没有匹配的速记", body: "换个关键词，或清掉标签筛选。" }
				: filter === "organized"
					? { title: "还没有整理过的速记", body: "整理完成后会归到这里，正文不会被删除。" }
					: filter === "promoting"
						? { title: "没有进行中的整理", body: "勾选未整理的速记，就能提交给知识库整理。" }
						: { title: "收件箱是空的", body: "随手记一句，攒一攒再整理。" };

	return (
		<div className="memos-app">
			<SectionTopbar title="速记" />
			<header className="memos-header">
				<div className="memos-heading">
					<h1>速记</h1>
					<span>{list ? `${counts.unorganized} 条待整理` : "整理前先记下来"}</span>
				</div>
				<div className="memos-tools">
					<div className="memos-search">
						<SearchIcon className="size-3.5 shrink-0" aria-hidden="true" />
						<input
							value={query}
							type="search"
							aria-label="搜索速记"
							placeholder="搜索速记"
							onChange={(event) => setQuery(event.target.value)}
						/>
						{query ? (
							<button type="button" aria-label="清空搜索" onClick={() => { setQuery(""); setSearch(""); navigate({ q: "" }); }}>
								<XIcon className="size-3.5" aria-hidden="true" />
							</button>
						) : null}
					</div>
					<Button type="button" size="sm" onClick={openCapture}>
						<PlusIcon aria-hidden="true" />
						新建速记
					</Button>
				</div>
			</header>

			<div className="memos-filters" role="group" aria-label="速记状态">
				{FILTERS.map((item) => (
					<button
						key={item.id}
						type="button"
						aria-pressed={filter === item.id}
						onClick={() => navigate({ filter: item.id === "unorganized" ? "" : item.id })}
					>
						{item.label}
						<em>{counts[item.id]}</em>
					</button>
				))}
			</div>

			{list?.tags.length ? (
				<div className="memos-tagbar" role="group" aria-label="标签筛选">
					<button type="button" aria-pressed={!tag} onClick={() => navigate({ tag: "" })}>全部标签</button>
					{list.tags.map((entry) => (
						<button
							key={entry.tag}
							type="button"
							aria-pressed={tag === entry.tag}
							onClick={() => navigate({ tag: tag === entry.tag ? "" : entry.tag })}
						>
							#{entry.tag}<em>{entry.count}</em>
						</button>
					))}
				</div>
			) : null}

			{loadError ? (
				<p className="memos-alert" role="alert">
					{loadError}
					<button type="button" onClick={() => void reload()}>重试</button>
				</p>
			) : null}

			<div className="memos-body">
				<div className="memos-column">
					{filter === "unorganized" || filter === "all" ? (
						<>
							<MemoComposer
								value={composer}
								onChange={setComposer}
								onSubmit={(value) => void create(value)}
								submitting={creating}
								disabled={creating}
							/>
							{creatingError ? <p className="memos-alert" role="alert">{creatingError}</p> : null}
						</>
					) : null}

					{items.length ? (
						<MemoTimeline
							memos={items}
							selected={selected}
							onSelect={toggleSelect}
							onSave={save}
							onDelete={(memo) => void removeWithUndo(memo)}
							onPromote={promoteOne}
						/>
					) : (
						<div className="memo-empty">
							<InboxIcon className="size-5" aria-hidden="true" />
							<strong>{empty.title}</strong>
							<p>{empty.body}</p>
							{search || tag ? (
								<Button type="button" variant="ghost" size="sm" onClick={() => { setQuery(""); setSearch(""); navigate({ q: "", tag: "" }); }}>
									清掉筛选
								</Button>
							) : null}
						</div>
					)}

					{list?.nextBefore ? (
						<div className="memo-load">
							<Button type="button" variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
								{loadingMore ? <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" /> : null}
								加载更多
							</Button>
						</div>
					) : null}

					{selectedItems.length ? (
						<div className="memo-selectbar" role="region" aria-label="已选速记操作">
							<strong>已选 {selectedItems.length} 条</strong>
							<span>整理会生成候选，不会直接改知识库</span>
							<div className="memo-selectbar-actions">
								<Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())}>取消选择</Button>
								<Button type="button" size="sm" onClick={() => setPromoteOpen(true)}>
									<Layers3Icon aria-hidden="true" />
									整理进知识库
								</Button>
							</div>
						</div>
					) : null}
				</div>
			</div>

			{promoteOpen ? (
				<PromoteMemosDialog
					open
					onOpenChange={setPromoteOpen}
					memos={selectedItems}
					onSubmitted={(result) => void submitted(result)}
					onConflict={async () => { setPromoteOpen(false); notifyMemosChanged(); await reload(); }}
				/>
			) : null}
		</div>
	);
}
