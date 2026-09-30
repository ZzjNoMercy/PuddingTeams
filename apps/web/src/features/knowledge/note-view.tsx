"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ChevronRightIcon, ExternalLinkIcon, Loader2Icon, HistoryIcon } from "lucide-react";
import { ClipboardSafeStreamdown } from "@/components/ai-elements/streamdown";
import { streamdownPlugins } from "@/core/streamdown/plugins";
import { writeTextToClipboard } from "@/core/clipboard";
import { getDesktopBridge } from "@/lib/desktop";
import {
	createKnowledgeObsidianUri,
	KnowledgeApiError,
	readKnowledgeNote,
	resolveKnowledgeLink,
	type KnowledgeBindingSummary,
	type KnowledgeLinkResolution,
	type KnowledgeNote,
} from "@/lib/api";
import { buildNoteMarkdownComponents } from "./note-markdown";
import { rewriteWikiLinks, slugifyHeading, splitFrontmatter } from "./markdown";
import { KnowledgePageHistory } from "./page-history";
import { LatestSerialQueue } from "@/lib/latest-serial-queue";
import { BacklinksPanel } from "./backlinks-panel";

interface VersionSlot {
	key: string;
	value: KnowledgeNote | null;
	error: string | null;
	errorStatus?: number;
}

interface AmbiguousChoice {
	candidates: Array<{ path: string; title: string }>;
	x: number;
	y: number;
}

export interface NoteViewProps {
	binding: KnowledgeBindingSummary;
	notePath: string;
	anchor: string | null;
	refreshKey: number;
	allowedRemoteImages: ReadonlySet<string>;
	onAllowRemoteImage: (src: string) => void;
	onNavigate: (path: string, options?: { anchor?: string }) => void;
}

function scrollArticleToAnchor(root: Element | null, target: string) {
	if (!root) return;
	let decoded = target;
	try {
		decoded = decodeURIComponent(target);
	} catch { /* 保留原样 */ }
	const slug = slugifyHeading(decoded);
	const heading = [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")]
		.find((element) => (element.id || slugifyHeading(element.textContent ?? "")) === slug);
	heading?.scrollIntoView({ block: "start" });
}

export function KnowledgeNoteView(props: NoteViewProps) {
	const { binding, notePath, anchor, refreshKey } = props;
	const historyParams = useSearchParams(), historyRouter = useRouter();
	const historyOpen = historyParams.get("history") === "1" || Boolean(historyParams.get("historyVersion"));
	const changeHistory = (open: boolean) => { const query = new URLSearchParams(historyParams.toString()); if (open) query.set("history", "1"); else { query.delete("history"); query.delete("historyVersion"); } historyRouter.replace(`/knowledge?${query}`, { scroll: false }); };
	const { onNavigate, allowedRemoteImages, onAllowRemoteImage } = props;
	const [retryNonce, setRetryNonce] = useState(0);
	const loadKey = JSON.stringify([binding.id, notePath, retryNonce]);
	const readQueue = useRef(new LatestSerialQueue());
	const [observedState, setObservedState] = useState<VersionSlot | null>(null);
	const [resolutions, setResolutions] = useState<ReadonlyMap<string, KnowledgeLinkResolution>>(new Map());
	const [brokenLinks, setBrokenLinks] = useState<ReadonlySet<string>>(new Set());
	const [ambiguous, setAmbiguous] = useState<AmbiguousChoice | null>(null);
	const [obsidianBusy, setObsidianBusy] = useState(false);
	const articleRef = useRef<HTMLDivElement>(null);
	const ambiguousRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!ambiguous) return;
		const onPointerDown = (event: PointerEvent) => {
			if (ambiguousRef.current && event.target instanceof Node && !ambiguousRef.current.contains(event.target)) {
				setAmbiguous(null);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setAmbiguous(null);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [ambiguous]);

	const observed = observedState?.key === loadKey ? observedState.value : null;
	const observedError = observedState?.key === loadKey ? observedState.error : null;
	const observedErrorStatus = observedState?.key === loadKey ? observedState.errorStatus : undefined;
	const missingSource = observedErrorStatus === 404;

	useEffect(() => {
		if (historyOpen) return;
		const queue = readQueue.current;
		queue.invalidate();
		let active = true;
		void queue.enqueue(async (isCurrent) => {
			try {
				const value = await readKnowledgeNote(binding.id, notePath, "observed");
				if (active && isCurrent()) setObservedState({ key: loadKey, value, error: null });
			} catch (cause) {
				if (!active || !isCurrent()) return;
				setObservedState({ key: loadKey, value: null, error: cause instanceof Error ? cause.message : String(cause), errorStatus: cause instanceof KnowledgeApiError ? cause.status : undefined });
			}
		});
		return () => { active = false; queue.invalidate(); };
	}, [binding.id, notePath, loadKey, historyOpen, refreshKey]);

	const activeNote = observed;

	const displayed = useMemo(() => (activeNote ? splitFrontmatter(activeNote.content) : null), [activeNote]);
	const renderedBody = useMemo(() => (displayed ? rewriteWikiLinks(displayed.body) : ""), [displayed]);

	const scrollToAnchor = useCallback((target: string) => {
		scrollArticleToAnchor(articleRef.current, target);
	}, []);
	const onAnchorLink = useCallback((target: string, event: MouseEvent) => {
		scrollArticleToAnchor(event.currentTarget.closest("article"), target);
	}, []);

	useEffect(() => {
		if (!anchor || !activeNote) return;
		const timer = window.setTimeout(() => scrollToAnchor(anchor), 80);
		return () => window.clearTimeout(timer);
	}, [anchor, activeNote, scrollToAnchor]);

	const applyResolution = useCallback((cacheKey: string, resolution: KnowledgeLinkResolution, event?: MouseEvent) => {
		if (resolution.status === "ok") {
			setAmbiguous(null);
			onNavigate(resolution.note.path, resolution.anchor ? { anchor: resolution.anchor } : undefined);
			return;
		}
		if (resolution.status === "ambiguous") {
			const x = Math.max(8, Math.min(event?.clientX ?? 80, window.innerWidth - 280));
			const y = Math.max(8, Math.min(event?.clientY ?? 80, window.innerHeight - 220));
			setAmbiguous({ candidates: resolution.candidates, x, y });
			return;
		}
		setAmbiguous(null);
		if (resolution.status === "broken") {
			setBrokenLinks((previous) => new Set(previous).add(cacheKey));
			toast.error("找不到目标笔记");
		} else {
			toast.info("链接目标不在知识库范围内");
		}
	}, [onNavigate]);

	const resolveAndApply = useCallback((cacheKey: string, link: string, kind: "wiki" | "md", event: MouseEvent) => {
		const cached = resolutions.get(cacheKey);
		if (cached) {
			applyResolution(cacheKey, cached, event);
			return;
		}
		void resolveKnowledgeLink(binding.id, notePath, link, kind)
			.then((resolution) => {
				setResolutions((previous) => new Map(previous).set(cacheKey, resolution));
				applyResolution(cacheKey, resolution, event);
			})
			.catch((cause: unknown) => {
				toast.error(cause instanceof Error ? cause.message : String(cause));
			});
	}, [resolutions, binding.id, notePath, applyResolution]);

	const onWikiLink = useCallback((target: string, event: MouseEvent) => {
		resolveAndApply(`wiki:${target}`, target, "wiki", event);
	}, [resolveAndApply]);
	const onMdLink = useCallback((href: string, event: MouseEvent) => {
		resolveAndApply(`md:${href}`, href, "md", event);
	}, [resolveAndApply]);

	const components = useMemo(() => buildNoteMarkdownComponents({
		bindingId: binding.id,
		notePath,
		onWikiLink,
		onMdLink,
		onAnchorLink,
		brokenLinks,
		allowedRemoteImages,
		onAllowRemoteImage,
	}), [binding.id, notePath, onWikiLink, onMdLink, onAnchorLink, brokenLinks, allowedRemoteImages, onAllowRemoteImage]);

	// streamdown@2.5.0 顶层 memo 的比较函数不含 components：brokenLinks / allowedRemoteImages
	// 变化会重建 components 表，但 children 不变时整体跳过重渲染，块内闭包永不更新。
	// 两个集合都只增不减，size 即语义版本；放进 key 在变化时强制重挂载 Markdown 树。
	const markdownKey = `refresh:${refreshKey};broken:${brokenLinks.size};remote-images:${allowedRemoteImages.size}`;

	const openInObsidian = async () => {
		if (obsidianBusy) return;
		setObsidianBusy(true);
		try {
			const uri = await createKnowledgeObsidianUri(binding.id, notePath);
			const bridge = getDesktopBridge();
			if (bridge?.isDesktop) {
				const result = await bridge.openInObsidian(uri);
				if (!result?.ok) throw new Error(result?.error ?? "桌面端未确认打开 Obsidian");
			} else {
				const copied = await writeTextToClipboard(uri);
				if (copied) toast.success("已复制 Obsidian 链接，本功能在桌面端可直接打开");
				else toast.info(`Obsidian 链接：${uri}`);
			}
		} catch (cause) {
			toast.error(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setObsidianBusy(false);
		}
	};

	const noteTitle = displayed?.properties.find(([key]) => key === "title")?.[1]
		|| notePath.split("/").at(-1)?.replace(/\.md$/i, "")
		|| notePath;

	if (historyOpen) return <KnowledgePageHistory bindingId={binding.id} notePath={notePath} title={noteTitle} onClose={() => changeHistory(false)} />;

	return (
		<div className="mx-auto max-w-3xl">
			<div className="mb-6 flex items-center gap-2 text-xs text-muted-foreground">
				<span>{binding.name}</span>
				<ChevronRightIcon size={12} />
				<span className="min-w-0 truncate">{notePath}</span>
			</div>
			<div className="mb-4 flex flex-wrap items-center justify-between gap-3">
				<h2 className="min-w-0 text-xl font-medium break-words">{noteTitle}</h2>
				<div className="flex shrink-0 items-center gap-2">
					<button type="button" onClick={() => changeHistory(true)} className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted"><HistoryIcon size={13} />页面历史</button>
					{activeNote ? <span className="text-xs text-muted-foreground">{activeNote.size} B · 只读</span> : null}
					<button
						type="button"
						onClick={() => void openInObsidian()}
						disabled={missingSource || !observed || obsidianBusy}
						title={missingSource || !observed ? "笔记不在磁盘上，无法在 Obsidian 中打开" : undefined}
						className="flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
					>
						{obsidianBusy ? <Loader2Icon size={13} className="animate-spin" /> : <ExternalLinkIcon size={13} />}
						在 Obsidian 中打开
					</button>
				</div>
			</div>
			{observedError ? (
				<p role="alert" className="text-sm text-destructive">
					{missingSource ? "当前文件已不存在。可在页面历史中查看先前记录。" : observedError}{" "}
					<button type="button" onClick={() => setRetryNonce((value) => value + 1)} className="underline">重试</button>
				</p>
			) : !activeNote || !displayed ? (
				<p className="flex items-center gap-1.5 text-sm text-muted-foreground">
					<Loader2Icon size={14} className="animate-spin" />正在读取笔记…
				</p>
			) : (
				<>
					{displayed.properties.length ? (
						<dl className="mb-6 grid gap-2 rounded border border-border bg-muted/20 p-4 text-xs sm:grid-cols-2">
							{displayed.properties.map(([key, value]) => (
								<div key={key} className="flex gap-2">
									<dt className="text-muted-foreground">{key}</dt>
									<dd className="min-w-0 break-words">{value}</dd>
								</div>
							))}
						</dl>
					) : null}
					<div ref={articleRef}>
						<article className="runtime-file-markdown">
							<ClipboardSafeStreamdown key={markdownKey} {...streamdownPlugins} components={components}>{renderedBody}</ClipboardSafeStreamdown>
						</article>
					</div>
					<BacklinksPanel bindingId={binding.id} notePath={notePath} refreshKey={refreshKey} onOpenNote={(path) => onNavigate(path)} />
				</>
			)}
			{ambiguous ? (
				<div
					ref={ambiguousRef}
					className="knowledge-ambiguous-pop"
					style={{ left: ambiguous.x, top: ambiguous.y }}
					role="dialog"
					aria-label="选择链接目标"
				>
					<p className="px-2.5 pb-1 pt-2 text-[10px] text-muted-foreground">多个笔记同名，选择要打开的目标</p>
					{ambiguous.candidates.map((candidate) => (
						<button
							key={candidate.path}
							type="button"
							onClick={() => { setAmbiguous(null); onNavigate(candidate.path); }}
							className="w-full rounded-md px-2.5 py-2 text-left hover:bg-muted"
						>
							<span className="block truncate text-xs font-medium text-foreground">{candidate.title}</span>
							<span className="block truncate text-[10px] text-muted-foreground">{candidate.path}</span>
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
