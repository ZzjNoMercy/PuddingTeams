"use client";

import { KnowledgeJobCard } from "./knowledge-job-card";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, type ComponentProps, type ReactNode, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, CopyIcon, ExternalLinkIcon, FilePenIcon, FileSearchIcon, FileTextIcon, FolderIcon, HistoryIcon, ListTreeIcon, PauseIcon, PlayIcon, RotateCcwIcon, SquareIcon, SquareTerminalIcon, UserPlusIcon, UsersIcon, WrenchIcon } from "lucide-react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import {
	Message as AiMessage,
	MessageContent,
	MessageResponse,
} from "@/components/ai-elements/message";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Task, TaskContent, TaskTrigger } from "@/components/ai-elements/task";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { streamdownPlugins } from "@/core/streamdown/plugins";
import { writeTextToClipboard } from "@/core/clipboard";
import { delegateWorker, groupConsecutiveModelErrors, isDelegateCall, recoveredReplyIndex } from "@/lib/events";
import { useAgentLabel } from "@/lib/avatars";
import { formatTokens } from "@/lib/session-stats";
import { toolSummary } from "@/lib/tool-summary";
import { formatThinkingDuration } from "@/lib/thinking-timing";
import { cancelDelegation, getKnowledgeSelection, listKnowledgeBindings, openRoomFile, readKnowledgeNote, type KnowledgeBindingSummary } from "@/lib/api";
import type { ChatMessage, ToolCallView, WindowType } from "@/lib/types";
import { toast } from "sonner";
import { ManagerAvatar, WorkerAvatar } from "./worker-avatar";
import { InteractionCard } from "./interaction-card";
import { useWorkerProcessDrawer } from "./worker-process-context";

const TOOL_STATUS_LABEL: Record<ToolCallView["status"], string> = {
	pending: "待运行",
	running: "运行中",
	done: "完成",
	error: "失败",
	interrupted: "已中断",
};

/** 通用工具调用行的行首图标（按工具名区分；缺省由 TaskTrigger 给放大镜）。 */
function toolCallIcon(name: string) {
	if (name === "bash") return <SquareTerminalIcon className="size-4" />;
	if (name === "read") return <FileTextIcon className="size-4" />;
	if (name === "write" || name === "edit") return <FilePenIcon className="size-4" />;
	if (name === "grep" || name === "find") return <FileSearchIcon className="size-4" />;
	if (name === "ls") return <FolderIcon className="size-4" />;
	if (name === "search_agent_tools") return <WrenchIcon className="size-4" />;
	if (name === "create_group_window") return <UsersIcon className="size-4" />;
	if (name === "invite_to_group") return <UserPlusIcon className="size-4" />;
	return undefined;
}

const RoomFileContext = createContext<{ roomId: string; sessionId?: string } | undefined>(undefined);

type QuickActionDraft = (content: string) => void;
const CanDelegateContext = createContext(true);
const QuickActionDraftContext = createContext<QuickActionDraft | undefined>(undefined);



function OpenWorkerSessionButton(props: { sessionHandle?: string }) { void props; return null;
}

/** Bridges settled-message actions to the session composer without making a
 * message action execute an agent run immediately. */
export function MessageQuickActionProvider({ onDraft, canDelegate = true, children }: { onDraft: QuickActionDraft; canDelegate?: boolean; children: ReactNode }) {
	return <CanDelegateContext.Provider value={canDelegate}><QuickActionDraftContext.Provider value={onDraft}>{children}</QuickActionDraftContext.Provider></CanDelegateContext.Provider>;
}

function MessageQuickActions({
	kind,
	content,
	workerLabel,
	processDetails,
}: {
	kind: "manager" | "worker";
	content: string;
	workerLabel?: string;
	processDetails?: unknown;
}) {
	const onDraft = useContext(QuickActionDraftContext);
 const canDelegate = useContext(CanDelegateContext);
	const { openWorkerProcess } = useWorkerProcessDrawer();
	const [copied, setCopied] = useState(false);
	const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const process = processDetails as { processView?: boolean; delegationId?: string } | undefined;
	useEffect(() => () => {
		if (copiedTimer.current) clearTimeout(copiedTimer.current);
	}, []);

	const copy = async () => {
		if (!await writeTextToClipboard(content)) {
			toast.error("复制失败");
			return;
		}
		setCopied(true);
		if (copiedTimer.current) clearTimeout(copiedTimer.current);
		copiedTimer.current = setTimeout(() => setCopied(false), 1600);
	};
	const delegationRef = process?.delegationId ? `（delegationId: ${process.delegationId}）` : "";
	const worker = workerLabel ?? "该 Worker";

	return (
		<div className="home-message-actions" role="group" aria-label={`${kind === "manager" ? "Manager 回复" : "Worker 结果"}操作`}>
			<button type="button" className="home-message-action" onClick={() => void copy()} title={copied ? "已复制" : "复制正文"} aria-label={copied ? "已复制" : "复制正文"}>
				{copied ? <CheckIcon /> : <CopyIcon />}
			</button>
			{kind === "manager" && onDraft ? (
				<>
					<button type="button" className="home-message-action" onClick={() => onDraft("请基于上面的结论继续推进，下一步是：")} title="继续推进" aria-label="继续推进">
						<ChevronRightIcon />
					</button>
					{canDelegate ? <button type="button" className="home-message-action" onClick={() => onDraft("请基于上面的结论，选择合适的 Worker 执行：")} title="交给 Worker" aria-label="交给 Worker">
						<UserPlusIcon />
					</button> : null}
				</>
			) : null}
			{kind === "worker" && onDraft ? (
				<>
					<button type="button" className="home-message-action" onClick={() => onDraft(canDelegate ? `请让 ${worker} 继续处理上一项委托${delegationRef}：` : "请基于上面的结果继续推进：")} title={canDelegate ? "继续追问这个 Worker" : "继续推进"} aria-label={canDelegate ? "继续追问这个 Worker" : "继续推进"}>
						<ChevronRightIcon />
					</button>
					<button type="button" className="home-message-action" onClick={() => onDraft(canDelegate ? `请让 ${worker} 返工上一项委托${delegationRef}，修改要求：` : "请修改上面的结果，要求：")} title="要求返工" aria-label="要求返工">
						<RotateCcwIcon />
					</button>
				</>
			) : null}
			{kind === "worker" && process?.processView && process.delegationId ? (
				<button type="button" className="home-message-action" onClick={() => openWorkerProcess(process.delegationId!)} title="查看执行过程" aria-label="查看执行过程">
					<ListTreeIcon />
				</button>
			) : null}
		</div>
	);
}

/** 站内一级路由（与 src/app 下的页面一一对应）。聊天消息里指向这些路由的
 * href 是应用内导航，不能落入本地文件打开逻辑。 */
const APP_ROUTE_PREFIXES = ["/agents", "/calendar", "/chats", "/contacts", "/extensions", "/knowledge", "/read-later", "/settings"];

function isAppRoutePath(pathOnly: string): boolean {
	return APP_ROUTE_PREFIXES.some((route) => pathOnly === route || pathOnly.startsWith(`${route}/`));
}

/** href 指向站内路由时返回原 href（含查询串），否则 undefined。 */
function appRouteFromHref(href: string): string | undefined {
	const value = href.trim();
	if (!value.startsWith("/") || value.startsWith("//")) return undefined;
	const pathOnly = value.split(/[?#]/, 1)[0] ?? value;
	return isAppRoutePath(pathOnly) ? value : undefined;
}

function localPathFromHref(href: string): string | undefined {
	const value = href.trim();
	if (!value || value.startsWith("#") || value.startsWith("?") || value.startsWith("//")) return undefined;
	if (/^(?:https?|mailto|tel|data|blob):/i.test(value) || value.startsWith("/api/")) return undefined;
	if (/^file:/i.test(value)) return value;
	if (/^(?:sandbox|attachment):/i.test(value)) {
		const localValue = value.replace(/^(?:sandbox|attachment):(?:\/\/)?/i, "");
		try {
			return decodeURIComponent(localValue);
		} catch {
			return localValue;
		}
	}
	// Other URI schemes are browser links. Drive-letter paths are local files.
	if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return undefined;
	const pathOnly = value.split(/[?#]/, 1)[0] ?? value;
	if (isAppRoutePath(pathOnly)) return undefined;
	try {
		return decodeURIComponent(pathOnly);
	} catch {
		return pathOnly;
	}
}

/** Inline code is used heavily for paths in handoff summaries. Keep ordinary
 * code untouched and only promote values that have a strong path signal. */
function localPathFromInlineCode(value: string): string | undefined {
	const candidate = value.trim();
	if (!candidate || candidate.includes("\n")) return undefined;
	const localPath = localPathFromHref(candidate);
	if (!localPath) return undefined;
	const explicitLocalPath =
		/^(?:file|sandbox|attachment):/i.test(candidate) ||
		/^(?:\.{1,2}[\\/]|[\\/]|[a-z]:[\\/])/i.test(candidate);
	const fileLikePath = /(?:^|[\\/])[^\\/]+\.(?:html?|m?js|cjs|tsx?|jsx|py|jsonl?|mdx?|txt|csv|tsv|pdf|docx?|xlsx?|pptx?|png|jpe?g|webp|gif|svg|zip|tar|gz|toml|ya?ml|xml|sql|sh|zsh|bash|fish|rs|go|java|kt|swift|c|cc|cpp|h|hpp|css|scss|less|vue|svelte|log)$/i.test(localPath);
	return explicitLocalPath || fileLikePath ? localPath : undefined;
}

const knowledgeVaultCache = new Map<string, Promise<KnowledgeBindingSummary[]>>();

/** 会话挂载的可用知识库（选择集 ∩ available），按会话缓存。 */
function sessionKnowledgeVaults(sessionId: string): Promise<KnowledgeBindingSummary[]> {
	let cached = knowledgeVaultCache.get(sessionId);
	if (!cached) {
		cached = Promise.all([listKnowledgeBindings(), getKnowledgeSelection(`session:${sessionId}`)])
			.then(([bindings, selection]) => {
				const selected = new Set(selection.selectedBindingIds);
				return bindings.filter((binding) => binding.availability === "available" && selected.has(binding.id));
			})
			.catch(() => [] as KnowledgeBindingSummary[]);
		knowledgeVaultCache.set(sessionId, cached);
	}
	return cached;
}

/** 聊天里的相对 .md 路径若命中会话挂载的知识库笔记，返回站内查看链接。 */
async function knowledgeNoteHref(sessionId: string | undefined, localPath: string): Promise<string | undefined> {
	if (!sessionId || !/\.md$/i.test(localPath)) return undefined;
	if (/^(?:[a-z]:[\\/]|[\\/])/i.test(localPath)) return undefined;
	for (const vault of await sessionKnowledgeVaults(sessionId)) {
		try {
			await readKnowledgeNote(vault.id, localPath);
			return `/knowledge?vault=${encodeURIComponent(vault.id)}&note=${encodeURIComponent(localPath)}`;
		} catch { /* 不在这个库，继续试下一个 */ }
	}
	return undefined;
}

async function openLocalPath(roomId: string, localPath: string, sessionId?: string, navigate?: (href: string) => void) {
	// 知识库笔记优先：worker 引用的 wiki 相对路径按会话挂载库解析，命中走站内查看，
	// 否则回落到房间工作区文件（open-file 按 cwd 解析）。
	const noteHref = await knowledgeNoteHref(sessionId, localPath).catch(() => undefined);
	if (noteHref && navigate) {
		navigate(noteHref);
		return;
	}
	try {
		await openRoomFile(roomId, localPath);
	} catch (error) {
		toast.error(error instanceof Error ? error.message : "无法打开本地文件");
	}
}

function ChatMarkdownLink({ href = "", children, node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
	void node;
	const router = useRouter();
	const fileContext = useContext(RoomFileContext);
	const appRoute = appRouteFromHref(href);
	if (appRoute) {
		return (
			<Link href={appRoute} className="home-local-file-link">
				{children}
			</Link>
		);
	}
	const localPath = localPathFromHref(href);
	if (localPath && fileContext) {
		return (
			<button
				type="button"
				className="home-local-file-link"
				title={`打开本地文件：${localPath}`}
				onClick={() => void openLocalPath(fileContext.roomId, localPath, fileContext.sessionId, router.push)}
			>
				{children}
			</button>
		);
	}
	return <a href={href} target={href.startsWith("#") ? undefined : "_blank"} rel="noreferrer" {...props}>{children}</a>;
}

function ChatInlineCode({ children, node, ...props }: ComponentProps<"code"> & { node?: unknown }) {
	void node;
	const router = useRouter();
	const fileContext = useContext(RoomFileContext);
	const text = typeof children === "string" ? children : undefined;
	const appRoute = text ? appRouteFromHref(text) : undefined;
	if (appRoute) {
		return (
			<Link href={appRoute} className="home-local-path-code" title="打开站内页面">
				<code {...props}>{children}</code>
			</Link>
		);
	}
	const localPath = text ? localPathFromInlineCode(text) : undefined;
	if (localPath && fileContext) {
		return (
			<button
				type="button"
				className="home-local-path-code"
				title={`用系统默认应用打开：${localPath}`}
				onClick={() => void openLocalPath(fileContext.roomId, localPath, fileContext.sessionId, router.push)}
			>
				<code {...props}>{children}</code>
			</button>
		);
	}
	return <code {...props}>{children}</code>;
}

/** 聊天里的图片一律收敛为缩略图，点击弹出原图；文件名/mime 收进 hover。 */
function ChatImageThumbnail({ src, alt }: { src: string; alt?: string }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				className="block cursor-zoom-in overflow-hidden rounded-md border border-border bg-muted"
				title={alt ? `${alt} · 点击放大` : "点击放大"}
				onClick={() => setOpen(true)}
			>
				{/* eslint-disable-next-line @next/next/no-img-element -- 动态 data/blob 源，不走 next/image 优化管线 */}
				<img src={src} alt={alt ?? ""} className="max-h-40 max-w-60 object-cover" />
			</button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="w-auto gap-0 p-2 sm:max-w-[calc(100vw-4rem)]" aria-label={alt ?? "图片预览"}>
					<DialogTitle className="sr-only">{alt ?? "图片预览"}</DialogTitle>
					{/* eslint-disable-next-line @next/next/no-img-element -- 同上 */}
					<img src={src} alt={alt ?? ""} className="max-h-[85vh] max-w-full object-contain" />
				</DialogContent>
			</Dialog>
		</>
	);
}

/** Markdown（worker/manager 正文）里的图片同样收敛为缩略图，不再撑开聊天气泡。 */
function ChatMarkdownImage({ src, alt, node, ...props }: ComponentProps<"img"> & { node?: unknown }) {
	void node;
	void props;
	if (typeof src !== "string" || !src) return null;
	return <ChatImageThumbnail src={src} alt={typeof alt === "string" && alt ? alt : undefined} />;
}

const chatStreamdownProps = {
	...streamdownPlugins,
	components: { a: ChatMarkdownLink, inlineCode: ChatInlineCode, img: ChatMarkdownImage },
};

/**
 * 执行中计时器。起算点优先用消息时间戳（工具调用发起时刻）：组件随窗口
 * 切换/重挂载会重建，用挂载时间会清零；用消息时间戳则切换后仍显示真实
 * 已耗时。缺省（无时间戳）退回挂载时刻。
 */
function Elapsed({ active, since }: { active: boolean; since?: number }) {
	const [mountedAt] = useState(() => Date.now());
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [active]);
	const s = Math.max(0, Math.round((now - (since ?? mountedAt)) / 1000));
	const mm = String(Math.floor(s / 60)).padStart(2, "0");
	const ss = String(s % 60).padStart(2, "0");
	return <span className="tabular-nums text-muted-foreground">{active ? `${mm}:${ss}` : ""}</span>;
}

/** worker 回报的委托状态 → 中文徽标文案（未识别的兜底原始值）。 */
const WORKER_STATUS_LABEL: Record<string, string> = {
	running: "执行中",
	completed: "完成",
	needs_input: "等待审批",
	cancelled: "已取消",
	observation_lost: "失去观测 · 效果未知",
	failed: "失败",
	// 历史卡：direct 镜像在失败时写过 vocab 外的 "error"（agent-extensions soloMeta），
	// 新数据已统一 failed，这里仅为兼容旧会话记录。
	error: "失败",
	conflict: "会话占用",
	timeout: "超时",
};

function statusBadge(call: ToolCallView, since?: number) {
	const details = call.details as { status?: string } | undefined;
	if (call.status === "running" || details?.status === "running" || details?.status === "approved")
		return (
			<Badge variant="secondary" className="gap-1">
				<span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
				执行中 <Elapsed active since={since} />
			</Badge>
		);
	if (call.status === "error") return <Badge variant="destructive">失败</Badge>;
	if (call.status === "interrupted") return <Badge variant="outline">已中断</Badge>;
	if (call.status === "pending") return <Badge variant="secondary">准备中</Badge>;
	if (details?.status === "needs_input") return <Badge variant="secondary">等待审批</Badge>;
	if (details?.status && details.status !== "completed") {
		return <Badge variant="destructive">{WORKER_STATUS_LABEL[details.status] ?? details.status}</Badge>;
	}
	if (call.status === "done" || details?.status === "completed") return <Badge variant="secondary">完成</Badge>;
	return <Badge variant="outline">状态未知</Badge>;
}

/** Badge for a worker-reported status string (custom_message details). */
function workerStatusBadge(status?: string) {
	if (status === "needs_input") return <Badge variant="secondary">等待审批</Badge>;
	if (status && status !== "completed") {
		return <Badge variant="destructive">{WORKER_STATUS_LABEL[status] ?? status}</Badge>;
	}
	return <Badge variant="secondary">完成</Badge>;
}

/**
 * 展开/折叠时把卡片钉在原地：stopScroll() 暂停共享 Conversation 的底部跟随，
 * 同时记录卡片顶部的视口位置，React 提交后按位移补偿 scrollTop。
 * 阅读暂停意图由 Conversation 独立保持，不因负向 resize 的近底部重锁失效；
 * 这里的补偿只处理布局变化导致的卡片位移，不负责恢复自动跟随。
 */
function useAnchorPreservingToggle<T extends HTMLElement>() {
	const { stopScroll, scrollRef } = useStickToBottomContext();
	const rootRef = useRef<T | null>(null);
	const anchorTop = useRef<number | null>(null);
	const toggle = (setter: React.Dispatch<React.SetStateAction<boolean>>) => {
		anchorTop.current = rootRef.current?.getBoundingClientRect().top ?? null;
		stopScroll();
		setter((v) => !v);
	};
	useLayoutEffect(() => {
		const before = anchorTop.current;
		anchorTop.current = null;
		if (before === null) return;
		const el = rootRef.current;
		const scroller = scrollRef.current;
		if (!el || !scroller) return;
		const delta = el.getBoundingClientRect().top - before;
		if (delta !== 0) scroller.scrollTop += delta;
	});
	return { rootRef, toggle };
}

/** 委托任务的独立过程入口；任务摘要仍由相邻标题/箭头负责。 */
function ProcessViewButton({ details }: { details: unknown }) {
	const process = details as { processView?: boolean; delegationId?: string } | undefined;
	const { openWorkerProcess } = useWorkerProcessDrawer();
	if (!process?.processView || !process.delegationId) return null;
	return (
		<button
			type="button"
			className="home-process-link"
			onClick={() => openWorkerProcess(process.delegationId!)}
			title="打开执行过程"
		>
			<ListTreeIcon aria-hidden="true" />
			<span>执行过程</span>
		</button>
	);
}

/** Cancel exactly one delegated Run; the manager Session stays alive. */
function CancelDelegationButton({ delegationId, goalId }: { delegationId?: string; goalId?: string }) {
	const [cancelling, setCancelling] = useState(false);
	if (!delegationId) return null;
	return (
		<button
			type="button"
			disabled={cancelling}
			onClick={async () => {
				setCancelling(true);
				try {
					await cancelDelegation(delegationId, goalId);
					toast.success("已终止该 Worker 任务");
				} catch (error) {
					toast.error(error instanceof Error ? error.message : "无法终止任务");
					setCancelling(false);
				}
			}}
			className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive disabled:cursor-wait disabled:opacity-60"
			title="仅终止这个 Worker 任务，不影响 Goal 和其他任务"
		>
			<SquareIcon className="size-3 fill-current" />
			{cancelling ? "正在终止" : "终止任务"}
		</button>
	);
}

/**
 * A worker-authored entry in the member message flow (§7): avatar + name +
 * status badge + task + result markdown, standing on its own instead of being
 * wrapped inside the manager bubble. Shared by direct/group delegate tool blocks
 * and solo-synced pudding:task_result custom messages.
 */
/** 本任务 token 消耗（worker Run 聚合，经 details.usage 透传到结果卡/工具卡）。 */
interface TaskUsage {
	turns?: number;
	inputTokens?: number;
	outputTokens?: number;
	cost?: number;
}

/** 「输入 12.3K · 输出 1.2K」；成本不在会话 UI 中展示。 */
function usageMetaText(usage: TaskUsage | undefined): string | undefined {
	const inputTokens = typeof usage?.inputTokens === "number" && Number.isFinite(usage.inputTokens) ? usage.inputTokens : undefined;
	const outputTokens = typeof usage?.outputTokens === "number" && Number.isFinite(usage.outputTokens) ? usage.outputTokens : undefined;
	if (inputTokens === undefined && outputTokens === undefined) return undefined;
	return `输入 ${formatTokens(inputTokens ?? 0)} · 输出 ${formatTokens(outputTokens ?? 0)}`;
}

function WorkerTaskEntry({
	worker,
	task,
	result,
	badge,
	processDetails,
	running,
	isError,
	meta,
	usage,
	timestamp,
	progress,
	actions,
	children,
}: {
	worker: string;
	task?: string;
	result?: string;
	badge: React.ReactNode;
	/** 委托过程元数据，仅供独立的「执行过程」按钮使用。 */
	processDetails?: unknown;
	running?: boolean;
	isError?: boolean;
	meta?: string;
	/** 本任务 token 消耗（worker Run 聚合）。 */
	usage?: TaskUsage;
	timestamp?: number;
	progress?: string;
	/** 额外动作区（如 pi worker 的「执行过程」入口）。 */
	actions?: React.ReactNode;
	children?: React.ReactNode;
}) {
	// worker 工作过程：运行中展开看进度，完成后默认收成一行摘要（任务首行 + 状态），
	// chevron 可再展开整卡；完成态的长结果另有 clamp。
	// worker prop 是内部 id（头像/详情用），展示渲染显示名。
	const workerLabel = useAgentLabel(worker);
	const { renderInlineProcess } = useWorkerProcessDrawer();
	const finished = !running && result !== undefined && result !== "";
	const [open, setOpen] = useState(!finished);
	const [wasFinished, setWasFinished] = useState(finished);
	// 运行中 → 完成时自动折叠一次；历史消息挂载即按完成态收起。
	if (finished !== wasFinished) {
		setWasFinished(finished);
		if (finished) setOpen(false);
	}
	const [resultOpen, setResultOpen] = useState(true);
	const [taskOpen, setTaskOpen] = useState(false);
	const { rootRef, toggle: toggleKeepingAnchor } = useAnchorPreservingToggle<HTMLDivElement>();
	const toggleTaskSummary = () => toggleKeepingAnchor(setOpen);
	const time = timestamp
		? new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
		: "";
	const expandableResult = Boolean(result && (result.length > 1200 || result.split("\n").length > 24));
	const clampTask = Boolean(task && (task.length > 240 || task.split("\n").length > 5));
	const usageText = usageMetaText(usage);

	const header = (
		<div className="flex items-center gap-2">
			<button
				type="button"
				onClick={() => toggleKeepingAnchor(setOpen)}
				className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				aria-label={open ? "收起任务摘要" : "展开任务摘要"}
				aria-expanded={open}
			>
				{open ? (
					<ChevronDownIcon className="size-4 shrink-0" />
				) : (
					<ChevronRightIcon className="size-4 shrink-0" />
				)}
			</button>
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<button
					type="button"
					onClick={toggleTaskSummary}
					className="home-worker-task-link flex min-w-0 items-center gap-2 text-left"
					title={open ? "收起任务摘要" : "展开任务摘要"}
				>
					<span className="truncate font-mono text-sm font-medium">{workerLabel}</span>
					{/* 状态徽标由调用方按 details/status 推导（含 needs_input 等待审批），
					    不能在这里按完成/失败二分写死。 */}
					{badge}
				</button>
				{!finished ? <ProcessViewButton details={processDetails} /> : null}
			</div>
			{actions}
			{time ? <time className="text-muted-foreground/60 text-[10px] tabular-nums">{time}</time> : null}
		</div>
	);

	// 任务块：左侧竖线引用样式，和长结果/正文区分开；clamp 开关独占一行，
	// 不再贴在正文尾巴上被当成普通文本。
	const taskBlock = task ? (
		<div className="mt-1 border-l-2 border-border/70 pl-2">
			<p className="text-xs text-muted-foreground">
				<span className="mr-1.5 text-muted-foreground/60">任务：</span>
				<span className={`whitespace-pre-wrap ${clampTask && !taskOpen ? "line-clamp-3" : ""}`}>{task}</span>
			</p>
			{clampTask ? (
				<button
					type="button"
					className="mt-0.5 flex items-center gap-0.5 text-[11px] text-muted-foreground/80 hover:text-foreground"
					onClick={() => toggleKeepingAnchor(setTaskOpen)}
				>
					{taskOpen ? "收起任务详情" : "展开任务详情"}
					<ChevronDownIcon className={`size-3 transition-transform ${taskOpen ? "rotate-180" : ""}`} />
				</button>
			) : null}
		</div>
	) : null;

	const collapsedPreview = task ? (
		<button type="button" className="mt-1 block w-full truncate text-left text-xs text-muted-foreground hover:text-foreground" onClick={toggleTaskSummary} title="展开任务摘要">
			<span className="mr-1.5 text-muted-foreground/60">任务：</span>
			{task}
		</button>
	) : null;

	const inlineId = (processDetails as { delegationId?: string } | undefined)?.delegationId;
	const inlineProcess = inlineId ? renderInlineProcess?.(inlineId, result) : null;
	if (inlineProcess) return <div className="w-full min-w-0">{actions ? <div className="mb-2 flex justify-end" role="group" aria-label="Worker 任务操作">{actions}</div> : null}{inlineProcess}{children}</div>;

	if (finished) {
		return (
			<div ref={rootRef} className="home-worker-entry is-finished">
				<WorkerAvatar name={worker} size={34} className="shrink-0" />
				<div className="home-worker-finished-body">
					{header}
					{open ? (
						<>
							{taskBlock}
							{/* 结果区与任务块用分隔线区分归属，避免长任务和长结果视觉上粘连。 */}
							<div className="mt-2 border-t border-border/60 pt-1.5">
								<div className={`home-worker-result ${!resultOpen && expandableResult ? "is-clamped" : ""} ${isError ? "text-destructive" : ""}`}>
									<MessageResponse {...chatStreamdownProps}>{result}</MessageResponse>
								</div>
								{expandableResult || usageText ? (
									<div className="home-worker-result-footer">
										{expandableResult ? (
											<button
												type="button"
												className="home-worker-result-toggle"
												onClick={() => toggleKeepingAnchor(setResultOpen)}
											>
												{resultOpen ? "收起结果" : "展开结果"}
												<ChevronDownIcon className={resultOpen ? "rotate-180" : ""} />
											</button>
										) : null}
										{usageText ? <p className="home-worker-result-usage">{usageText}</p> : null}
									</div>
								) : null}
							</div>
							<MessageQuickActions kind="worker" content={result} workerLabel={workerLabel} processDetails={processDetails} />
						</>
					) : (
						collapsedPreview
					)}
				</div>
			</div>
		);
	}

	return (
		<div ref={rootRef} className="home-worker-entry flex w-full items-start gap-2.5">
			<WorkerAvatar name={worker} size={34} className="shrink-0" />
			<div className="min-w-0 flex-1">
				{header}
				{open ? (
					<>
						{taskBlock}
						{running ? (
							<p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
								<span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
								{progress ?? "等待 worker 完成…"}
							</p>
						) : null}
						{children}
						{result !== undefined && result !== "" && (
							<div className="mt-2 border-t border-border/60 pt-1.5">
								<div className={`text-sm ${isError ? "text-destructive" : ""}`}>
									<MessageResponse {...chatStreamdownProps}>{result}</MessageResponse>
								</div>
							</div>
						)}
						{meta ? <p className="mt-1 text-xs text-muted-foreground/70 tabular-nums">{meta}</p> : null}
						{usageText ? <p className="mt-1 text-xs text-muted-foreground/70 tabular-nums">{usageText}</p> : null}
					</>
				) : (
					collapsedPreview
				)}
			</div>
		</div>
	);
}

function toolCallMeta(call: ToolCallView): string | undefined {
	const details = call.details as
		| { status?: string; outcome?: string; exitCode?: number; elapsedMs?: number }
		| undefined;
	if (!details || (!details.status && details.outcome === undefined)) return undefined;
	return [
		details.status ? (WORKER_STATUS_LABEL[details.status] ?? details.status) : undefined,
		details.outcome,
		details.elapsedMs !== undefined ? `${(details.elapsedMs / 1000).toFixed(0)}s` : undefined,
		details.exitCode !== undefined ? `exit ${details.exitCode}` : undefined,
	]
		.filter((x): x is string => Boolean(x))
		.filter((x, i, arr) => arr.indexOf(x) === i)
		.join(" · ");
}

/** Specialized card for a delegate tool call — rendered as a member message
 * (worker avatar + name + result), with the raw tool call kept expandable. */
function DelegateCard({ call, onOpenWindow, timestamp }: { call: ToolCallView; onOpenWindow?: (windowId: string) => void; timestamp?: number }) {
	const args = call.args as { task?: string } | undefined;
	const worker = delegateWorker(call);
	// worker 是内部 id（头像/工具详情用），卡面展示显示名。
	const workerLabel = useAgentLabel(worker ?? "worker");
	const details = call.details as
		| {
				status?: string;
				synced?: boolean;
				windowId?: string;
				conflict?: boolean;
				interactionId?: string;
				delegationId?: string;
				goalId?: string;
				processView?: boolean;
				revision?: number;
				kind?: "permission" | "question" | "confirmation";
				source?: "worker" | "platform_policy";
				workerStarted?: boolean;
				requests?: Array<{ requestId: string; prompt: string; command?: string; path?: string; risk?: string; options?: string[] }>;
		  }
		| undefined;
	const [open, setOpen] = useState(false);
	const resumedRunning = details?.status === "running" || details?.status === "approved";
	// 任务/结果主体：运行中展开看进度，完成后自动折叠（可手动再展开）。
	const finished = !resumedRunning && (call.status === "done" || call.status === "error" || call.status === "interrupted");
	const [bodyOpen, setBodyOpen] = useState(!finished);
	const [wasFinished, setWasFinished] = useState(finished);
	if (finished !== wasFinished) {
		// render 期间按 props 变化调整 state（React 推荐模式）：running→done 折叠一次。
		setWasFinished(finished);
		if (finished) setBodyOpen(false);
	}
	const meta = toolCallMeta(call);
	const { rootRef, toggle: toggleKeepingAnchor } = useAnchorPreservingToggle<HTMLDivElement>();
	const toggleTaskSummary = () => toggleKeepingAnchor(setBodyOpen);

	// 409 冲突 + 带 pending interactionId：冲突优先显示，并保留对账的 interactionId。
	const conflict = details?.status === "conflict" || details?.conflict;
	if (conflict && details?.interactionId) {
		return (
			<div className="flex w-full flex-col gap-2">
				<div className="w-full overflow-hidden rounded-lg border border-destructive/40 bg-muted/60 px-3 py-2">
					<p className="text-xs text-destructive">
						该 worker 的会话仍在等待上一个任务的审批，不能发起新任务（409）。
					</p>
					{args?.task ? (
						<p className="mt-1 text-xs text-muted-foreground">
							<span className="mr-1.5 text-muted-foreground/60">任务：</span>
							<span className="whitespace-pre-wrap">{args.task}</span>
						</p>
					) : null}
				</div>
				<InteractionCard
					interactionId={details.interactionId}
					worker={worker ?? "worker"}
					goalId={details.goalId}
					kind={details.kind}
					requests={details.requests}
					revision={details.revision}
					windowId={details.windowId}
					source={details.source}
					workerStarted={details.workerStarted}
					onOpenWindow={onOpenWindow}
				/>
			</div>
		);
	}

	// HITL：等待审批的审批卡由 invoker 写入会话的 pudding:interaction_required
	// custom message 承载（唯一事实源，可折叠/对账）；这里不再内联渲染，
	// 否则同一窗口会出现两张相同的审批卡。

	// 409 冲突（无 interactionId）：渲染带「去处理」跳转的占用卡。
	if (conflict) {
		return (
			<InteractionCard
				worker={worker ?? "worker"}
				statusHint="conflict"
				windowId={details?.windowId}
				onOpenWindow={onOpenWindow}
			/>
		);
	}

	return (
		<div ref={rootRef} className="home-delegate-card w-full overflow-hidden rounded-lg bg-muted">
			<div className="flex items-center justify-between gap-2 px-3 pt-2">
				<button
					type="button"
					onClick={() => toggleKeepingAnchor(setBodyOpen)}
					className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
					aria-label={bodyOpen ? "收起任务摘要" : "展开任务摘要"}
					aria-expanded={bodyOpen}
				>
					{bodyOpen ? (
						<ChevronDownIcon className="size-3.5 shrink-0" />
					) : (
						<ChevronRightIcon className="size-3.5 shrink-0" />
					)}
				</button>
				<button
					type="button"
					onClick={toggleTaskSummary}
					className="home-delegate-task-link flex min-w-0 flex-1 items-center gap-2 text-left"
					title={bodyOpen ? "收起任务摘要" : "展开任务摘要"}
				>
					<WorkerAvatar name={worker ?? "worker"} size={20} />
					<span className="truncate font-mono text-sm font-medium">{workerLabel}</span>
				</button>
				<div className="flex shrink-0 items-center gap-2">
					<ProcessViewButton details={call.details} />
					{call.status === "running" || resumedRunning ? <CancelDelegationButton delegationId={details?.delegationId} goalId={details?.goalId} /> : null}

					{statusBadge(call, timestamp)}
				</div>
			</div>
			{bodyOpen ? (
				<div className="flex flex-col gap-2 p-3">
					{args?.task ? (
						<p className="text-xs text-muted-foreground">
							<span className="mr-1.5 text-muted-foreground/60">任务：</span>
							<span className="whitespace-pre-wrap">{args.task}</span>
						</p>
					) : null}
					{call.status === "running" || resumedRunning ? (
						<p className="text-xs text-muted-foreground">{call.progress ?? "等待 worker 完成…"}</p>
					) : null}
					{/* needs_input 的旧 toolResult 是“等待审批”快照；批准续跑后
					    隐藏这段过期正文，以实时 running 状态为准。 */}
					{call.result !== undefined && !resumedRunning && (
						<div className={`text-sm ${call.isError ? "text-destructive" : ""}`}>
							<MessageResponse {...chatStreamdownProps}>{call.result}</MessageResponse>
						</div>
					)}
					{meta ? <p className="text-xs text-muted-foreground/70 tabular-nums">{meta}</p> : null}
					{usageMetaText((call.details as { usage?: TaskUsage } | undefined)?.usage) ? (
						<p className="text-xs text-muted-foreground/70 tabular-nums">
							{usageMetaText((call.details as { usage?: TaskUsage } | undefined)?.usage)}
						</p>
					) : null}
					<Collapsible open={open} onOpenChange={setOpen}>
						<CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground">
							{open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
							工具详情
						</CollapsibleTrigger>
						<CollapsibleContent className="mt-2">
							<pre className="overflow-x-auto rounded-md bg-muted/60 p-2 text-xs">
								{JSON.stringify(
									{
										worker,
										status: details?.status,
										task: args?.task,
									},
									null,
									2,
								)}
							</pre>
						</CollapsibleContent>
					</Collapsible>
				</div>
			) : (
				<button type="button" className="block w-full px-3 pb-2 pt-1 text-left" onClick={toggleTaskSummary} title="展开任务摘要">
					{args?.task ? (
						<span className="block truncate text-xs text-muted-foreground transition-colors hover:text-foreground">
							<span className="mr-1.5 text-muted-foreground/60">任务：</span>
							{args.task}
						</span>
					) : null}
				</button>
			)}
		</div>
	);
}

function ToolCallItem({
	call,
	windowType,
	onOpenWindow,
	timestamp,
}: {
	call: ToolCallView;
	windowType?: WindowType;
	onOpenWindow?: (windowId: string) => void;
	timestamp?: number;
}) {
	if (isDelegateCall(call)) {
		// §7 成员消息流：direct/group 下脱离 manager 气泡，渲染为 worker 独立条目。
		// 等待审批的交互卡由 pudding:interaction_required custom message 承载；
		// 批准续跑后隐藏旧 needs_input toolResult，按普通 running worker 条目渲染。
		if (windowType && windowType !== "solo") {
			const args = call.args as { task?: string } | undefined;
				const details = call.details as { status?: string; delegationId?: string; goalId?: string } | undefined;
			const resumedRunning = details?.status === "running" || details?.status === "approved";
			const running = call.status === "running" || resumedRunning;
			return (
				<WorkerTaskEntry
					worker={delegateWorker(call) ?? "worker"}
					task={args?.task}
					result={resumedRunning ? undefined : call.result}
					badge={statusBadge(call, timestamp)}
					processDetails={call.details}
					running={running}
					isError={resumedRunning ? false : call.isError}
					meta={toolCallMeta(call)}
					usage={(call.details as { usage?: TaskUsage } | undefined)?.usage}
					timestamp={timestamp}
					progress={call.progress}
					actions={running ? <CancelDelegationButton delegationId={details?.delegationId} goalId={details?.goalId} /> : null}
				/>
			);
		}
		return <DelegateCard call={call} onOpenWindow={onOpenWindow} timestamp={timestamp} />;
	}
	// manager 建房卡：create_group_window 成功后给「打开群聊」跳转。
	if (call.name === "create_group_window") {
		const details = call.details as { windowId?: string; members?: string[]; name?: string } | undefined;
		if (details?.windowId) {
			return (
				<div className="w-full overflow-hidden rounded-lg bg-muted">
					<div className="flex items-center justify-between gap-2 px-3 py-2">
						<div className="flex min-w-0 items-center gap-2 text-sm">
							<UsersIcon className="size-4 shrink-0 text-muted-foreground" />
							<span className="truncate">
								已创建群聊{details.name ? `「${details.name}」` : ""}
								{details.members?.length ? `（${details.members.join("、")}）` : ""}，任务已下达
							</span>
						</div>
						<div className="flex shrink-0 items-center gap-2">
							<button
								type="button"
								onClick={() => onOpenWindow?.(details.windowId!)}
								className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
							>
								打开群聊
								<ExternalLinkIcon className="size-3" />
							</button>
							{statusBadge(call, timestamp)}
						</div>
					</div>
				</div>
			);
		}
	}
	return (
		// 工具调用过程默认收起：只保留一行「状态 · 工具名」，args/结果点开再看。
		<Task defaultOpen={false}>
			<TaskTrigger title={`${TOOL_STATUS_LABEL[call.status]} · ${call.name}`} icon={toolCallIcon(call.name)} />
			<TaskContent>
				{call.args !== undefined && (
					<pre className="overflow-x-auto rounded-md bg-muted/60 p-2 text-xs">
						{JSON.stringify(call.args, null, 2)}
					</pre>
				)}
				{call.result !== undefined && (
					<pre
						className={`max-h-60 overflow-y-auto whitespace-pre-wrap text-xs ${
							call.isError ? "text-destructive" : ""
						}`}
					>
						{call.result}
					</pre>
				)}
				{call.status === "running" && (
					<p className="text-muted-foreground text-xs">执行中…</p>
				)}
			</TaskContent>
		</Task>
	);
}

/** role:"custom" entries written by the platform (solo task sync, §4.4). */
function CustomMessageEntry({
	message,
	resolvedTaskIds,
}: {
	message: ChatMessage;
	resolvedTaskIds?: Set<string>;
}) {
	const details = message.details as
		| {
				worker?: string;
				jobId?: string;
				failureCode?: string;
				bindingId?: string;
				batchId?: string;
				status?: string;
				taskId?: string;
				from?: string;
				windowId?: string;
				interactionId?: string;
				delegationId?: string;
				goalId?: string;
				sessionHandle?: string;
				processView?: boolean;
				revision?: number;
				kind?: "permission" | "question" | "confirmation";
				source?: "worker" | "platform_policy";
				workerStarted?: boolean;
				terminal?: boolean;
				usage?: TaskUsage;
				requests?: Array<{ requestId: string; prompt: string; command?: string; path?: string; risk?: string; options?: string[] }>;
		  }
		| undefined;

	if (message.customType === "pudding:session_goal" && (message.details as {historical?:boolean})?.historical) return <div className="rounded-lg border p-3 text-sm whitespace-pre-wrap">{message.content}</div>;

	if (message.customType === "pudding:knowledge_job") {
		return <KnowledgeJobCard content={message.content} details={details} />;
	}

	// direct 直派（§5.2）：用户发言以普通用户气泡呈现。
	if (message.customType === "pudding:user_message") {
		return (
			<AiMessage from="user" className="home-user-message" data-query-axis-id={message.id}>
				<MessageContent>
					<p className="text-sm whitespace-pre-wrap">{message.content}</p>
				</MessageContent>
			</AiMessage>
		);
	}

	if (message.customType === "pudding:task_assign") {
		// 结果/审批卡到达后（同 taskId），running 态落定，不再显示「执行中」。
		const running = details?.status === "running" && !resolvedTaskIds?.has(details?.taskId ?? "");
		if (details?.from === "direct") {
			// direct 窗口：用户消息就在上方，指派卡只作 worker 侧运行指示，
			// 落定后整张收起（结果卡已说明一切）。
			if (!running) return null;
			return (
					<WorkerTaskEntry
						worker={details?.worker ?? "worker"}
					badge={<Badge variant="secondary">执行中</Badge>}
					processDetails={details}
					running
					timestamp={message.timestamp}
					actions={<><OpenWorkerSessionButton sessionHandle={details?.sessionHandle} /><CancelDelegationButton delegationId={details?.delegationId} goalId={details?.goalId} /></>}
				/>
			);
		}
		if (details?.from === "solo") {
			// A manager-routed task should still feel like a normal direct worker
			// conversation: user-side task first, then one worker running row, then
			// the eventual worker result. Keep process/cancel controls on the worker
			// row instead of burying them in the task bubble.
			return (
				<>
					<AiMessage from="user" className="home-user-message">
						<MessageContent>
							<p className="text-xs text-muted-foreground">Manager 委派</p>
							<p className="text-sm whitespace-pre-wrap">{message.content}</p>
							<OpenWorkerSessionButton sessionHandle={details?.sessionHandle} />
						</MessageContent>
					</AiMessage>
					{running ? (
						<WorkerTaskEntry
							worker={details?.worker ?? "worker"}
							badge={(
								<Badge variant="secondary" className="gap-1">
									<span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
									执行中 <Elapsed active since={message.timestamp} />
								</Badge>
							)}
							processDetails={details}
							running
							timestamp={message.timestamp}
							actions={<><OpenWorkerSessionButton sessionHandle={details?.sessionHandle} /><CancelDelegationButton delegationId={details?.delegationId} goalId={details?.goalId} /></>}
						/>
					) : null}
				</>
			);
		}
		return (
			<AiMessage from="user" className="home-user-message">
				<MessageContent>
					<p className="text-xs text-muted-foreground">派给 {details?.worker ?? "worker"}</p>
					<p className="text-sm whitespace-pre-wrap">{message.content}</p>
					<OpenWorkerSessionButton sessionHandle={details?.sessionHandle} />
					{running ? (
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<span>执行中…</span>
							<CancelDelegationButton delegationId={details?.delegationId} goalId={details?.goalId} />
						</div>
					) : null}
				</MessageContent>
			</AiMessage>
		);
	}

	if (message.customType === "pudding:task_result") {
		return (
			<WorkerTaskEntry
				worker={details?.worker ?? "worker"}
				result={message.content}
				badge={workerStatusBadge(details?.status)}
				processDetails={details}
				isError={Boolean(details?.status && details.status !== "completed" && details.status !== "needs_input")}
				timestamp={message.timestamp}
				usage={details?.usage}
				actions={<OpenWorkerSessionButton sessionHandle={details?.sessionHandle} />}
			/>
		);
	}

	// HITL：审批卡（§6.5）——历史中只存安全投影（无 token），状态由服务端对账。
	if (message.customType === "pudding:interaction_required") {
		return (
			<InteractionCard
					interactionId={details?.interactionId}
					worker={details?.worker ?? "worker"}
					goalId={details?.goalId}
					kind={details?.kind}
				requests={details?.requests}
					revision={details?.revision}
				windowId={details?.windowId}
				source={details?.source}
				workerStarted={details?.workerStarted}
				onOpenWindow={undefined}
			/>
		);
	}

	// 状态变化追加一条 resolved 事件；前端按 interactionId 折叠到原卡片。
	if (message.customType === "pudding:interaction_resolved") {
		const text =
			details?.status === "approved"
				? "审批已批准，任务继续执行中。"
				: details?.status === "rejected"
					? "审批已拒绝，任务已取消。"
					: details?.status === "failed"
						? "审批已批准，但任务执行失败。"
						: details?.status === "observation_lost"
							? "已停止等待审批；尚未确认上游任务终止，请先对账。"
						: "审批已处理。";
		return <p className="text-xs text-muted-foreground">{text}</p>;
	}

	// Goal 生命周期投影：content 是写给模型的恢复指令，聊天里只展示人性化状态，
	// 具体进度与恢复操作在工作状态面板（暂停横幅带「继续」按钮）。
	if (message.customType === "pudding:goal_interrupted" || message.customType === "pudding:goal_recovery" || message.customType === "pudding:decision_answered") {
		const text = message.customType === "pudding:goal_interrupted"
			? details?.terminal
				? "已没有可继续的任务，Goal 已自动关闭。"
				: "Goal 已暂停；已完成的部分都会保留，可以随时继续。"
			: message.customType === "pudding:goal_recovery"
				? "Goal 正在从上次的安全进度继续。"
				: "已收到你的决定，任务继续推进。";
		const NoticeIcon = message.customType === "pudding:goal_interrupted" ? PauseIcon : message.customType === "pudding:goal_recovery" ? PlayIcon : CheckIcon;
		return (
			<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
				<NoticeIcon className="size-3.5" />
				{text}
			</p>
		);
	}

	// Unknown custom types stay visible but unobtrusive.
	return (
		<p className="text-xs text-muted-foreground">
			[{message.customType ?? "custom"}] {message.content}
		</p>
	);
}

function MessageBody({
	message,
	windowType,
	onOpenWindow,
	resolvedTaskIds,
	assistantAs,
}: {
	message: ChatMessage;
	windowType?: WindowType;
	onOpenWindow?: (windowId: string) => void;
	resolvedTaskIds?: Set<string>;
	/** assistant 消息的身份覆盖：worker 执行过程查看器里 assistant 是 worker
	 *  自己（内部 id，头像/显示名按它解析），缺省为 Manager。 */
	assistantAs?: string;
}) {
	const assistantLabel = useAgentLabel(assistantAs ?? "");
	if (message.role === "user") {
		const images = message.images ?? [];
		return (
			<AiMessage from="user" className="home-user-message" data-query-axis-id={message.id}>
				<MessageContent>
					{message.content ? <p className="whitespace-pre-wrap">{message.content}</p> : null}
					{images.length ? (
						<div className={`flex flex-wrap gap-2 ${message.content ? "mt-2" : ""}`}>
							{images.map((image, index) => (
								<ChatImageThumbnail
									key={`${image.mimeType}:${index}`}
									src={`data:${image.mimeType};base64,${image.data}`}
									alt={image.name ?? image.mimeType}
								/>
							))}
						</div>
					) : null}
				</MessageContent>
			</AiMessage>
		);
	}

	if (message.role === "custom") {
		return <CustomMessageEntry message={message} resolvedTaskIds={resolvedTaskIds} />;
	}

	if (message.role === "toolResult") {
		return (
			<Task defaultOpen={false}>
				<TaskTrigger title={`工具结果 · ${message.name ?? ""}`} />
				<TaskContent>
					<pre className="text-sm whitespace-pre-wrap">{message.content}</pre>
				</TaskContent>
			</Task>
		);
	}

	const showThinking =
		Boolean(message.thinking) || (message.streaming && !message.content && message.toolCalls.length === 0);
	const showContent = Boolean(message.content) || message.error;

	// §7: in direct/group windows delegate tool blocks leave the manager bubble
	// and render as standalone worker entries; other tools stay inside.
	const memberFlow = windowType === "direct" || windowType === "group";
	const bubbleCalls = memberFlow ? message.toolCalls.filter((c) => !isDelegateCall(c)) : message.toolCalls;
	const workerCalls = memberFlow ? message.toolCalls.filter((c) => isDelegateCall(c)) : [];
	const showBubble = showThinking || showContent || bubbleCalls.length > 0;

	const time = new Date(message.timestamp).toLocaleTimeString("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

	return (
		<>
			{showBubble && (
				<div className="home-assistant-message">
					{message.puddingHistorical ? <HistoryIcon className="home-manager-avatar size-[34px] shrink-0 p-2 text-muted-foreground" aria-label="来源历史" /> : assistantAs ? (
						<WorkerAvatar name={assistantAs} size={34} className="home-manager-avatar" />
					) : (
						<ManagerAvatar size={34} className="home-manager-avatar" />
					)}
					<div className="home-assistant-body">
						<div className="home-message-meta"><strong>{message.puddingHistorical ? "来源历史" : assistantAs ? assistantLabel : "Manager"}</strong><span>{time}</span></div>
						{showThinking && (
							<AssistantReasoning streaming={message.streaming} thinking={message.thinking} startedAt={message.timestamp} />
						)}
						{bubbleCalls.length > 0 && (
							<div className="flex w-full flex-col gap-2">
								{bubbleCalls.map((call) => (
									<ToolCallItem key={call.id} call={call} windowType={windowType} onOpenWindow={onOpenWindow} timestamp={message.timestamp} />
								))}
							</div>
						)}
						{showContent && (
							<>
								{message.error && message.modelError ? (
									<ModelErrorSummary messages={[message]} />
								) : (
									<>
										<MessageResponse className="home-message-response" {...chatStreamdownProps}>{message.content}</MessageResponse>
										<ErrorTechnicalDetails detail={message.errorDetail} />
									</>
								)}
								{!message.streaming && message.content && !message.error ? <MessageQuickActions kind={assistantAs ? "worker" : "manager"} content={message.content} workerLabel={assistantAs ? assistantLabel : undefined} /> : null}
							</>
						)}
					</div>
				</div>
			)}
			{workerCalls.map((call) => (
				<ToolCallItem key={call.id} call={call} windowType={windowType} onOpenWindow={onOpenWindow} timestamp={message.timestamp} />
			))}
		</>
	);
}

export function Message({ roomId, sessionId, ...props }: {
	roomId: string;
	sessionId?: string;
	message: ChatMessage;
	windowType?: WindowType;
	onOpenWindow?: (windowId: string) => void;
	resolvedTaskIds?: Set<string>;
	assistantAs?: string;
}) {
	return (
		<RoomFileContext.Provider value={{ roomId, sessionId }}>
			<MessageBody {...props} />
		</RoomFileContext.Provider>
	);
}

function AssistantReasoning({
	streaming,
	thinking,
	startedAt,
	className,
}: {
	streaming: boolean;
	thinking?: string;
	/** pi assistant message timestamp：该 model turn 的稳定起点。 */
	startedAt: number;
	className?: string;
}) {
	return (
		<Reasoning
			isStreaming={streaming}
			startTimeProp={streaming ? startedAt : null}
			className={className}
		>
			<ReasoningTrigger hasContent={Boolean(thinking)} />
			<ReasoningContent>{thinking ?? ""}</ReasoningContent>
		</Reasoning>
	);
}

function ErrorTechnicalDetails({ detail }: { detail?: string }) {
	if (!detail) return null;
	return (
		<Collapsible className="mt-1">
			<CollapsibleTrigger className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
				<ChevronRightIcon className="size-3 transition-transform group-data-[state=open]:rotate-90" />
				查看技术详情
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-2 max-w-full rounded-md border bg-muted/40 p-3">
				<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">{detail}</pre>
			</CollapsibleContent>
		</Collapsible>
	);
}

function ModelErrorSummary({ messages, recovered = false }: { messages: ChatMessage[]; recovered?: boolean }) {
	const latest = messages[messages.length - 1];
	if (!latest?.modelError) return null;
	const attempts = messages.length;
	const detail = messages
		.map((message, index) => message.errorDetail ? `${attempts > 1 ? `尝试 ${index + 1}\n` : ""}${message.errorDetail}` : "")
		.filter(Boolean)
		.join("\n\n");
	const status = recovered
		? "重试成功"
		: attempts > 1
			? `${attempts} 次失败`
			: "请求失败";
	const summary = recovered
		? "之后的模型请求已成功返回，本轮正常结束。"
		: latest.modelError.explanation;

	return (
		<div className={`home-model-error${recovered ? " is-recovered" : ""}`} role={recovered ? "status" : "alert"}>
			<span className="home-model-error-icon">{recovered ? <CheckIcon /> : <CircleAlertIcon />}</span>
			<div className="home-model-error-body">
				{latest.modelError.partialContent ? <MessageResponse className="home-message-response mb-2" {...chatStreamdownProps}>{latest.modelError.partialContent}</MessageResponse> : null}
				<div className="home-model-error-title"><strong>{recovered ? "本次重试已成功" : latest.modelError.title}</strong><span>{status}</span></div>
				<p>{summary}</p>
				{!recovered ? <p className="home-model-error-action">{latest.modelError.action}</p> : null}
				<ErrorTechnicalDetails detail={detail} />
			</div>
		</div>
	);
}

/**
 * 工具折叠摘要行：一段里连续的非 delegate 工具调用折成一行
 * 「使用了 X 个工具，成功 Y 个，失败 Z 个」，以同一低强调行显示，
 * chevron 展开看每个工具细节；未完成/中断状态单独统计，不计为成功。
 */
function ToolSummaryRow({
	calls,
	windowType,
	onOpenWindow,
	timestamp,
}: {
	calls: ToolCallView[];
	windowType?: WindowType;
	onOpenWindow?: (windowId: string) => void;
	timestamp: number;
}) {
	const [open, setOpen] = useState(false);
	const { rootRef, toggle: toggleKeepingAnchor } = useAnchorPreservingToggle<HTMLDivElement>();
	const summary = toolSummary(calls);
	return (
		<Collapsible
			ref={rootRef}
			open={open}
			onOpenChange={() => toggleKeepingAnchor(setOpen)}
		>
			<CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
				{open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
				{summary.running > 0 ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground" /> : null}
				<span className="text-left">{summary.text}</span>
			</CollapsibleTrigger>
			<CollapsibleContent className="mt-2 flex w-full flex-col gap-2">
				{calls.map((call) => (
					<ToolCallItem key={call.id} call={call} windowType={windowType} onOpenWindow={onOpenWindow} timestamp={timestamp} />
				))}
			</CollapsibleContent>
		</Collapsible>
	);
}

type AssistantNode = { merged: ChatMessage[] } | { single: ChatMessage };

type AssistantSegment = {
	m: ChatMessage;
	messages: ChatMessage[];
	showThinking: boolean;
	showContent: boolean;
	foldCalls: ToolCallView[];
	cardCalls: ToolCallView[];
	recovered: boolean;
};

/**
 * 连续「只有思考/工具、没有正文」的 assistant 段合成一个过程段：
 * 一次 run 跑几轮 tool loop 时，折叠行只留一条「已深度思考」和一条工具摘要，
 * 而不是每轮各出一条。正文段不参与合并，保持与回答的先后关系；
 * 合并后计时从段内第一条 assistant turn 起算（含中间工具等待）。
 */
function mergeProcessSegments(segments: AssistantSegment[]): AssistantSegment[] {
	const merged: AssistantSegment[] = [];
	for (const segment of segments) {
		const prev = merged[merged.length - 1];
		const processOnly = !segment.showContent && segment.cardCalls.length === 0;
		const prevProcessOnly = prev ? !prev.showContent && prev.cardCalls.length === 0 : false;
		if (prev && processOnly && prevProcessOnly) {
			prev.showThinking = prev.showThinking || segment.showThinking;
			prev.foldCalls = prev.foldCalls.concat(segment.foldCalls);
			const thinking = [prev.m.thinking, segment.m.thinking].filter(Boolean).join("\n\n");
			prev.m = {
				...segment.m,
				id: prev.m.id,
				timestamp: prev.m.timestamp,
				thinking: thinking || undefined,
				streaming: prev.m.streaming || segment.m.streaming,
			};
			continue;
		}
		merged.push({ ...segment });
	}
	return merged;
}

/**
 * 整轮过程折叠（对齐 deepseek-harness 的 turn process）：
 * - 运行中：抬头显示「深度求索中 · 用时 N」，过程默认也收起，点开才看思考、工具与阶段回复；
 * - 结束后：抬头显示「已完成 · 用时 N」，过程保持收起（用户手动展开过就保持展开）；
 * - 失败：过程保持展开且不能收起，抬头显示「本轮失败」。
 * 运行中不再自动展开、结束再自动收起，避免过程内容「冒出来又缩回去」。
 * 最终答案正文不参与折叠，始终显示。
 */
function RunProcessSection({
	running,
	failed,
	hasProcess,
	hasFollowing,
	startedAt,
	recordedMs,
	children,
}: {
	running: boolean;
	failed: boolean;
	hasProcess: boolean;
	/** 控件下方是否还有答案或委派卡；没有就不画分割线，避免空尾巴。 */
	hasFollowing: boolean;
	startedAt: number;
	/** pi 落盘的整轮时长；历史加载也能拿到，优先于客户端观察值。 */
	recordedMs?: number;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [endedMs, setEndedMs] = useState<number | null>(null);
	const observedRunning = useRef(running);
	const { rootRef, toggle } = useAnchorPreservingToggle<HTMLDivElement>();
	useEffect(() => {
		if (running) {
			observedRunning.current = true;
			return;
		}
		// 运行 → 结束的第一次提交记下整轮用时；历史加载（从未运行过）不显示用时。
		if (observedRunning.current && endedMs === null) setEndedMs(Math.max(1000, Date.now() - startedAt));
	}, [running, startedAt, endedMs]);
	const expanded = failed || open;
	const settledMs = recordedMs ?? endedMs ?? undefined;
	const seconds = settledMs === undefined ? undefined : Math.max(1, Math.round(settledMs / 1000));
	const collapsible = hasProcess;
	const interactive = collapsible && !failed;
	// 没有过程、也没有可显示的用时（历史里的普通问答）不占一行。
	if (!running && !failed && !hasProcess && seconds === undefined) return null;
	return (
		<div ref={rootRef} className="flex w-full flex-col gap-2">
			<button
				type="button"
				disabled={failed || !hasProcess}
				aria-expanded={interactive ? open : undefined}
				onClick={() => toggle(setOpen)}
				className={`flex items-center gap-2 text-sm text-muted-foreground transition-colors enabled:hover:text-foreground disabled:cursor-default ${!running && (hasFollowing || failed) ? "border-b border-border/60 pb-2" : ""}`}
			>
				{interactive ? (open ? (
					<ChevronDownIcon className="size-4 shrink-0" />
				) : (
					<ChevronRightIcon className="size-4 shrink-0" />
				)) : null}
				{running ? (
					<Shimmer as="span" duration={1}>深度求索中</Shimmer>
				) : (
					<span>{failed ? "本轮失败" : "已完成"}</span>
				)}
				{running ? (
					<LiveRunDuration startedAt={startedAt} />
				) : !failed && seconds !== undefined ? (
					<span className="tabular-nums">· 用时 {formatThinkingDuration(seconds)}</span>
				) : null}
			</button>
			{collapsible ? (
				<Collapsible open={expanded}>
					<CollapsibleContent>{children}</CollapsibleContent>
				</Collapsible>
			) : null}
		</div>
	);
}

/** 运行中的整轮用时；每秒只重渲染这一行，不带着整棵消息树跳动。 */
function LiveRunDuration({ startedAt }: { startedAt: number }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const seconds = Math.max(1, Math.floor((now - startedAt) / 1000));
	return <span className="tabular-nums">· 用时 {formatThinkingDuration(seconds)}</span>;
}

/**
 * 合并气泡正文：连续 assistant 段（一个 run 的多个 turn，常只有 thinking+工具、
 * 无正文）渲染为一条气泡，段内按 thinking → 正文 → 工具摘要行 顺序排布。
 * §7 成员消息流：delegate 工具段要脱离气泡独立成 worker 条目，打断合并走旧渲染；
 * solo 窗口 delegate 卡（DelegateCard）不入折叠，按段内顺序全卡渲染。
 */
function AssistantGroupBody({
	messages,
	windowType,
	onOpenWindow,
	assistantAs,
}: {
	messages: ChatMessage[];
	windowType?: WindowType;
	onOpenWindow?: (windowId: string) => void;
	assistantAs?: string;
}) {
	const assistantLabel = useAgentLabel(assistantAs ?? "");
	const memberFlow = windowType === "direct" || windowType === "group";
	const nodes: AssistantNode[] = [];
	for (const m of messages) {
		if (memberFlow && m.toolCalls.some((c) => isDelegateCall(c))) {
			nodes.push({ single: m });
			continue;
		}
		const last = nodes[nodes.length - 1];
		if (last && "merged" in last) last.merged.push(m);
		else nodes.push({ merged: [m] });
	}

	return (
		<>
			{nodes.map((node) => {
				if ("single" in node) {
					return (
						<MessageBody
							key={node.single.id}
							message={node.single}
							windowType={windowType}
							onOpenWindow={onOpenWindow}
							assistantAs={assistantAs}
						/>
					);
				}
				const visibleMessages = node.merged
					.filter((m) => Boolean(m.thinking) || (m.streaming && !m.content && m.toolCalls.length === 0) || Boolean(m.content) || m.error || m.toolCalls.length > 0);
				const rawSegments = groupConsecutiveModelErrors(visibleMessages)
					.map((messages) => {
						const m = messages[messages.length - 1]!;
						return {
							m,
							messages,
							showThinking:
								Boolean(m.thinking) || (m.streaming && !m.content && m.toolCalls.length === 0),
							showContent: Boolean(m.content) || Boolean(m.error),
							foldCalls: m.toolCalls.filter((c) => !isDelegateCall(c)),
							cardCalls: memberFlow ? [] : m.toolCalls.filter((c) => isDelegateCall(c)),
						};
					})
					.filter((s) => s.showThinking || s.showContent || s.foldCalls.length > 0 || s.cardCalls.length > 0);
				if (rawSegments.length === 0) return null;
				const recoveredIndex = recoveredReplyIndex(rawSegments.map((segment) => segment.m));
				// 整轮用时优先用落盘事实：最后一条 assistant 的 timestamp + durationMs 就是
				// 本段回复的真正结束时刻，减去本 run 第一条 assistant 的 timestamp 即整轮用时。
				const runStartedAt = rawSegments[0]!.m.timestamp;
				const lastTurn = rawSegments[rawSegments.length - 1]!.m;
				const recordedMs = typeof lastTurn.durationMs === "number"
					? Math.max(1000, lastTurn.timestamp + lastTurn.durationMs - runStartedAt)
					: undefined;
				const segments = mergeProcessSegments(
					rawSegments.map((segment, index) => ({ ...segment, recovered: index < recoveredIndex })),
				);
				// 一个 run 还活着 = 任一 assistant 段在流式，或还有未结算的（含 delegate）工具调用。
				const callActive = (call: ToolCallView) => call.status === "running" || call.status === "pending";
				const running = segments.some((segment) =>
					segment.m.streaming
					|| segment.foldCalls.some(callActive)
					|| segment.cardCalls.some(callActive),
				);
				// 失败只认最后一个段：中途模型重试成功后仍是正常完成（重试卡由 recovered 表达）。
				const lastSegment = segments[segments.length - 1]!;
				const failed = Boolean(lastSegment.m.error) || Boolean(lastSegment.m.modelError);
				// 最终答案 = 最后一个有正文、且没有工具调用块的段（对齐 harness 的 turn 规则）；
				// 其余段（阶段回复、思考、工具、委派卡）都属整轮过程。
				let answerIndex = -1;
				for (let index = segments.length - 1; index >= 0; index -= 1) {
					const segment = segments[index]!;
					if (segment.showContent && segment.foldCalls.length === 0 && segment.cardCalls.length === 0 && !segment.m.error) {
						answerIndex = index;
						break;
					}
				}
				const answer = answerIndex >= 0 ? segments[answerIndex]! : undefined;
				const hasFollowing = Boolean(answer) || segments.some((segment) => segment.cardCalls.length > 0);
				const hasProcess = segments.some((segment, index) =>
					Boolean(segment.m.thinking) || segment.foldCalls.length > 0
					|| (segment.showContent && index !== answerIndex),
				);
				const quickActionContent = [...new Set(segments.filter((segment) => !segment.m.error).map((segment) => segment.m.content).filter(Boolean))].join("\n\n");
				const lastTime = new Date(segments[segments.length - 1]!.m.timestamp).toLocaleTimeString("zh-CN", {
					hour: "2-digit",
					minute: "2-digit",
					hour12: false,
				});
				return (
					<div key={node.merged[0]!.id} className="home-assistant-message">
						{messages[0]?.puddingHistorical ? <HistoryIcon className="home-manager-avatar size-[34px] shrink-0 p-2 text-muted-foreground" aria-label="来源历史" /> : assistantAs ? (
							<WorkerAvatar name={assistantAs} size={34} className="home-manager-avatar" />
						) : (
							<ManagerAvatar size={34} className="home-manager-avatar" />
						)}
						<div className="home-assistant-body">
							<div className="home-message-meta">
								<strong>{messages[0]?.puddingHistorical ? "来源历史" : assistantAs ? assistantLabel : "Manager"}</strong>
								<span>{lastTime}</span>
							</div>
							<div className="flex w-full flex-col gap-3">
								<RunProcessSection running={running} failed={failed} hasProcess={hasProcess} hasFollowing={hasFollowing} startedAt={runStartedAt} recordedMs={recordedMs}>
									<div className="flex w-full flex-col gap-2">
										{segments.map((s, index) => {
											const processContent = s.showContent && index !== answerIndex;
											if (!s.m.thinking && !processContent && s.foldCalls.length === 0) return null;
											return (
												<div key={s.m.id} className="home-assistant-segment flex w-full flex-col gap-2">
													{s.m.thinking && <AssistantReasoning streaming={s.m.streaming} thinking={s.m.thinking} startedAt={s.m.timestamp} className="mb-0" />}
													{processContent && (
														s.m.error && s.m.modelError ? (
															<ModelErrorSummary messages={s.messages} recovered={s.recovered} />
														) : (
															<MessageResponse className="home-message-response" {...chatStreamdownProps}>{s.m.content}</MessageResponse>
														)
													)}
													{!s.m.modelError ? <ErrorTechnicalDetails detail={s.m.errorDetail} /> : null}
													{s.foldCalls.length > 0 && (
														<ToolSummaryRow
															calls={s.foldCalls}
															windowType={windowType}
															onOpenWindow={onOpenWindow}
															timestamp={s.m.timestamp}
														/>
													)}
												</div>
											);
										})}
									</div>
								</RunProcessSection>
								{segments.map((s) => s.cardCalls.map((call) => (
									<ToolCallItem
										key={call.id}
										call={call}
										windowType={windowType}
										onOpenWindow={onOpenWindow}
										timestamp={s.m.timestamp}
									/>
								)))}
								{answer && (
									<div className="home-assistant-segment flex w-full flex-col gap-2">
										<MessageResponse className="home-message-response" {...chatStreamdownProps}>{answer.m.content}</MessageResponse>
										{!answer.m.modelError ? <ErrorTechnicalDetails detail={answer.m.errorDetail} /> : null}
									</div>
								)}
								{!running && quickActionContent ? (
									<MessageQuickActions kind={assistantAs ? "worker" : "manager"} content={quickActionContent} workerLabel={assistantAs ? assistantLabel : undefined} />
								) : null}
							</div>
						</div>
					</div>
				);
			})}
		</>
	);
}

/** groupForRender 分组的 assistant 段集合，渲染入口与 Message 对齐（RoomFileContext）。 */
export function AssistantGroup({ roomId, sessionId, ...props }: {
	roomId: string;
	sessionId?: string;
	messages: ChatMessage[];
	windowType?: WindowType;
	onOpenWindow?: (windowId: string) => void;
	assistantAs?: string;
}) {
	return (
		<RoomFileContext.Provider value={{ roomId, sessionId }}>
			<AssistantGroupBody {...props} />
		</RoomFileContext.Provider>
	);
}
