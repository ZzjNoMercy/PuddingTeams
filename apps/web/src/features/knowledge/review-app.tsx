"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
	CheckIcon,
	ClipboardCheckIcon,
	FilePlusIcon,
	FilePenIcon,
	FileXIcon,
	LoaderCircleIcon,
	RefreshCwIcon,
	BookOpenIcon,
	ChevronRightIcon,
	FileTextIcon,
	SearchIcon,
	ShieldCheckIcon,
} from "lucide-react";
import {
	getWikiBatch,
	wikiBatchAssetUrl,
	getWikiBatchFile,
	getWikiPublication,
	closeWikiConflict,
	KnowledgeApiError,
	listKnowledgeBindings,
	listWikiBatchPage,
	listWikiPublications,
	submitWikiReview,	requestWikiRevision,	getWikiCuratorJob,	type WikiCuratorJob,
	type WikiBatchDetail,
	type WikiBatchStatus,
	type WikiBatchSummary,
	type WikiBatchPage,
	type WikiReviewStatusFilter,
} from "@/lib/api";
import type {
	WikiBatchFileView,
	WikiPublicationDetail,
	WikiPublicationState,
	WikiPublicationSummary,
} from "@/lib/api";
import { KnowledgeDiffView } from "./diff-view";
import { splitFrontmatter } from "./markdown";
import { KnowledgePageShell } from "./page-shell";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WIKI_REVIEW_CHANGED } from "@/lib/wiki-review-queue";
import { ReviewSources } from "./review-sources";
import { SnapshotMarkdown } from "./snapshot-markdown";
import { hasFrozenBatchImage } from "./snapshot-images";
import { publicationFeedback } from "./publication-feedback";

const batchStatusLabels: Record<WikiBatchStatus, string> = {
	candidate: "候选",
	pending_review: "待审核",
	approved: "已通过",
	publishing: "发布中",
	published: "已发布",
	partial: "部分发布",
	conflict: "冲突",
	rejected: "已拒绝",
	returned: "已退回修订",
};

const publicationStateLabels: Record<WikiPublicationState, string> = {
	queued: "排队中",
	running: "发布中",
	published: "已发布",
	partial: "部分发布",
	conflict: "冲突",
	unknown: "结果未知",
};

const publishFileStatusLabels: Record<string, string> = {
	pending: "未执行",
	applied: "已写入",
	failed: "失败",
	conflict: "冲突",
	uncertain: "结果未知",
	rejected: "已拒止",
	rolled_back: "已回滚",
};

const publishStepLabels: Record<string, string> = {
	preflight: "基线预读",
	before_image: "留存 before-image",
	write: "写入",
	verify: "写后校验",
	rollback: "回滚",
	reconcile: "启动对账",
};

function BatchStatusBadge({ status, closed = false }: { status: WikiBatchStatus; closed?: boolean }) {
	return <span className="wiki-batch-badge" data-status={closed ? "rejected" : status}>{closed ? "已关闭冲突" : batchStatusLabels[status]}</span>;
}

function PublicationStateBadge({ state }: { state: WikiPublicationState }) {
	return <span className="wiki-batch-badge" data-status={state}>{publicationStateLabels[state]}</span>;
}

function OperationBadge({ operation }: { operation: "create" | "update" | "delete" }) {
	if (operation === "create") {
		return <span className="wiki-op-badge" data-operation="create"><FilePlusIcon size={11} />新增</span>;
	}
	if (operation === "update") {
		return <span className="wiki-op-badge" data-operation="update"><FilePenIcon size={11} />修改</span>;
	}
	return <span className="wiki-op-badge" data-operation="delete"><FileXIcon size={11} />删除</span>;
}

const shortHash = (value: string) => value.slice(0, 12);
function batchHref(query: string, id: string) { const search = new URLSearchParams(query); search.delete("publication"); search.set("batch", id); return `/knowledge/review?${search}`; }
const formatTime = (value: string) => (value ? new Date(value).toLocaleString() : "—");

export function KnowledgeReviewApp() {
	const params = useSearchParams();
	const router = useRouter();
	const vault = params.get("vault");
	const batchId = params.get("batch");
	const publicationId = params.get("publication");
	const [bindings, setBindings] = useState<Array<{ id: string; name: string }>>([]);

	useEffect(() => {
		let active = true;
		void listKnowledgeBindings()
			.then((value) => { if (active) setBindings(value.map((item) => ({ id: item.id, name: item.name }))); })
			.catch(() => undefined);
		return () => { active = false; };
	}, []);

	const vaultName = bindings.find((item) => item.id === vault)?.name ?? "知识库";
	const listParams = new URLSearchParams(params.toString());
	listParams.delete("batch");
	listParams.delete("publication");
	const backToList = `/knowledge/review${listParams.size ? `?${listParams.toString()}` : ""}`;
	const vaultParams = new URLSearchParams();
	if (vault) vaultParams.set("vault", vault);
	if (vault && params.get("returnNote")) vaultParams.set("note", params.get("returnNote")!);
	const backToVault = `/knowledge${vaultParams.size ? `?${vaultParams.toString()}` : ""}`;
	const inDetail = Boolean(batchId || publicationId);

	return (
		<KnowledgePageShell
			title={publicationId
				? `发布记录 · ${batchId ? shortHash(batchId) : vaultName}`
				: batchId ? `审核批次 · ${shortHash(batchId)}` : "发布审核"}
			back={{ href: inDetail ? backToList : backToVault, label: inDetail ? "返回审核列表" : vault ? `返回 ${vaultName}` : "返回知识库首页" }}
			actions={inDetail ? (
				<Link href={backToList} className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm hover:bg-muted">
					<ClipboardCheckIcon size={14} />返回批次列表
				</Link>
			) : null}
			layout={inDetail ? "bleed" : "centered"}
		>
			{publicationId ? (
				<PublicationDetail key={publicationId} publicationId={publicationId} onBack={() => router.push(backToList)} />
			) : batchId ? (
				<BatchDetail key={batchId} batchId={batchId} vault={vault} bindings={bindings} />
			) : (
				<BatchList vault={vault} bindings={bindings} />
			)}
		</KnowledgePageShell>
	);
}

const reviewFilters: Array<{ value: WikiReviewStatusFilter; label: string }> = [
	{ value: "pending", label: "待审核" }, { value: "needs_action", label: "需处理" },
	{ value: "processed", label: "已处理" }, { value: "all", label: "全部" },
];

/** Server pagination and counts share the same owner-visible scope. */
function BatchList({ vault, bindings }: { vault: string | null; bindings: Array<{ id: string; name: string }> }) {
	const router = useRouter();
	const params = useSearchParams();
	const rawFilter = params.get("status");
	const filter = reviewFilters.find((item) => item.value === rawFilter)?.value ?? "pending";
	const query = params.get("q") ?? "";
	const rawOffset = Number(params.get("offset"));
	const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
	const [page, setPage] = useState<{ key: string; value: WikiBatchPage } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	const [searchInput, setSearchInput] = useState(query);
	const [previousQuery, setPreviousQuery] = useState(query);
	if (query !== previousQuery) { setPreviousQuery(query); setSearchInput(query); }
	const key = JSON.stringify([vault, filter, query, offset, nonce]);
	const current = page?.key === key ? page.value : null;
	const change = (values: Record<string, string | null>) => {
		const search = new URLSearchParams(params.toString());
		search.delete("offset");
		for (const [name, value] of Object.entries(values)) {
			if (value) search.set(name, value); else search.delete(name);
		}
		router.replace(`/knowledge/review${search.size ? `?${search.toString()}` : ""}`, { scroll: false });
	};

	useEffect(() => {
		let active = true;
		let loading = false;
		const refresh = async () => {
			if (document.hidden || loading) return;
			loading = true;
			try {
				const value = await listWikiBatchPage({ bindingId: vault ?? undefined, status: filter, q: query, limit: 20, offset });
				if (active) { setPage({ key, value }); setError(null); }
			} catch (cause) {
				if (active) setError(cause instanceof Error ? cause.message : String(cause));
			} finally { loading = false; }
		};
		void refresh();
		const timer = window.setInterval(() => void refresh(), 4000);
		document.addEventListener("visibilitychange", refresh);
		return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
	}, [vault, filter, query, offset, nonce, key]);

	const open = (batch: WikiBatchSummary) => {
		const search = new URLSearchParams(params.toString());
		search.set("batch", batch.id);
		router.push(`/knowledge/review?${search.toString()}`);
	};
	const counts = current ? { pending: current.pendingCount, needs_action: current.needsActionCount, processed: current.processedCount, all: current.total } : null;
	const vaultOptions = new Map(bindings.map((binding) => [binding.id, binding.name]));
	for (const batch of current?.batches ?? []) if (!vaultOptions.has(batch.bindingId)) vaultOptions.set(batch.bindingId, batch.bindingName ?? batch.bindingId);
	if (vault && !vaultOptions.has(vault)) vaultOptions.set(vault, vault);

	return (
		<section className="wiki-review-center">
			<div className="wiki-review-heading">
				<div><p className="wiki-review-kicker">KNOWLEDGE REVIEW</p><h2>{vault ? `${vaultOptions.get(vault) ?? "知识库"} · 发布审核` : "全部知识库的发布审核"}</h2><p>集中查看待审核变更，确认后更新对应知识库。</p></div>
				<span className="wiki-review-total"><ClipboardCheckIcon size={15} /><strong>{current?.pendingCount ?? "…"}</strong>{vault ? "当前库待审核" : "全局待审核"}</span>
			</div>
			<div className="wiki-review-toolbar">
				<div className="wiki-review-tabs" aria-label="审核状态筛选">
					{reviewFilters.map((item) => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => change({ status: item.value })}>{item.label}<span>{counts?.[item.value] ?? "…"}</span></button>)}
				</div>
				<div className="wiki-review-filters">
					<label className="wiki-review-select"><BookOpenIcon size={14} /><select aria-label="筛选知识库" value={vault ?? ""} onChange={(event) => change({ vault: event.target.value || null, returnNote: null })}><option value="">全部知识库</option>{[...vaultOptions].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
					<form className="wiki-review-search" onSubmit={(event) => { event.preventDefault(); change({ q: searchInput.trim() || null }); }}><SearchIcon size={14} /><input aria-label="搜索审核内容" placeholder="搜索标题或知识库" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} /><button type="submit" aria-label="执行搜索">搜索</button></form>
				</div>
			</div>
			<div className="wiki-review-scope"><span>{vault ? `仅查看 ${vaultOptions.get(vault)}` : "汇总所有有权查看的知识库"}</span><span>共 {current?.filteredTotal ?? "…"} 项</span></div>
			{error ? <p role="alert" className="mb-4 text-sm text-destructive">{error} <button type="button" onClick={() => setNonce((value) => value + 1)} className="underline">重试</button></p> : null}
			{!current ? <p className="py-10 text-sm text-muted-foreground">正在加载…</p> : current.batches.length === 0 ? (
				<div className="wiki-review-empty"><ClipboardCheckIcon size={30} /><h3>{filter === "pending" && !query ? "当前范围没有待审核项" : "没有匹配的审核记录"}</h3><p>可以切换知识库或查看其他状态。</p><button type="button" onClick={() => change({ vault: null, status: "all", q: null, returnNote: null })}>查看全部记录</button></div>
			) : <div className="wiki-review-cards">{current.batches.map((batch) => (
				<button key={batch.id} type="button" onClick={() => open(batch)} className="wiki-review-card">
					<span className="wiki-review-card-icon"><FileTextIcon size={23} /></span>
					<span className="wiki-review-card-copy"><span className="wiki-review-card-title"><strong>{batch.title || `候选批次 ${shortHash(batch.id)}`}</strong>{batch.conflictClosure ? <span className="wiki-batch-badge">已关闭冲突</span> : <BatchStatusBadge status={batch.status} />}</span><span className="wiki-review-card-description">{batch.fileCount} 项文件的固定候选 · {shortHash(batch.manifestHash)}</span><span className="wiki-review-card-meta"><span className="wiki-review-vault"><BookOpenIcon size={12} />{batch.bindingName ?? vaultOptions.get(batch.bindingId) ?? batch.bindingId}{batch.bindingAvailability === "offline" ? " · 离线" : ""}</span><span>{formatTime(batch.enteredReviewAt)}</span><span>{batch.fileCount} 项变更</span><span>版本 {batch.revision}</span></span></span>
					<ChevronRightIcon size={19} className="shrink-0 text-muted-foreground" />
				</button>
			))}</div>}
			{current && current.filteredTotal > 20 ? <nav aria-label="审核列表分页" className="mt-5 flex items-center justify-end gap-3 text-sm"><button type="button" disabled={offset === 0} onClick={() => change({ offset: String(Math.max(0, offset - 20)) })} className="rounded border px-3 py-2 disabled:opacity-40">上一页</button><span>{offset + 1}–{Math.min(offset + current.batches.length, current.filteredTotal)} / {current.filteredTotal}</span><button type="button" disabled={offset + 20 >= current.filteredTotal} onClick={() => change({ offset: String(offset + 20) })} className="rounded border px-3 py-2 disabled:opacity-40">下一页</button></nav> : null}
			<div className="wiki-review-list-tip"><ShieldCheckIcon size={17} /><p>每条记录明确对应一个知识库。审核与来源会话独立保存，确认后按固定候选发布。</p></div>
		</section>
	);
}

/** 批次详情：pending_review 进审核工作台，其余状态如实展示并引导。 */
function BatchDetail({ batchId, vault, bindings }: { batchId: string; vault: string | null; bindings: Array<{ id: string; name: string }> }) {
	const [batch, setBatch] = useState<WikiBatchDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		let active = true;
		void getWikiBatch(batchId)
			.then((value) => { if (active) { setBatch(value); setError(null); } })
			.catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { active = false; };
	}, [batchId, nonce]);
	const recordedStatus = batch?.status;
	const recordedChild = batch?.returnRequest?.newBatchId;
	const awaitingPublication = batch?.status === "approved" || batch?.status === "publishing" || (batch?.status === "returned" && !batch.returnRequest?.newBatchId);
	useEffect(() => {
		if (!awaitingPublication) return;
		let active = true;
		let loading = false;
		const poll = async () => {
			if (document.hidden || loading) return;
			loading = true;
			try {
				const value = await getWikiBatch(batchId);
				if (active) { setBatch(value); setError(null); if (value.status !== recordedStatus || (value.returnRequest?.newBatchId && !recordedChild)) window.dispatchEvent(new Event(WIKI_REVIEW_CHANGED)); }
			} catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
			finally { loading = false; }
		};
		const timer = window.setInterval(() => void poll(), 1500);
		document.addEventListener("visibilitychange", poll);
		return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", poll); };
	}, [batchId, awaitingPublication, recordedStatus, recordedChild]);

	if (error) {
		return (
			<div className="p-6">
				<p role="alert" className="text-sm text-destructive">
					{error}{" "}
					<button type="button" onClick={() => setNonce((value) => value + 1)} className="underline">重试</button>
				</p>
			</div>
		);
	}
	if (!batch) return <p className="p-6 text-sm text-muted-foreground">正在加载…</p>;
	const namedBatch = { ...batch, bindingName: batch.bindingName ?? bindings.find((item) => item.id === batch.bindingId)?.name };
	if (batch.status === "pending_review" || batch.status === "approved" || batch.status === "publishing") {
		return <ReviewWorkspace key={`${batch.id}:${batch.revision}:${batch.manifestHash}`} batch={namedBatch} vault={vault ?? batch.bindingId}
			onBatchChange={setBatch} onReload={() => setNonce((value) => value + 1)} />;
	}
	return <div className="flex min-h-0 flex-1 flex-col"><TerminalBatchView batch={namedBatch} vault={vault ?? batch.bindingId} onReload={() => setNonce(value => value + 1)} /><RevisionFollowup batch={namedBatch} /><ReviewWorkspace key={`${batch.id}:${batch.revision}:${batch.manifestHash}`} batch={namedBatch} vault={vault ?? batch.bindingId} onBatchChange={setBatch} onReload={() => setNonce((value) => value + 1)} /></div>;
}

/** Calendar candidates are corrected at the scheduling authority, without a curation job. */
function calendarEditHref(batch: WikiBatchDetail): string | null {
 if (batch.batch.compilerVersion !== "calendar-interaction-v1") return null;
 try { const id: unknown = JSON.parse(batch.batch.validationReceipt).calendar?.eventId; return typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id) ? `/calendar?event=${id}` : null; } catch { return null; }
}

/** 冲突/退回/已发布等终态的如实展示与引导。 */
function TerminalBatchView({ batch, vault, onReload }: { batch: WikiBatchDetail; vault: string | null; onReload: () => void }) {
	const router = useRouter();
	const params = useSearchParams();
	const [publication, setPublication] = useState<WikiPublicationSummary | null>(null);
	const [resolving, setResolving] = useState<"regenerate" | "close" | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [resolutionError, setResolutionError] = useState<string | null>(null);
	const [feedback, setFeedback] = useState("请保留原始资料，按知识库当前的结构、整理规则和文件内容重新生成候选，修复这次发布冲突。不要照搬旧候选中的推测。");
	const resolutionOperation = useRef<{ action: string; feedback: string; id: string } | null>(null);
	const submissionLock = useRef(false);
	const resolve = async () => {
		if (!resolving || submissionLock.current) return;
		submissionLock.current = true; setSubmitting(true); setResolutionError(null);
		const text = resolving === "regenerate" ? feedback.trim() : "";
		if (!resolutionOperation.current || resolutionOperation.current.action !== resolving || resolutionOperation.current.feedback !== text) {
			resolutionOperation.current = { action: resolving, feedback: text, id: crypto.randomUUID() };
		}
		try {
			const input = { operationId: resolutionOperation.current.id, manifestHash: batch.manifestHash };
			if (resolving === "regenerate") await requestWikiRevision(batch.id, { ...input, feedback: text, reviewedFiles: [] });
			else await closeWikiConflict(batch.id, input);
			setResolving(null); window.dispatchEvent(new Event(WIKI_REVIEW_CHANGED)); onReload();
		} catch (error) { setResolutionError(error instanceof Error ? error.message : String(error)); }
		finally { submissionLock.current = false; setSubmitting(false); }
	};
	useEffect(() => {
		if (batch.status !== "published" && batch.status !== "partial" && batch.status !== "conflict") return;
		let active = true;
		void listWikiPublications(batch.bindingId)
			.then((list) => { if (active) setPublication(list.find((item) => item.batchId === batch.id) ?? null); })
			.catch(() => undefined);
		return () => { active = false; };
	}, [batch.bindingId, batch.id, batch.status]);

	const calendarHref = calendarEditHref(batch);
	const conflictHint = calendarHref && (batch.status === "conflict" || batch.status === "rejected") ? "此往来候选不会发布。请回到日程核对并重新保存，生成新候选后再审核。" : batch.status === "conflict"
		? batch.conflictClosure ? "此冲突已关闭，已移入已处理记录。旧候选和发布记录保留。" : "这批候选无法继续发布。可以用原始资料按当前知识库重新整理，生成新候选后再审核；也可以关闭此冲突。"
		: batch.status === "rejected"
			? "批次已拒绝，不会发布。可回到知识库调整来源后生成新的候选。"
			: null;
	return (
		<div className="shrink-0 border-b border-border px-6 py-3">
			<p className="text-xs text-muted-foreground">固定候选保留，可继续查看文件内容与版本差异。</p>
			{batch.decidedAt ? <p className="mt-1 text-xs text-muted-foreground">审核于 {formatTime(batch.decidedAt)}</p> : null}
			{conflictHint ? <p className="mt-2 text-sm">{conflictHint}</p> : null}
			{batch.conflictBlockedReason ? <p role="status" className="mt-2 text-sm text-destructive">{batch.conflictBlockedReason}</p> : null}
			<div className="mt-2 flex flex-wrap gap-3 text-sm">
				{batch.status === "conflict" && !batch.conflictClosure ? <>
					<>{calendarHref ? <Link href={calendarHref} className="rounded bg-primary px-3 py-2 text-primary-foreground">修改日程</Link> : <button type="button" disabled={Boolean(batch.conflictBlockedReason) || submitting} onClick={() => { setResolutionError(null); setResolving("regenerate"); }} className="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-40">重新整理，生成新候选</button>}</>
					<button type="button" disabled={Boolean(batch.conflictBlockedReason) || submitting} onClick={() => { setResolutionError(null); setResolving("close"); }} className="rounded border border-border px-3 py-2 disabled:opacity-40">关闭此冲突</button>
				</> : null}
				{batch.status === "published" ? <Link href={`/knowledge?vault=${encodeURIComponent(batch.bindingId)}`} className="rounded bg-primary px-3 py-2 text-primary-foreground">查看已发布知识库</Link> : null}
				{batch.status === "rejected" ? (
					<Link href={`/knowledge${vault ? `?vault=${encodeURIComponent(vault)}` : ""}`} className="rounded bg-primary px-3 py-2 text-primary-foreground">
						打开知识库
					</Link>
				) : null}
				{publication ? (
					<button
						type="button"
						onClick={() => {
							const search = new URLSearchParams(params.toString());
							search.delete("batch");
							search.set("publication", publication.id);
							router.push(`/knowledge/review?${search.toString()}`);
						}}
						className="rounded border border-border px-3 py-2"
					>
						查看发布记录（{publicationStateLabels[publication.state]}）
					</button>
				) : null}
			</div>
			<Dialog open={resolving !== null} onOpenChange={open => { if (!open && !submitting) setResolving(null); }}>
				<DialogContent showCloseButton={!submitting} onEscapeKeyDown={event => { if (submitting) event.preventDefault(); }} onInteractOutside={event => { if (submitting) event.preventDefault(); }}>
					<DialogHeader><DialogTitle>{resolving === "regenerate" ? "重新整理这批资料" : "关闭此冲突？"}</DialogTitle><DialogDescription>{resolving === "regenerate" ? "知识管家将读取原始资料和当前知识库，生成新的候选。新候选仍需你审核确认后才能发布。" : "关闭后移入已处理，不再计入需处理。旧候选、审核决定及发布记录保留。"}</DialogDescription></DialogHeader>
					{resolving === "regenerate" ? <DialogBody><label htmlFor="conflict-feedback" className="text-sm font-medium">整理要求</label><textarea id="conflict-feedback" value={feedback} onChange={event => setFeedback(event.target.value)} maxLength={20000} disabled={submitting} className="mt-2 min-h-28 w-full rounded border border-border bg-background p-3 text-sm" /></DialogBody> : null}
					{resolutionError ? <p role="alert" className="text-sm text-destructive">{resolutionError} <button type="button" disabled={submitting} onClick={() => { setResolving(null); onReload(); }} className="underline">刷新状态</button></p> : null}
					<div className="flex justify-end gap-2"><button type="button" disabled={submitting} onClick={() => setResolving(null)} className="rounded border px-3 py-2 text-sm">取消</button><button type="button" disabled={submitting || (resolving === "regenerate" && !feedback.trim())} onClick={() => void resolve()} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40">{submitting ? "提交中…" : resolving === "regenerate" ? "开始重新整理" : "确认关闭冲突"}</button></div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function RevisionFollowup({ batch }: { batch: WikiBatchDetail }) {
	const params = useSearchParams();
	const [job, setJob] = useState<WikiCuratorJob | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	const jobId = batch.returnRequest?.jobId;
	useEffect(() => {
		if (!jobId) return;
		let active = true, loading = false;
		const refresh = async () => {
			if (document.hidden || loading) return;
			loading = true;
			try { const response = await getWikiCuratorJob(jobId); if (active) { setJob(response.job); setError(null); } }
			catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
			finally { loading = false; }
		};
		void refresh();
		const timer = window.setInterval(() => void refresh(), 2000);
		document.addEventListener("visibilitychange", refresh);
		return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
	}, [jobId, nonce]);
	if (batch.status !== "returned" || !batch.returnRequest) return null;
	const currentJob = job?.id === jobId ? job : null;
	const nextBatch = currentJob?.candidateBatchId ?? batch.returnRequest.newBatchId;
	const nextParams = new URLSearchParams(params.toString());
	nextParams.delete("publication");
	if (nextBatch) nextParams.set("batch", nextBatch);
	return <div className="shrink-0 space-y-2 border-b border-border bg-muted/30 px-6 py-4"><p className="text-sm font-medium">已退回修订 · 旧候选保留</p><p className="whitespace-pre-wrap text-sm">{batch.returnRequest.feedback}</p><p className="text-xs text-muted-foreground">修订会生成独立版本和 manifest，所有文件需要重新核对。本批次不会发布。</p>{nextBatch ? <Link href={`/knowledge/review?${nextParams.toString()}`} className="inline-block rounded bg-primary px-3 py-2 text-sm text-primary-foreground">查看新候选并重新审核</Link> : currentJob?.status === "failed" || currentJob?.status === "needs_attention" || currentJob?.status === "cancelled" ? <p role="status" className="text-sm">修订{currentJob.status === "cancelled" ? "已取消" : "需要处理"}：{currentJob.failureCode ?? "未生成新候选"}</p> : currentJob?.status === "no_changes" ? <p role="status" className="text-sm">此次修订没有产生文件变更。</p> : <p role="status" className="text-sm text-muted-foreground">{jobId ? "Wiki 管理员正在修订，可稍后回来查看。" : "修订请求已记录，正在恢复整理任务。"}</p>}{error ? <p role="alert" className="text-sm text-destructive">{error} <button type="button" onClick={() => setNonce((value) => value + 1)} className="underline">刷新修订状态</button></p> : null}</div>;
}

/** 审核工作台：左文件清单（已查看勾选）+ 右预览/diff + 顶部确认/退回操作。 */
function ReviewWorkspace({ batch, onBatchChange, onReload }: {
	batch: WikiBatchDetail;
	vault: string | null;
	onBatchChange: (batch: WikiBatchDetail) => void;
	onReload: () => void;
}) {
	const scopeParams = useSearchParams();
	const calendarHref = calendarEditHref(batch);
	const files = useMemo(() => [...batch.batch.files].sort((a, b) => a.targetPath.localeCompare(b.targetPath)), [batch]);
	const [selectedPath, setSelectedPath] = useState(files[0]?.targetPath ?? "");
	const [mobileFilesOpen, setMobileFilesOpen] = useState(false);
	const [viewed, setViewed] = useState<ReadonlySet<string>>(() => new Set());
	const [view, setView] = useState<"preview" | "diff">("diff");
	const [loadedImageKey, setLoadedImageKey] = useState<string | null>(null);
	const [fileView, setFileView] = useState<{ key: string; value: WikiBatchFileView | null; error: string | null }>({
		key: "", value: null, error: null,
	});
	const [confirming, setConfirming] = useState<"approve" | "reject" | "return" | null>(null);
	const [feedback, setFeedback] = useState("");
	const [acknowledged, setAcknowledged] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [actionError, setActionError] = useState<{ message: string; code?: string } | null>(null);
	const [publishNote, setPublishNote] = useState<string | null>(null);
	const reviewOperation = useRef<{ key: string; id: string } | null>(null);
	const previewScroll = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (previewScroll.current) previewScroll.current.scrollTop = 0;
	}, [batch.id, selectedPath, view]);

	useEffect(() => {
		if (!selectedPath) return;
		let active = true;
		const key = `${batch.id}:${selectedPath}`;
		void getWikiBatchFile(batch.id, selectedPath)
			.then((value) => { if (active) setFileView({ key, value, error: null }); })
			.catch((cause) => {
				if (active) setFileView({ key, value: null, error: cause instanceof Error ? cause.message : String(cause) });
			});
		return () => { active = false; };
	}, [batch.id, selectedPath]);

	const selectFile = useCallback((targetPath: string) => {
		setSelectedPath(targetPath);
		setMobileFilesOpen(false);
	}, []);

	const allViewed = files.length > 0 && files.every((file) => viewed.has(file.targetPath));
	const active = fileView.key === `${batch.id}:${selectedPath}` ? fileView : null;
	const snapshotAssetUrl = useCallback((path: string) => hasFrozenBatchImage(path, files) ? wikiBatchAssetUrl(batch.id, path) : null, [batch.id, files]);
	const imageReady = active?.value?.kind !== "image" || loadedImageKey === active.key;

	// 超期不在渲染期判断（纯函数约束）；点击时校验，超期则刷新——服务端读取即把批次收敛为 conflict。
	const requestConfirm = (kind: "approve" | "reject" | "return") => {
		if (kind === "approve" && !allViewed) return;
		if (Date.parse(batch.reviewDeadline) <= Date.now()) {
			onReload();
			return;
		}
		setAcknowledged(false);
		setConfirming(kind);
	};

	const submit = async (decision: "approve" | "reject" | "return") => {
		if (submitting || (decision === "approve" && (!allViewed || !acknowledged)) || (decision === "return" && !feedback.trim())) return;
		setSubmitting(true);
		setActionError(null);
		try {
			const reviewedFiles = decision === "approve" ? files.map((file) => file.targetPath) : [...viewed];
			const key = JSON.stringify([decision, batch.manifestHash, batch.revision, reviewedFiles, decision === "return" ? feedback.trim() : null]);
			if (reviewOperation.current?.key !== key) reviewOperation.current = { key, id: crypto.randomUUID() };
			if (decision === "return") {
				await requestWikiRevision(batch.id, { operationId: reviewOperation.current.id, manifestHash: batch.manifestHash, feedback: feedback.trim(), reviewedFiles });
				onReload(); setConfirming(null); window.dispatchEvent(new Event(WIKI_REVIEW_CHANGED)); return;
			}
			const response = await submitWikiReview(batch.id, {
				operationId: reviewOperation.current.id,
				decision,
				manifestHash: batch.manifestHash,
				reviewedFiles,
			});
			onBatchChange(response);
			setPublishNote(response.publish?.note ?? null);
			setConfirming(null);
			window.dispatchEvent(new Event(WIKI_REVIEW_CHANGED));
		} catch (cause) {
			const code = cause instanceof KnowledgeApiError ? cause.code : undefined;
			setActionError({ message: cause instanceof Error ? cause.message : String(cause), ...(code ? { code } : {}) });
			if (decision !== "return") setConfirming(null);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-6 py-3">
				<BatchStatusBadge status={batch.status} closed={Boolean(batch.conflictClosure)} />
				{(batch.parentBatchId ?? batch.batch.parentBatchId) ? <Link href={batchHref(scopeParams.toString(), (batch.parentBatchId ?? batch.batch.parentBatchId)!)} className="text-xs underline">查看上次候选与修订意见</Link> : null}
				<span className="text-xs text-muted-foreground">
					manifest <code>{shortHash(batch.manifestHash)}</code> · 第 {batch.revision} 代 · 截止 {formatTime(batch.reviewDeadline)}
				</span>
				<span className="text-xs text-muted-foreground">{batch.status === "pending_review" ? `已阅 ${Math.min(viewed.size, files.length)}/${files.length}` : `${files.length} 项固定候选`}</span>
				<span className="wiki-review-vault"><BookOpenIcon size={12} />{batch.bindingName ?? batch.bindingId}</span>
				<div className="ml-auto flex flex-wrap items-center gap-2">
					<ReviewSources batchId={batch.id} />
					{batch.status === "pending_review" ? (
						(
							<>
								<button
									type="button"
									disabled={!allViewed || submitting}
									title={allViewed ? `manifest ${batch.manifestHash}` : "请逐项核对文件并标记已阅"}
									onClick={() => requestConfirm("approve")}
									className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
								>
									确认并发布 {files.length} 项
								</button>
								{calendarHref ? <Link href={calendarHref} className="rounded border border-border px-3 py-2 text-sm">修改日程</Link> : <button type="button" disabled={submitting} onClick={() => requestConfirm("return")} className="rounded border border-border px-3 py-2 text-sm">退回修订</button>}
								<button type="button" disabled={submitting} onClick={() => requestConfirm("reject")} className="rounded border border-border px-3 py-2 text-sm">
									拒绝
								</button>
							</>
						)
					) : (
						<span className="text-sm text-muted-foreground">{batch.status === "approved" || batch.status === "publishing" ? "审核已通过，等待发布完成。" : "此审核记录只读。"}</span>
					)}
				</div>
			</div>
			{actionError ? (
				<p role="alert" className="mx-6 mt-3 text-sm text-destructive">
					{actionError.message}
					{actionError.code === "expired" || actionError.code === "state_conflict" ? (
						<>
							{" "}
							<button type="button" onClick={onReload} className="underline">
								<RefreshCwIcon size={12} className="inline" /> 刷新后重审
							</button>
							{actionError.code === "expired" ? (
								<>
									{" 或 "}
									<button type="button" onClick={onReload} className="underline">刷新后处理冲突</button>
								</>
							) : null}
						</>
					) : null}
				</p>
			) : null}
			{publishNote ? <p role="status" className="mx-6 mt-3 text-sm text-muted-foreground">{publishNote}</p> : null}
			<button type="button" aria-expanded={mobileFilesOpen} onClick={() => setMobileFilesOpen((value) => !value)} className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3 text-left text-sm sm:hidden"><span className="min-w-0 truncate">选择文件 · {selectedPath}</span><span className="shrink-0">{files.length} 项</span><ChevronRightIcon size={14} /></button>
			<div className="flex min-h-0 flex-1 flex-col sm:flex-row">
				<aside className={`${mobileFilesOpen ? "block" : "hidden"} max-h-52 w-full shrink-0 overflow-y-auto border-b border-border p-4 sm:block sm:max-h-none sm:w-72 sm:border-b-0 sm:border-r`}>
					<p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">批次文件（{files.length}）</p>
					<div className="space-y-1">
						{files.map((file) => (
							<button
								key={file.targetPath}
								type="button"
								onClick={() => selectFile(file.targetPath)}
								className={`flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm ${selectedPath === file.targetPath ? "bg-accent" : "hover:bg-muted"}`}
							>
								<OperationBadge operation={file.operation} />
								<span className="min-w-0 flex-1 truncate">{file.kind === "image" ? "图片 · " : ""}{file.targetPath}</span>
								{viewed.has(file.targetPath) ? <CheckIcon size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" /> : null}
							</button>
						))}
					</div>
				</aside>
				<main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" aria-label="审核文件预览">
					<div className="flex shrink-0 flex-wrap items-center gap-2 px-6 pb-3 pt-6 text-sm">
						<button type="button" data-active={view === "preview"} onClick={() => setView("preview")} className="knowledge-version-tab">渲染预览</button>
						<button type="button" data-active={view === "diff"} onClick={() => setView("diff")} className="knowledge-version-tab">版本差异</button>
						<span className="min-w-0 break-all text-xs text-muted-foreground">{selectedPath}</span>
					</div>
					<div ref={previewScroll} tabIndex={0} aria-label="文件预览内容" className="min-h-0 flex-1 overflow-auto overscroll-contain px-6 pb-6">
					{!active ? (
						<p className="text-sm text-muted-foreground"><LoaderCircleIcon size={14} className="mr-1 inline animate-spin" />正在加载…</p>
					) : active.error ? (
						<p role="alert" className="text-sm text-destructive">{active.error}</p>
					) : active.value ? (
						active.value.kind === "image" ? <section className="space-y-3" aria-label="固定候选图片"><p className="text-sm">图片原件 · {active.value.candidate.mediaType}</p><p className="break-all font-mono text-xs">SHA-256 {active.value.candidate.hash}</p><p className="break-all text-xs text-muted-foreground">{active.value.baseline ? `库内已有同一原图 SHA-256 ${active.value.baseline.hash}，将复用该图片。` : "新图片，与本批次页面一同审核后发布。"}</p>
							{/* eslint-disable-next-line @next/next/no-img-element -- 固定授权批次原件不走静态导出图片优化 */}
							<img key={active.key} src={wikiBatchAssetUrl(batch.id, active.value.path)} alt={active.value.path} className="max-h-[65dvh] max-w-full rounded border border-border object-contain" onLoad={() => setLoadedImageKey(active.key)} onError={() => setLoadedImageKey(`failed:${active.key}`)} />{loadedImageKey === `failed:${active.key}` ? <p role="alert" className="text-sm text-destructive">原件加载失败，无法标记已阅。请刷新后重试。</p> : null}{active.value.sourceIds?.length ? <p className="break-all text-xs text-muted-foreground">来源：{active.value.sourceIds.join(" · ")}</p> : null}</section> : view === "preview" ? active.value.operation === "delete" ? <p className="text-sm">该文件将被删除，请在版本差异中核对删除内容。</p> : (
							<div className="prose prose-sm max-w-none dark:prose-invert">
								<SnapshotMarkdown text={splitFrontmatter(active.value.candidate.content).body} bindingId={batch.bindingId} notePath={active.value.path} assetUrl={snapshotAssetUrl} />
							</div>
						) : (
							<>
								{active.value.baseline === null ? (
									<p className="mb-2 text-xs text-muted-foreground">新文件，无已同步基线。</p>
								) : null}
								<KnowledgeDiffView hunks={active.value.hunks} truncated={active.value.truncated} label="冻结基线与固定候选的差异" />
							</>
						)
					) : null}
					</div>
					{batch.status === "pending_review" ? <div aria-label="文件审核操作" className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border bg-background px-6 py-4"><p className="text-xs text-muted-foreground">标记代表你声明已核对这项文件；页面与图片均需分别核对。</p><button type="button" disabled={!active?.value || !imageReady || Boolean(active.error) || viewed.has(selectedPath) || submitting} onClick={() => {
						const next = new Set(viewed).add(selectedPath);
						setViewed(next);
						setSelectedPath(files.find((file) => !next.has(file.targetPath))?.targetPath ?? selectedPath);
					}} className="ml-auto flex shrink-0 items-center gap-1.5 rounded border border-border px-3 py-2 text-sm disabled:opacity-40"><CheckIcon size={14} />{viewed.has(selectedPath) ? "已标记已阅" : "标记已阅，下一项"}<ChevronRightIcon size={14} /></button></div> : null}
				</main>
			</div>
			<Dialog open={confirming !== null} onOpenChange={(open) => { if (!open && !submitting) setConfirming(null); }}>
				<DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden" showCloseButton={!submitting} onEscapeKeyDown={(event) => { if (submitting) event.preventDefault(); }} onInteractOutside={(event) => { if (submitting) event.preventDefault(); }}>
					<DialogHeader><DialogTitle>{confirming === "approve" ? `发布到 ${batch.bindingName ?? "知识库"}？` : confirming === "return" ? "退回给 Wiki 管理员修订" : "拒绝本次候选？"}</DialogTitle><DialogDescription>{confirming === "approve" ? "将按刚才审阅的固定内容发布全部文件。" : confirming === "return" ? "填写需要修改的地方。旧候选永久保留，新任务生成新候选后需要重新审核。" : "拒绝后保留审核记录，不修改知识库。"}</DialogDescription></DialogHeader>
					<DialogBody className="space-y-4">{confirming === "return" ? <div className="space-y-2"><label htmlFor="wiki-return-feedback" className="text-sm font-medium">修改意见（必填）</label><textarea id="wiki-return-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} maxLength={20000} disabled={submitting} className="min-h-28 w-full rounded border border-border bg-background p-3 text-sm" placeholder="请说明哪项文件需要怎样修改，以及核对依据。" /><p className="text-xs text-muted-foreground">本次声明已阅 {viewed.size}/{files.length} 项；未读文件不会被标记为已阅。</p>{actionError ? <p role="alert" className="text-sm text-destructive">{actionError.message}</p> : null}</div> : null}<p className="break-all text-xs text-muted-foreground">知识库：{batch.bindingName ?? batch.bindingId}<br />版本 {batch.revision} · manifest {batch.manifestHash}</p><div className="space-y-2 rounded border border-border p-3">{files.map((file) => <div key={file.targetPath} className="flex items-start gap-2 text-sm"><OperationBadge operation={file.operation} /><span className="min-w-0 break-all">{file.targetPath}</span></div>)}</div>{confirming === "approve" ? <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={submitting} className="mt-1" /><span>我已核对这 {files.length} 项变更，同意将本批固定候选发布到对应知识库。</span></label> : null}</DialogBody>
					<div className="flex justify-end gap-2"><button type="button" disabled={submitting} onClick={() => setConfirming(null)} className="rounded border border-border px-3 py-2 text-sm">继续检查</button><button type="button" disabled={submitting || (confirming === "approve" && (!acknowledged || !allViewed)) || (confirming === "return" && !feedback.trim())} onClick={() => { if (confirming) void submit(confirming); }} className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40">{submitting ? "提交中…" : confirming === "approve" ? "确认发布" : confirming === "return" ? "提交修订意见" : "确认拒绝"}</button></div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

/** 发布记录详情：逐文件结果与回执链。 */
function PublicationDetail({ publicationId, onBack }: { publicationId: string; onBack: () => void }) {
	const [publication, setPublication] = useState<WikiPublicationDetail | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void getWikiPublication(publicationId)
			.then((value) => { if (active) { setPublication(value); setError(null); } })
			.catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { active = false; };
	}, [publicationId]);

	if (error) {
		return (
			<div className="p-6">
				<p role="alert" className="text-sm text-destructive">{error}</p>
				<button type="button" onClick={onBack} className="mt-3 text-sm underline">返回列表</button>
			</div>
		);
	}
	if (!publication) return <p className="p-6 text-sm text-muted-foreground">正在加载…</p>;
	const feedback = publicationFeedback(publication);
	return (
		<div className="min-h-0 flex-1 overflow-y-auto p-6">
			<div className="mb-4 flex flex-wrap items-center gap-3">
				<PublicationStateBadge state={publication.state} />
				<span className="text-xs text-muted-foreground">
					{formatTime(publication.createdAt)}{publication.finishedAt ? ` → ${formatTime(publication.finishedAt)}` : ""}
				</span>
			</div>
			{feedback ? <section aria-label="发布未完成的原因" className="mb-5 space-y-3 rounded-xl border border-border bg-muted/40 p-4">
				<h2 className="font-semibold">{feedback.title}</h2>
				<p className="text-sm"><strong>停止原因：</strong>{feedback.reason}</p>
				{publication.currentContextChanges?.length ? <div className="text-sm">
					<p className="font-medium">当前核对发现：</p>
					<ul className="mt-1 list-disc space-y-1 pl-5">{publication.currentContextChanges.map(change => <li key={change}>{change}</li>)}</ul>
					<p className="mt-1 text-xs text-muted-foreground">以上是候选与当前知识库的差异；发布时的停止原因以记录为准。</p>
				</div> : null}
				<p className="text-sm">{feedback.impact}</p>
				<p className="text-sm"><strong>下一步：</strong>{feedback.action}</p>
				<Link href={`/knowledge/review?vault=${encodeURIComponent(publication.bindingId)}&batch=${encodeURIComponent(publication.batchId)}`} className="inline-flex text-sm text-primary underline">查看这批候选</Link>
			</section> : null}
			<details className="mb-4 text-xs text-muted-foreground">
				<summary className="cursor-pointer">查看技术标识</summary>
				<p className="mt-2 break-all">批次：{publication.batchId}<br />发布记录：{publication.journalRef}</p>
			</details>
			<table className="w-full border-collapse text-sm">
				<thead>
					<tr className="border-b border-border text-left text-xs text-muted-foreground">
						<th className="py-2 pr-3 font-medium">文件</th>
						<th className="py-2 pr-3 font-medium">操作</th>
						<th className="py-2 pr-3 font-medium">结果</th>
						<th className="py-2 font-medium">回执</th>
					</tr>
				</thead>
				<tbody>
					{publication.files.map((file) => (
						<tr key={file.targetPath} className="border-b border-border align-top">
							<td className="py-2 pr-3 font-mono text-xs">{file.targetPath}</td>
							<td className="py-2 pr-3"><OperationBadge operation={file.operation} /></td>
							<td className="py-2 pr-3">
								<span className="wiki-batch-badge" data-status={file.status}>{publishFileStatusLabels[file.status] ?? file.status}</span>
								{file.error ? <p className="mt-1 text-xs text-destructive">{file.error}</p> : null}
							</td>
							<td className="py-2 text-xs text-muted-foreground">
								{file.receipts.length === 0 ? "—" : (
									<ol className="space-y-0.5">
										{file.receipts.map((receipt, index) => (
											<li key={index}>
												{publishStepLabels[receipt.step] ?? receipt.step} · {formatTime(receipt.at)}
												{receipt.detail ? ` · ${receipt.detail}` : ""}
											</li>
										))}
									</ol>
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
