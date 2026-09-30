"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { SectionTopbar } from "@/components/section-topbar";
import {
	AlertTriangleIcon,
	ArrowUpRightIcon,
	ClipboardCheckIcon,
	FolderOpenIcon,
	LayersIcon,
	PencilIcon,
	PlusIcon,
	RefreshCwIcon,
	SearchIcon,
	SparklesIcon,
	UnplugIcon,
} from "lucide-react";
import {
	getKnowledgeObservations,
	listKnowledgeBindings,
	listKnowledgeTree,
	listWikiBatchPage,
	scanKnowledgeBinding,
	type KnowledgeBindingSummary,
	type KnowledgeObservedFile,
	type KnowledgeObservations,
	type KnowledgeTreeNode,
} from "@/lib/api";
import { KnowledgeTree } from "./tree";
import { KnowledgeSearchPanel } from "./search-panel";
import { KnowledgeNoteView } from "./note-view";
import { WikiCompileDialog } from "./compile-dialog";
import { CreateVaultDialog } from "./create-vault-dialog";
import { MEMORY_SETUP_EVENT, MEMORY_SETUP_COMPLETED_EVENT } from "./memory-onboarding";
import { VaultDescriptionDialog, VaultUnbindDialog } from "./vault-dialogs";
import { vaultIcon, vaultTone } from "./vault-tones";
import { useWikiReviewQueue } from "@/lib/wiki-review-queue";
import { LatestSerialQueue } from "@/lib/latest-serial-queue";

const emptyTree: KnowledgeTreeNode[] = [];

/** 笔记只数当前存在的真笔记：库根的契约 / 首页 / 日志在树里可见，但不算笔记。 */
function isNote(file: KnowledgeObservedFile): boolean {
	return !file.control && file.state !== "missing";
}

function noteCountOf(observations: KnowledgeObservations): number {
	return observations.files.filter(isNote).length;
}

interface BindingScanState {
	/** 扫描失败显式标记，不伪装空库。 */
	failed: boolean;
	/** null = 离线或扫描失败；首页卡片据此如实降级。 */
	notes: number | null;
	scannedAt: string | null;
}

/* ---- 首页卡片总览（未选库）：结构对齐冻结原型 vaults 视图 ---- */

function formatScannedAt(iso: string): string {
	const time = new Date(iso);
	if (Number.isNaN(time.getTime())) return "—";
	const pad = (value: number) => String(value).padStart(2, "0");
	if (time.toDateString() === new Date().toDateString()) return `${pad(time.getHours())}:${pad(time.getMinutes())}`;
	return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
}

function KnowledgeHomeView({ bindings, scanStates, onRefresh, onCreateVault }: {
	bindings: KnowledgeBindingSummary[] | null;
	scanStates: Record<string, BindingScanState>;
	onRefresh: () => void;
	onCreateVault: () => void;
}) {
	const router = useRouter();
	const { pendingCount, error: reviewError } = useWikiReviewQueue();
	const [homeQuery, setHomeQuery] = useState("");
	const needle = homeQuery.trim().toLowerCase();
	const filtered = (bindings ?? []).filter((item) =>
		!needle || `${item.name}\n${item.description}`.toLowerCase().includes(needle));

	return (
		<div className="knowledge-home">
			<div className="knowledge-home-heading">
				<div>
					<p className="knowledge-home-eyebrow">YOUR KNOWLEDGE, YOUR STRUCTURE</p>
					<h1>你的资料，各得其所。</h1>
					<p>为不同的生活、研究和项目建立独立知识库，让每份资料有自己的结构。</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<button type="button" className="rounded border border-border px-3 py-2 text-sm hover:bg-muted" onClick={() => window.dispatchEvent(new Event(MEMORY_SETUP_EVENT))}>长期记忆设置</button>
					<Link href="/knowledge/connect" className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm hover:bg-muted">
						<FolderOpenIcon size={15} />接入本地 Wiki
					</Link>
					<button
						type="button"
						onClick={onCreateVault}
						className="flex items-center gap-1.5 rounded bg-primary px-3 py-2 text-sm text-primary-foreground"
					>
						<PlusIcon size={15} />创建知识库
					</button>
				</div>
			</div>

			<Link href="/knowledge/review" className="knowledge-review-inbox">
				<span className="knowledge-review-inbox-icon"><ClipboardCheckIcon size={23} /></span>
				<span><strong>全部待审核 <b>{pendingCount ?? "…"}</b></strong><small>{reviewError ? "数量暂不可用，打开审核中心重试。" : "集中查看所有知识库的候选变更，确认后再发布。"}</small></span>
				<span className="knowledge-review-inbox-open">打开审核中心 <ArrowUpRightIcon size={15} /></span>
			</Link>
			<div className="knowledge-home-toolbar">
				<div>
					<div className="flex items-center gap-2">
						<h2>全部知识库</h2>
						<span className="knowledge-home-count">{bindings ? bindings.length : "…"}</span>
					</div>
					<p>Wiki 的编译结果在正式发布前审核。</p>
				</div>
				<div className="flex items-center gap-2">
					<div className="knowledge-home-search">
						<SearchIcon size={14} />
						<input
							aria-label="搜索知识库"
							value={homeQuery}
							onChange={(event) => setHomeQuery(event.target.value)}
							placeholder="搜索名称或描述"
							spellCheck={false}
						/>
					</div>
					<button type="button" onClick={onRefresh} className="rounded border border-border p-2 hover:bg-muted" aria-label="刷新知识库列表">
						<RefreshCwIcon size={16} />
					</button>
				</div>
			</div>

			{!bindings ? (
				<p className="py-10 text-sm text-muted-foreground">正在加载…</p>
			) : (
				<>
					<div className="knowledge-vault-grid">
						{filtered.map((item) => {
							const scanState = scanStates[item.id];
							const offline = item.availability !== "available";
							const tone = vaultTone(item);
							const Icon = vaultIcon(item);
							return (
								<button
									key={item.id}
									type="button"
									className="knowledge-vault-card"
									onClick={() => router.push(`/knowledge?vault=${encodeURIComponent(item.id)}`)}
								>
									<div className="flex items-start justify-between">
										<span className="knowledge-vault-icon" data-tone={tone}><Icon size={22} /></span>
										<ArrowUpRightIcon size={16} className="text-muted-foreground" />
									</div>
									<h2>{item.name}</h2>
									<p className="knowledge-vault-desc">{item.description}</p>
									{offline || scanState?.failed ? (
										<div className="knowledge-vault-badges">
											{offline ? (
												<span className="knowledge-vault-state">离线</span>
											) : scanState?.failed ? (
												<span className="knowledge-vault-state" data-tone="warn"><AlertTriangleIcon size={11} />扫描失败</span>
											) : null}
										</div>
									) : null}
									<div className="knowledge-vault-footer">
										<span>
											{offline ? "目录离线，无法扫描"
												: scanState?.failed ? "笔记数不可用"
												: scanState ? `${scanState.notes ?? 0} 篇笔记`
												: "…"}
										</span>
										{!offline && !scanState?.failed && scanState?.scannedAt ? (
											<span>最近扫描 {formatScannedAt(scanState.scannedAt)}</span>
										) : null}
									</div>
								</button>
							);
						})}
						<button type="button" onClick={onCreateVault} className="knowledge-vault-create">
							<span><PlusIcon size={18} /></span>
							<strong>新的空间，新的可能</strong>
							<p>选择结构，写下它的用途。</p>
						</button>
					</div>
					{bindings.length > 0 && filtered.length === 0 ? (
						<p className="mt-3 text-xs text-muted-foreground">没有名称或描述匹配「{homeQuery.trim()}」的知识库。</p>
					) : null}
				</>
			)}

			<div className="knowledge-schema-intro">
				<span className="knowledge-schema-symbol"><LayersIcon size={22} /></span>
				<div>
					<h3>一个知识库，一套合适的资料结构</h3>
					<p>资料结构定义笔记类型、字段与目录。已有 Markdown 也可以逐步映射。</p>
				</div>
				<Link href="/knowledge/schema" className="ml-auto flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm hover:bg-muted">
					查看内置资料结构
				</Link>
			</div>
		</div>
	);
}

export function KnowledgeApp() {
	const router = useRouter();
	const params = useSearchParams();
	const requestedVault = params.get("vault");
	const requestedNote = params.get("note");
	const requestedAnchor = params.get("anchor");
	const historyOpen = params.get("history") === "1" || Boolean(params.get("historyVersion"));

	const [bindings, setBindings] = useState<KnowledgeBindingSummary[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [refreshNonce, setRefreshNonce] = useState(0);
	const [noteRefreshNonce, setNoteRefreshNonce] = useState(0);
	const scanQueue = useRef(new LatestSerialQueue());
	const [treeState, setTreeState] = useState<{ key: string; value: KnowledgeTreeNode[]; error: string | null } | null>(null);
	const [observationsState, setObservationsState] = useState<{ key: string; value: KnowledgeObservations; error: string | null } | null>(null);
	const [scanStates, setScanStates] = useState<Record<string, BindingScanState>>({});
	const [actionError, setActionError] = useState<string | null>(null);
	const [allowedRemoteImages, setAllowedRemoteImages] = useState<ReadonlySet<string>>(new Set());
	const [compileOpen, setCompileOpen] = useState(false);
	const [createVaultOpen, setCreateVaultOpen] = useState(false);
	const [descriptionOpen, setDescriptionOpen] = useState(false);
	const [unbindOpen, setUnbindOpen] = useState(false);
	const [pendingReviews, setPendingReviews] = useState<{ key: string; count: number } | null>(null);

	const selected = bindings?.find((item) => item.id === requestedVault) ?? null;
	const selectedId = selected?.id;
	const selectedAvailability = selected?.availability;
	const treeKey = selectedId ? `${selectedId}${refreshNonce}` : null;
	const tree = treeState && treeState.key === treeKey ? treeState.value : emptyTree;
	const treeError = treeState && treeState.key === treeKey ? treeState.error : null;
	const observationsError = observationsState && observationsState.key === treeKey ? observationsState.error : null;

	const refreshAll = useCallback(() => setRefreshNonce((value) => value + 1), []);
	useEffect(() => {
		window.addEventListener(MEMORY_SETUP_COMPLETED_EVENT, refreshAll);
		return () => window.removeEventListener(MEMORY_SETUP_COMPLETED_EVENT, refreshAll);
	}, [refreshAll]);

	// 绑定列表 + 每库当前笔记数（扫描失败如实显示，不伪装 0）。
	useEffect(() => {
		let active = true;
		void listKnowledgeBindings()
			.then(async (value) => {
				if (!active) return;
				setBindings(value);
				setError(null);
				const counts = await Promise.all(value.map(async (binding) => {
					try {
						const observations = await getKnowledgeObservations(binding.id);
						return [binding.id, {
							failed: false,
							notes: noteCountOf(observations),
							scannedAt: observations.scannedAt,
						}] as const;
					} catch {
						return [binding.id, { failed: true, notes: null, scannedAt: null }] as const;
					}
				}));
				if (active) setScanStates(Object.fromEntries(counts));
			})
			.catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { active = false; };
	}, [refreshNonce]);

	// 当前库可见时温和同步；串行队列让切库/手动刷新淘汰旧响应，历史视图保持固定。
	useEffect(() => {
		if (!selectedId || !treeKey || selectedAvailability !== "available" || historyOpen) return;
		const queue = scanQueue.current;
		queue.invalidate();
		let active = true, loading = false;
		const refresh = async () => {
			if (!active || document.hidden || loading) return;
			loading = true;
			try {
				await queue.enqueue(async (isCurrent) => {
					try {
						await scanKnowledgeBinding(selectedId);
						const [treeValue, observationsValue] = await Promise.all([listKnowledgeTree(selectedId), getKnowledgeObservations(selectedId)]);
						if (!active || !isCurrent()) return;
						setTreeState({ key: treeKey, value: treeValue, error: null });
						setObservationsState({ key: treeKey, value: observationsValue, error: null });
						setScanStates((previous) => ({ ...previous, [selectedId]: { failed: false, notes: noteCountOf(observationsValue), scannedAt: observationsValue.scannedAt } }));
						setNoteRefreshNonce((value) => value + 1);
					} catch (cause) {
						if (!active || !isCurrent()) return;
						const message = cause instanceof Error ? cause.message : String(cause);
						setTreeState({ key: treeKey, value: [], error: message });
						setObservationsState({ key: treeKey, value: { scannedAt: "", acceptanceRevision: 0, files: [], duplicates: [] }, error: message });
						setScanStates((previous) => ({ ...previous, [selectedId]: { failed: true, notes: null, scannedAt: null } }));
					}
				});
			} finally { loading = false; }
		};
		void refresh();
		const timer = window.setInterval(() => void refresh(), 30_000);
		const onFocus = () => { void refresh(); };
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onFocus);
		return () => {
			active = false; queue.invalidate(); window.clearInterval(timer);
			window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus);
		};
	}, [selectedId, selectedAvailability, treeKey, historyOpen]);

	const noteCount = useMemo(() => {
		const count = (nodes: KnowledgeTreeNode[]): number =>
			nodes.reduce((sum, node) => sum + (node.type === "note" ? 1 : count(node.children ?? [])), 0);
		return count(tree);
	}, [tree]);

	// 待审核批次计数：4s 轮询，页面不可见时暂停；失败置 null 不伪装 0。
	useEffect(() => {
		if (!selectedId || selectedAvailability !== "available") return;
		const vaultId = selectedId;
		let active = true;
		const tick = async () => {
			if (document.hidden) return;
			try {
				const page = await listWikiBatchPage({ bindingId: vaultId, limit: 1 });
				if (active) setPendingReviews({ key: vaultId, count: page.pendingCount });
			} catch {
				if (active) setPendingReviews(null);
			}
		};
		void tick();
		const timer = setInterval(() => void tick(), 4000);
		const onVisible = () => { if (!document.hidden) void tick(); };
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			active = false;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [selectedId, selectedAvailability, refreshNonce]);

	const navigate = useCallback((notePath: string, options?: { anchor?: string }) => {
		if (!selectedId) return;
		const search = new URLSearchParams({ vault: selectedId, note: notePath });
		if (options?.anchor) search.set("anchor", options.anchor);
		router.push(`/knowledge?${search.toString()}`);
	}, [router, selectedId]);

	const editDescription = () => {
		if (!selected) return;
		setDescriptionOpen(true);
	};

	const disconnect = () => {
		if (!selected) return;
		setUnbindOpen(true);
	};

	const allowRemoteImage = useCallback((src: string) => {
		setAllowedRemoteImages((previous) => new Set(previous).add(src));
	}, []);

	return (
		<>
		<SectionTopbar crumbs={selected
			? [{ label: "知识库", href: "/knowledge" }, { label: selected.name }]
			: requestedVault && !bindings
				? [{ label: "知识库", href: "/knowledge" }, { label: "正在加载…" }]
				: [{ label: "知识库" }]}
		/>
		<div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
			{selected ? (
				<header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
					<div className="min-w-0 max-w-xl">
						<h1 className="text-2xl font-medium tracking-tight">{selected.name}</h1>
						{selected.description ? (
							<p className="mt-1 text-sm leading-5 text-muted-foreground">{selected.description}</p>
						) : null}
					</div>
					<div className="flex flex-wrap items-center justify-end gap-2">
						<Link
							href={`/knowledge/schema?vault=${encodeURIComponent(selected.id)}`}
							className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm hover:bg-muted"
						>
							<LayersIcon size={15} />
							结构
						</Link>
						<button
							type="button"
							onClick={editDescription}
							className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm hover:bg-muted"
						>
							<PencilIcon size={15} />
							编辑描述
						</button>
						{selected.availability === "available" ? (
							<>
								<Link
									href={`/knowledge/review?vault=${encodeURIComponent(selected.id)}${requestedNote ? `&returnNote=${encodeURIComponent(requestedNote)}` : ""}`}
									className="relative flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm"
								>
									<ClipboardCheckIcon size={15} />
									发布审核
									{pendingReviews && pendingReviews.key === selected.id && pendingReviews.count > 0 ? (
										<span className="knowledge-status-badge">{pendingReviews.count} 待审</span>
									) : null}
								</Link>
								<button
									type="button"
									onClick={() => setCompileOpen(true)}
									className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm"
								>
									<SparklesIcon size={15} />
									Wiki 管理员
								</button>
							</>
						) : null}
						<button type="button" onClick={refreshAll} className="rounded border border-border p-2" aria-label="刷新知识库">
							<RefreshCwIcon size={16} />
						</button>
						<button
							type="button"
							onClick={disconnect}
							className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm text-destructive hover:bg-destructive/10"
						>
							<UnplugIcon size={15} />
							移除绑定
						</button>
					</div>
				</header>
			) : null}
			{error ? (
				<p role="alert" className="m-5 text-sm text-destructive">
					{error}{" "}
					<button type="button" onClick={refreshAll} className="underline">重试</button>
				</p>
			) : null}
			{actionError ? <p role="alert" className="mx-5 mt-3 text-sm text-destructive">{actionError}</p> : null}
			{!selected ? (
				<KnowledgeHomeView bindings={bindings} scanStates={scanStates} onRefresh={refreshAll} onCreateVault={() => setCreateVaultOpen(true)} />
			) : (
				<div className="flex min-h-0 flex-1 flex-col sm:flex-row">
					<aside data-knowledge-tree className="w-full shrink-0 overflow-y-auto border-b border-border p-4 sm:w-72 sm:border-b-0 sm:border-r">
						<div>
							{selected.availability === "available" ? (
								<>
									<KnowledgeSearchPanel
										bindingId={selected.id}
										nodes={tree}
										onOpenNote={(path) => navigate(path)}
									/>
									<p className="my-2 text-xs text-muted-foreground">{noteCount} 篇 Markdown</p>
									{treeError ? (
										<p role="alert" className="text-sm text-destructive">
											{treeError}{" "}
											<button type="button" onClick={refreshAll} className="underline">重试</button>
										</p>
									) : observationsError ? null : tree.length === 0 && treeState?.key === treeKey ? (
										<p className="text-sm text-muted-foreground">目录中没有 Markdown 笔记。</p>
									) : (
										<KnowledgeTree nodes={tree} selected={requestedNote} onSelect={(path) => navigate(path)} />
									)}
								</>
							) : (
								<p className="mt-4 text-sm text-destructive">目录离线或身份已变化。请核对原路径。</p>
							)}
						</div>
					</aside>
					<main className="min-w-0 flex-1 overflow-y-auto p-6">
						{!requestedNote ? (
							<div className="mx-auto max-w-xl py-12 text-center text-sm text-muted-foreground">从左侧文件树选择笔记。</div>
						) : (
							<KnowledgeNoteView
								key={`${selected.id}:${requestedNote}`}
								binding={selected}
								notePath={requestedNote}
								anchor={requestedAnchor}
								refreshKey={noteRefreshNonce}
								allowedRemoteImages={allowedRemoteImages}
								onAllowRemoteImage={allowRemoteImage}
								onNavigate={navigate}
							/>
						)}
					</main>
				</div>
			)}
			<CreateVaultDialog open={createVaultOpen} onOpenChange={setCreateVaultOpen} onCreated={refreshAll} />
			<VaultDescriptionDialog
				binding={selected}
				open={descriptionOpen}
				onOpenChange={setDescriptionOpen}
				onSaved={() => { refreshAll(); setActionError(null); }}
				onError={setActionError}
			/>
			<VaultUnbindDialog
				binding={selected}
				open={unbindOpen}
				onOpenChange={setUnbindOpen}
				onUnbound={() => { refreshAll(); setActionError(null); router.push("/knowledge"); }}
			/>
			{selected ? (
				<WikiCompileDialog
					bindingId={selected.id}
					bindingName={selected.name}
					open={compileOpen}
					onOpenChange={setCompileOpen}
					onCandidateReady={(batchId) => router.push(
						`/knowledge/review?vault=${encodeURIComponent(selected.id)}&batch=${encodeURIComponent(batchId)}`,
					)}
				/>
			) : null}
		</div>
		</>
	);
}
