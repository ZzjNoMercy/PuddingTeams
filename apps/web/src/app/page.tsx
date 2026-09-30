"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRightIcon, BookOpenIcon, BrainCircuitIcon, CalendarDaysIcon, ChevronDownIcon, ClockIcon, FolderGit2Icon, GitBranchIcon, Layers3Icon, PaperclipIcon, SendIcon, SparklesIcon, XIcon } from "lucide-react";
import { ChatPane } from "@/components/chat/chat-pane";
import { NavRail } from "@/components/chat/nav-rail";
import { QueryRouteObserver } from "@/components/chat/query-route-observer";
import { DesktopTitlebar } from "@/components/desktop-titlebar";
import { SectionSidebarToggle } from "@/components/section-topbar";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ManagerWorkSubmissionError, createManagerWork, getKnowledgeSelection, getManagerSessionLocation, getRoom, getViewerIdentity, listKnowledgeBindings, listRooms, listSessionCommands, setActiveRoomSession, switchRoomWorkspace, updateKnowledgeSelection, type KnowledgeBindingSummary, type KnowledgeSelectionSummary, type SessionSlashCommand } from "@/lib/api";
import { useModelCatalog } from "@/lib/model-catalog";
import { LatestSerialQueue } from "@/lib/latest-serial-queue";
import { clearManagerWorkDraft, loadManagerWorkDraft, managerWorkStorage, managerWorkSubmissionDecision, pendingManagerWorkMatches, saveManagerWorkDraft, type ManagerWorkPendingSubmission } from "@/lib/manager-work-draft";
import { clearPendingManagerWorkAttachments, clearSubmittedManagerWorkAttachments, encodeManagerWorkAttachment, fingerprintManagerWorkAttachments, loadManagerWorkAttachments, loadPendingManagerWorkAttachments, sameManagerWorkAttachments, saveManagerWorkAttachments, savePendingManagerWorkAttachments, validateManagerWorkAttachments } from "@/lib/manager-work-attachments";
import { sessionTitle } from "@/lib/global-search-results";
import { compactTime } from "@/lib/time";
import type { RoomSummary } from "@/lib/types";

function contextKeyForRoom(room: RoomSummary | null): string {
	return JSON.stringify([room?.id, room?.workspace?.id ?? null, room?.cwdSnapshot]);
}

/**
 * Radix 的下拉关闭时会把焦点还给 trigger，鼠标点完走开之后触发器仍挂着焦点环，
 * 看着像"还选着"。这里区分指针与键盘：指针关闭后主动 blur，键盘关闭保留焦点（无障碍要求）。
 */
function useDropdownTriggerBlur() {
	const triggerRef = useRef<HTMLButtonElement>(null);
	const interactionRef = useRef<"pointer" | "keyboard" | null>(null);
	return {
		triggerRef,
		triggerInteractionProps: {
			onPointerDown: () => { interactionRef.current = "pointer" as const; },
			onKeyDown: () => { interactionRef.current = "keyboard" as const; },
		},
		onCloseAutoFocus: (event: Event) => {
			if (interactionRef.current === "pointer") {
				event.preventDefault();
				triggerRef.current?.blur();
			}
			interactionRef.current = null;
		},
	};
}

const QUICK_STARTS = [
	{ label: "安排今天", icon: CalendarDaysIcon, prompt: "请根据我接下来提供的日程和待办，帮我安排今天：" },
	{ label: "整理研究笔记", icon: BookOpenIcon, prompt: "请整理我接下来提供的研究笔记，提炼结论与待验证问题：" },
	{ label: "推进项目", icon: GitBranchIcon, prompt: "请帮我推进当前项目，先确认目标、约束和下一步：" },
	{ label: "生成周复盘", icon: ClockIcon, prompt: "请根据我接下来提供的本周工作记录，生成周复盘：" },
] as const;

function NewWorkModelPicker({ value, disabled, onChange }: { value: string; disabled: boolean; onChange: (modelRef: string) => void }) {
	const { models, modelsError, reload } = useModelCatalog();
	const selectedName = value ? models?.find((model) => model.id === value)?.name : undefined;
	const label = !value ? "默认模型" : selectedName ?? (models === null ? "正在读取模型…" : value);
	const { triggerRef, triggerInteractionProps, onCloseAutoFocus } = useDropdownTriggerBlur();
	return <DropdownMenu onOpenChange={(open) => { if (open && modelsError) reload(); }}><DropdownMenuTrigger asChild><button ref={triggerRef} {...triggerInteractionProps} type="button" className="m1-workbench-model" disabled={disabled} aria-label={`首发模型：${label}`}><span>{label}</span><ChevronDownIcon size={13} /></button></DropdownMenuTrigger><DropdownMenuContent align="end" className="m1-workbench-model-menu" onCloseAutoFocus={onCloseAutoFocus}><DropdownMenuItem onSelect={() => onChange("")}>默认模型</DropdownMenuItem>{models === null ? <DropdownMenuItem disabled>正在读取模型…</DropdownMenuItem> : modelsError ? <DropdownMenuItem disabled>模型列表不可用，重新打开重试</DropdownMenuItem> : models.map((model) => <DropdownMenuItem key={model.id} onSelect={() => onChange(model.id)}><span className="m1-workbench-model-item"><strong>{model.name}</strong><small>{model.id}</small></span></DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>;
}

/** 新工作思考强度（§10.6）：只作用于将要创建的 Session，非推理模型不显示。档位与其它选择器同源。 */
function NewWorkThinkingPicker({ modelRef, value, disabled, onChange }: { modelRef: string; value: string; disabled: boolean; onChange: (level: string) => void }) {
	const { find, levelsFor, gradedFor } = useModelCatalog();
	const { triggerRef, triggerInteractionProps, onCloseAutoFocus } = useDropdownTriggerBlur();
	const currentModel = find(modelRef);
	if (currentModel && currentModel.reasoning === false) return null;
	const levels = levelsFor(modelRef);
	const graded = gradedFor(modelRef);
	return <DropdownMenu><DropdownMenuTrigger asChild><button ref={triggerRef} {...triggerInteractionProps} type="button" className="m1-workbench-thinking" disabled={disabled} aria-label={`思考强度：${value || "跟随默认"}`} title={`思考强度（仅本次新工作）：${value || "跟随默认"}。档位为 pi 原生枚举，各 provider 的实际强度语义以服务商文档为准。${graded ? "" : "该模型只支持思考开/关，档位不改变实际推理量。"}`}><BrainCircuitIcon size={14} /><span>{value || "默认强度"}</span><ChevronDownIcon size={13} /></button></DropdownMenuTrigger><DropdownMenuContent align="end" className="m1-workbench-thinking-menu" onCloseAutoFocus={onCloseAutoFocus}><DropdownMenuItem onSelect={() => onChange("")}>默认强度</DropdownMenuItem>{levels.map((level) => <DropdownMenuItem key={level} onSelect={() => onChange(level)}><span className="m1-workbench-model-item"><strong>{level}</strong></span></DropdownMenuItem>)}{graded ? null : <div className="thinking-picker-note">该模型只支持思考开/关，各档在链路上无差别。</div>}</DropdownMenuContent></DropdownMenu>;
}

function NewWorkKnowledgePicker({ bindings, selection, loading, saving, error, disabled, onToggle }: {
	bindings: KnowledgeBindingSummary[];
	selection: KnowledgeSelectionSummary | null;
	loading: boolean;
	saving: boolean;
	error: string | null;
	disabled: boolean;
	onToggle: (bindingId: string, selected: boolean) => void;
}) {
	const selected = new Set(selection?.selectedBindingIds ?? []);
	const label = loading ? "读取知识库…" : selected.size > 0 ? `${selected.size} 个知识库` : "选择知识库";
	const { triggerRef, triggerInteractionProps, onCloseAutoFocus } = useDropdownTriggerBlur();
	return <DropdownMenu><DropdownMenuTrigger asChild><button ref={triggerRef} {...triggerInteractionProps} type="button" className="m1-workbench-knowledge" disabled={disabled || loading || saving} aria-label={`工作知识库：${label}`}><Layers3Icon size={15} /><span>{label}</span><ChevronDownIcon size={13} /></button></DropdownMenuTrigger><DropdownMenuContent align="start" className="m1-workbench-knowledge-menu" onCloseAutoFocus={onCloseAutoFocus}>{error ? <DropdownMenuItem disabled>{error}</DropdownMenuItem> : bindings.length === 0 ? <DropdownMenuItem disabled>还没有已接入的知识库</DropdownMenuItem> : bindings.map((binding) => <DropdownMenuCheckboxItem key={binding.id} checked={selected.has(binding.id)} disabled={binding.availability !== "available" || saving} onSelect={(event) => event.preventDefault()} onCheckedChange={(checked) => onToggle(binding.id, checked === true)}><span className="m1-workbench-knowledge-item"><strong>{binding.name}</strong>{binding.description ? <small>{binding.description}</small> : null}</span></DropdownMenuCheckboxItem>)}</DropdownMenuContent></DropdownMenu>;
}

/** M1 workbench: the existing solo Manager is the only live data source here. */
export default function WorkbenchPage() {
	const router = useRouter();
	const [manager, setManager] = useState<RoomSummary | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [managerListReady, setManagerListReady] = useState(false);
	const [draftKey, setDraftKey] = useState<string | null>(null);
	const [draftContextKey, setDraftContextKey] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [modelRef, setModelRef] = useState("");
	const [thinkingLevel, setThinkingLevel] = useState("");
	const [workAttachments, setWorkAttachments] = useState<File[]>([]);
	const [workAttachmentFingerprints, setWorkAttachmentFingerprints] = useState<{ files: File[]; values: string[] } | null>(null);
	const attachmentFingerprintSequence = useRef(0);
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	const attachmentInput = useRef<HTMLInputElement>(null);
	const newWorkInput = useRef<HTMLTextAreaElement>(null);
	const { triggerRef: skillTriggerRef, triggerInteractionProps: skillTriggerInteractionProps, onCloseAutoFocus: blurSkillTriggerOnClose } = useDropdownTriggerBlur();
	const [draftIdentityError, setDraftIdentityError] = useState<{ contextKey: string; message: string } | null>(null);
	const [draftIdentityRetry, setDraftIdentityRetry] = useState(0);
	const [viewerIdentity, setViewerIdentity] = useState<{ contextKey: string; name: string } | null>(null);
	const [localNow, setLocalNow] = useState<Date | null>(null);
	const operationIdRef = useRef("");
	const draftVersionRef = useRef(0);
	const pendingWorkRef = useRef<ManagerWorkPendingSubmission | null>(null);
	const pendingFilesRef = useRef<{ operationId: string; files: File[] } | null>(null);
	const [pendingFiles, setPendingFiles] = useState<{ operationId: string; files: File[] } | null>(null);
	const [pendingWork, setPendingWork] = useState<ManagerWorkPendingSubmission | null>(null);
	const [pendingReviewed, setPendingReviewed] = useState(false);
	const [sending, setSending] = useState(false);
	const sendingRef = useRef(false);
	const submissionRef = useRef<{ contextKey: string; content: string; modelRef: string; thinkingLevel: string; attachments: File[]; state: "pending" | "confirmed" } | null>(null);
	const [sendError, setSendError] = useState<{ contextKey: string; message: string } | null>(null);
	const [failedWorkSessionId, setFailedWorkSessionId] = useState<string | null>(null);
	const [staleWorkOperation, setStaleWorkOperation] = useState(false);
	// The static HTML and first client render must agree; QueryRouteObserver
	// applies the URL after hydration, including a direct ?session= entry.
	const [requestedSessionId, setRequestedSessionId] = useState<string | null>(null);
	const [locatedSessionId, setLocatedSessionId] = useState<string | null>(null);
	const requestedSessionRef = useRef(requestedSessionId);
	const locatedSessionRef = useRef(locatedSessionId);
	useEffect(() => { requestedSessionRef.current = requestedSessionId; }, [requestedSessionId]);
	useEffect(() => { locatedSessionRef.current = locatedSessionId; }, [locatedSessionId]);
	const routeQuery = useRef("");
	const [selectionNonce, setSelectionNonce] = useState(0);
	const [workspacePickerFromHome, setWorkspacePickerFromHome] = useState(false);
	const [skillMenu, setSkillMenu] = useState<{ contextKey: string; sessionId: string; status: "loading" | "ready" | "error"; commands: SessionSlashCommand[]; message?: string } | null>(null);
	const [knowledgePicker, setKnowledgePicker] = useState<{ contextKey: string; status: "loading" | "ready" | "saving" | "error"; bindings: KnowledgeBindingSummary[]; selection: KnowledgeSelectionSummary | null; error?: string } | null>(null);
	const skillMenuSequence = useRef(0);
	const [linkError, setLinkError] = useState<string | null>(null);
	const locationQueue = useRef(new LatestSerialQueue());
	const refreshSequence = useRef(0);
	const locatingHistory = useRef(false);
	const managerId = manager?.id;
	const workspaceId = manager?.workspace?.id;
	const cwdSnapshot = manager?.cwdSnapshot;
	const currentContextKey = JSON.stringify([managerId, workspaceId ?? null, cwdSnapshot]);
	const visibleSendError = sendError?.contextKey === currentContextKey ? sendError.message : null;
	const visibleDraftIdentityError = draftIdentityError?.contextKey === currentContextKey ? draftIdentityError.message : null;
	const viewerName = viewerIdentity?.contextKey === currentContextKey ? viewerIdentity.name : null;
	useEffect(() => {
		const initial = setTimeout(() => setLocalNow(new Date()), 0);
		const updateClock = () => setLocalNow(new Date());
		const timer = setInterval(updateClock, 60_000);
		return () => { clearTimeout(initial); clearInterval(timer); };
	}, []);
	const currentContextRef = useRef(currentContextKey);
	useEffect(() => { currentContextRef.current = currentContextKey; }, [currentContextKey]);
	const draftReady = Boolean(draftKey && draftContextKey === currentContextKey);
	useEffect(() => {
		if (!managerId || !cwdSnapshot) return;
		const contextKey = currentContextKey;
		let cancelled = false;
		void Promise.all([listKnowledgeBindings(), getKnowledgeSelection(contextKey)]).then(([bindings, selection]) => {
			if (!cancelled && currentContextRef.current === contextKey) setKnowledgePicker({ contextKey, status: "ready", bindings, selection });
		}).catch((error: unknown) => {
			if (!cancelled && currentContextRef.current === contextKey) setKnowledgePicker({ contextKey, status: "error", bindings: [], selection: null, error: error instanceof Error ? error.message : String(error) });
		});
		return () => { cancelled = true; };
	}, [managerId, cwdSnapshot, currentContextKey]);
	const toggleKnowledgeBinding = (bindingId: string, selected: boolean) => {
		const current = knowledgePicker;
		if (!current?.selection || current.contextKey !== currentContextKey || current.status === "saving") return;
		const nextIds = selected
			? [...new Set([...current.selection.selectedBindingIds, bindingId])]
			: current.selection.selectedBindingIds.filter((id) => id !== bindingId);
		setKnowledgePicker({ ...current, status: "saving", selection: { ...current.selection, selectedBindingIds: nextIds } });
		void updateKnowledgeSelection(current.selection, nextIds).then((selection) => {
			if (currentContextRef.current === current.contextKey) setKnowledgePicker({ ...current, status: "ready", selection });
		}).catch((error: unknown) => {
			if (currentContextRef.current === current.contextKey) setKnowledgePicker({ ...current, status: "error", error: error instanceof Error ? error.message : String(error) });
		});
	};
	useEffect(() => {
		const sequence = ++attachmentFingerprintSequence.current;
		void fingerprintManagerWorkAttachments(workAttachments).then((fingerprints) => {
			if (attachmentFingerprintSequence.current === sequence) setWorkAttachmentFingerprints({ files: workAttachments, values: fingerprints });
		}).catch(() => undefined);
		return () => { attachmentFingerprintSequence.current += 1; };
	}, [workAttachments]);
	const openSkillMenu = (open: boolean) => {
		if (!open || !manager?.activeSession) return;
		const contextKey = currentContextKey;
		const sessionId = manager.activeSession;
		const sequence = ++skillMenuSequence.current;
		setSkillMenu({ contextKey, sessionId, status: "loading", commands: [] });
		void listSessionCommands(sessionId)
			.then((commands) => { if (currentContextRef.current === contextKey && skillMenuSequence.current === sequence) setSkillMenu({ contextKey, sessionId, status: "ready", commands }); })
			.catch((error: unknown) => { if (currentContextRef.current === contextKey && skillMenuSequence.current === sequence) setSkillMenu({ contextKey, sessionId, status: "error", commands: [], message: error instanceof Error ? error.message : String(error) }); });
	};
	const refresh = useCallback(async () => {
		const sequence = ++refreshSequence.current;
		try {
			const rooms = await listRooms();
			if (sequence !== refreshSequence.current || locatingHistory.current) return;
			const nextManager = rooms.find((room) => room.type === "solo") ?? null;
			const expectedSession = requestedSessionRef.current;
			if (expectedSession && locatedSessionRef.current === expectedSession && nextManager &&
				(nextManager.activeSession !== expectedSession || !nextManager.sessions.some((session) => session.id === expectedSession))) {
				locationQueue.current.invalidate();
				locatedSessionRef.current = null;
				setLocatedSessionId(null);
				setLinkError("当前项目或会话已在其他窗口改变，请重试定位");
			}
			currentContextRef.current = contextKeyForRoom(nextManager);
			setManager(nextManager);
			setManagerListReady(true);
			setLoadError(null);
		} catch (error) {
			if (sequence !== refreshSequence.current || locatingHistory.current) return;
			setLoadError(error instanceof Error ? error.message : String(error));
		}
	}, []);
	useEffect(() => {
			const initial = setTimeout(() => void refresh(), 0);
			const timer = setInterval(() => void refresh(), 8000);
			return () => { clearTimeout(initial); clearInterval(timer); refreshSequence.current += 1; };
	}, [refresh]);
	const onRouteChange = useCallback((query: string) => {
		if (routeQuery.current === query) return;
		routeQuery.current = query;
		locationQueue.current.invalidate();
		requestedSessionRef.current = new URLSearchParams(query).get("session");
		locatedSessionRef.current = null;
		setLocatedSessionId(null);
		setRequestedSessionId(requestedSessionRef.current);
		setSelectionNonce((value) => value + 1);
		setLinkError(null);
	}, []);
	useEffect(() => {
		if (!managerId || !cwdSnapshot) return;
		let cancelled = false;
		void getViewerIdentity().then((identity) => {
			if (cancelled) return;
			setViewerIdentity({ contextKey: JSON.stringify([managerId, workspaceId ?? null, cwdSnapshot]), name: identity.user.displayName.trim() || identity.user.username.trim() });
			setDraftIdentityError(null);
			setSendError(null);
			setFailedWorkSessionId(null);
			setStaleWorkOperation(false);
			const key = `puddingteams:new-work:v1:${JSON.stringify([identity.tenant.id, identity.user.id, managerId, workspaceId ?? null, cwdSnapshot])}`;
			setDraftKey(key);
			setDraftContextKey(JSON.stringify([managerId, workspaceId ?? null, cwdSnapshot]));
			const saved = loadManagerWorkDraft(key, managerWorkStorage);
			draftVersionRef.current += 1;
			const restoredAttachments = loadManagerWorkAttachments(key);
			const filesLost = (saved.attachmentCount ?? 0) !== restoredAttachments.length;
			setDraft(saved.content);
			setModelRef(saved.modelRef ?? "");
			setThinkingLevel(saved.thinkingLevel ?? "");
			setWorkAttachments(restoredAttachments);
			setAttachmentError(filesLost ? "刷新后附件需要重新选择；原发送结果仍需核对" : null);
			const pending = saved.pendingSubmission ?? (saved.operationId ? { operationId: saved.operationId, content: saved.content.trim(), modelRef: saved.modelRef ?? "", thinkingLevel: saved.thinkingLevel ?? "", attachmentCount: saved.attachmentCount ?? 0 } : null);
			pendingWorkRef.current = pending;
			const originalPendingFiles = pending ? loadPendingManagerWorkAttachments(key, pending.operationId) : null;
			const restoredPendingFiles = pending && (pending.attachmentCount === 0 || originalPendingFiles?.length === pending.attachmentCount)
				? { operationId: pending.operationId, files: originalPendingFiles ?? [] } : null;
			pendingFilesRef.current = restoredPendingFiles;
			setPendingFiles(restoredPendingFiles);
			setPendingWork(pending);
			setPendingReviewed(false);
			operationIdRef.current = filesLost ? "" : saved.operationId;
			if (filesLost) saveManagerWorkDraft(key, { ...saved, attachmentCount: restoredAttachments.length, operationId: "", ...(pending ? { pendingSubmission: pending } : {}) }, managerWorkStorage);
		}).catch((error: unknown) => {
			if (!cancelled) {
				setViewerIdentity(null);
				setDraftIdentityError({ contextKey: JSON.stringify([managerId, workspaceId ?? null, cwdSnapshot]), message: error instanceof Error ? error.message : String(error) });
			}
		});
		return () => { cancelled = true; };
	}, [managerId, workspaceId, cwdSnapshot, draftIdentityRetry]);
	const updateDraft = (content: string) => {
		draftVersionRef.current += 1;
		submissionRef.current = null;
		setDraft(content);
		operationIdRef.current = "";
		setPendingReviewed(false);
		setSendError(null);
		setFailedWorkSessionId(null);
		if (!pendingWorkRef.current) setStaleWorkOperation(false);
		if (draftKey) {
			saveManagerWorkDraft(draftKey, { content, operationId: "", modelRef, thinkingLevel, attachmentCount: workAttachments.length, ...(pendingWorkRef.current ? { pendingSubmission: pendingWorkRef.current } : {}) }, managerWorkStorage);
		}
	};
	const updateModelRef = (nextModelRef: string) => {
		if (!draftReady || nextModelRef === modelRef) return;
		draftVersionRef.current += 1;
		submissionRef.current = null;
		setModelRef(nextModelRef);
		operationIdRef.current = "";
		setPendingReviewed(false);
		setSendError(null);
		setFailedWorkSessionId(null);
		if (!pendingWorkRef.current) setStaleWorkOperation(false);
		if (draftKey) saveManagerWorkDraft(draftKey, { content: draft, operationId: "", modelRef: nextModelRef, thinkingLevel, attachmentCount: workAttachments.length, ...(pendingWorkRef.current ? { pendingSubmission: pendingWorkRef.current } : {}) }, managerWorkStorage);
	};
	/** 思考强度与模型同为预约身份的一部分（§10.6）：改档位同样作废当前操作键。 */
	const updateThinkingLevel = (nextLevel: string) => {
		if (!draftReady || nextLevel === thinkingLevel) return;
		draftVersionRef.current += 1;
		submissionRef.current = null;
		setThinkingLevel(nextLevel);
		operationIdRef.current = "";
		setPendingReviewed(false);
		setSendError(null);
		setFailedWorkSessionId(null);
		if (!pendingWorkRef.current) setStaleWorkOperation(false);
		if (draftKey) saveManagerWorkDraft(draftKey, { content: draft, operationId: "", modelRef, thinkingLevel: nextLevel, attachmentCount: workAttachments.length, ...(pendingWorkRef.current ? { pendingSubmission: pendingWorkRef.current } : {}) }, managerWorkStorage);
	};
	const updateAttachments = (files: File[]) => {
		if (!draftReady) return;
		const validationError = validateManagerWorkAttachments(files);
		if (validationError) { setAttachmentError(validationError); return; }
		draftVersionRef.current += 1;
		submissionRef.current = null;
		setWorkAttachments(files);
		setAttachmentError(null);
		operationIdRef.current = "";
		setPendingReviewed(false);
		setSendError(null);
		setFailedWorkSessionId(null);
		if (!pendingWorkRef.current) setStaleWorkOperation(false);
		if (draftKey) {
			saveManagerWorkAttachments(draftKey, files);
			saveManagerWorkDraft(draftKey, { content: draft, operationId: "", modelRef, thinkingLevel, attachmentCount: files.length, ...(pendingWorkRef.current ? { pendingSubmission: pendingWorkRef.current } : {}) }, managerWorkStorage);
		}
	};
	const submitNewWork = async (forceNewKey = false) => {
		if (!manager || !draftReady || !draft.trim() || attachmentError || sendingRef.current || currentContextRef.current !== currentContextKey) return;
		sendingRef.current = true;
		setSending(true);
		const submittedDraftVersion = draftVersionRef.current;
		let attachmentFingerprints: string[];
		try { attachmentFingerprints = await fingerprintManagerWorkAttachments(workAttachments); }
		catch (error) {
			sendingRef.current = false;
			setSending(false);
			setAttachmentError(error instanceof Error ? `无法读取附件：${error.message}` : "无法读取附件，请重新选择");
			return;
		}
		if (currentContextRef.current !== currentContextKey || draftVersionRef.current !== submittedDraftVersion) { sendingRef.current = false; setSending(false); return; }
		const previousPending = pendingWorkRef.current;
		const previousPendingFiles = pendingFilesRef.current;
		const sameAttachments = !previousPending?.attachmentCount || sameManagerWorkAttachments(attachmentFingerprints, previousPending.attachmentFingerprints) || (previousPendingFiles?.operationId === previousPending.operationId &&
			previousPendingFiles.files.length === workAttachments.length && previousPendingFiles.files.every((file, index) => file === workAttachments[index]));
		const decision = managerWorkSubmissionDecision({ content: draft, modelRef, thinkingLevel, attachmentCount: workAttachments.length }, previousPending, { forceNewKey, historyReviewed: pendingReviewed, originalDeleted: staleWorkOperation, sameAttachments });
		if (decision === "review_required") {
			sendingRef.current = false;
			setSending(false);
			setSendError({ contextKey: currentContextKey, message: pendingReviewed ? "原工作结果仍未确认；如需另发，请点击下方明确发起新工作" : "请先刷新并核对当前项目的工作记录" });
			return;
		}
		if (submissionRef.current?.state === "pending") { sendingRef.current = false; setSending(false); return; }
		if (submissionRef.current?.state === "confirmed" && submissionRef.current.contextKey === currentContextKey && submissionRef.current.content === draft && submissionRef.current.modelRef === modelRef && submissionRef.current.thinkingLevel === thinkingLevel && submissionRef.current.attachments.length === workAttachments.length && submissionRef.current.attachments.every((file, index) => file === workAttachments[index])) { sendingRef.current = false; setSending(false); return; }
		const submittedContextKey = currentContextKey;
		const submittedDraftKey = draftKey;
		const key = decision === "retry" ? previousPending!.operationId : crypto.randomUUID();
		const pendingSubmission = { operationId: key, content: draft.trim(), modelRef, thinkingLevel, attachmentCount: workAttachments.length, attachmentFingerprints };
		const submission = { contextKey: currentContextKey, content: draft, modelRef, thinkingLevel, attachments: [...workAttachments], state: "pending" as const };
		submissionRef.current = submission;
		operationIdRef.current = key;
		pendingWorkRef.current = pendingSubmission;
		pendingFilesRef.current = { operationId: key, files: submission.attachments };
		if (submittedDraftKey) savePendingManagerWorkAttachments(submittedDraftKey, key, submission.attachments);
		setPendingFiles({ operationId: key, files: submission.attachments });
		setPendingWork(pendingSubmission);
		setPendingReviewed(false);
		if (draftKey) {
			saveManagerWorkDraft(draftKey, { content: draft, operationId: key, modelRef, thinkingLevel, attachmentCount: submission.attachments.length, pendingSubmission }, managerWorkStorage);
		}
		setSendError(null);
		setFailedWorkSessionId(null);
		setStaleWorkOperation(false);
		let requestStarted = false;
		try {
			const encodedAttachments = await Promise.all(submission.attachments.map(encodeManagerWorkAttachment));
			requestStarted = true;
			const sessionId = await createManagerWork(manager.id, draft, key, { workspaceId: manager.workspace?.id ?? null, cwdSnapshot: manager.cwdSnapshot }, modelRef || undefined, encodedAttachments, thinkingLevel || undefined);
			const stillCurrentSubmission = submissionRef.current === submission;
			if (stillCurrentSubmission) submissionRef.current = { ...submission, state: "confirmed" };
			if (submittedDraftKey) {
				const cleared = clearManagerWorkDraft(submittedDraftKey, managerWorkStorage, { content: submission.content, operationId: key, modelRef: submission.modelRef, thinkingLevel: submission.thinkingLevel, attachmentCount: submission.attachments.length, pendingSubmission });
				if (!cleared) {
					const currentDraft = loadManagerWorkDraft(submittedDraftKey, managerWorkStorage);
					if (currentDraft.pendingSubmission?.operationId === key) saveManagerWorkDraft(submittedDraftKey, { ...currentDraft, operationId: "", pendingSubmission: undefined }, managerWorkStorage);
				}
				clearSubmittedManagerWorkAttachments(submittedDraftKey, submission.attachments);
				clearPendingManagerWorkAttachments(submittedDraftKey, key);
			}
			if (currentContextRef.current === submittedContextKey && pendingWorkRef.current?.operationId === key) {
				pendingWorkRef.current = null;
				if (pendingFilesRef.current?.operationId === key) { pendingFilesRef.current = null; setPendingFiles(null); }
				setPendingWork(null);
				setPendingReviewed(false);
				operationIdRef.current = "";
			}
			if (!stillCurrentSubmission || currentContextRef.current !== submittedContextKey) return;
			locationQueue.current.invalidate();
			requestedSessionRef.current = sessionId;
			locatedSessionRef.current = null;
			setLocatedSessionId(null);
			setRequestedSessionId(sessionId);
			setSelectionNonce((value) => value + 1);
			setLinkError(null);
			routeQuery.current = `session=${encodeURIComponent(sessionId)}`;
			router.push(`/?session=${encodeURIComponent(sessionId)}`);
			setDraft("");
			setModelRef("");
			setWorkAttachments([]);
			operationIdRef.current = "";
			pendingWorkRef.current = null;
			setPendingWork(null);
			setPendingReviewed(false);
			void refresh();
		} catch (error) {
			if (submissionRef.current === submission) submissionRef.current = null;
			if (!requestStarted && submittedDraftKey && decision !== "retry") {
				clearPendingManagerWorkAttachments(submittedDraftKey, key);
				if (previousPending && previousPendingFiles?.operationId === previousPending.operationId) savePendingManagerWorkAttachments(submittedDraftKey, previousPending.operationId, previousPendingFiles.files);
				const currentDraft = loadManagerWorkDraft(submittedDraftKey, managerWorkStorage);
				if (currentDraft.pendingSubmission?.operationId === key) saveManagerWorkDraft(submittedDraftKey, { ...currentDraft, operationId: "", pendingSubmission: previousPending ?? undefined }, managerWorkStorage);
				if (currentContextRef.current === submittedContextKey && pendingWorkRef.current?.operationId === key) {
					pendingWorkRef.current = previousPending;
					pendingFilesRef.current = previousPendingFiles;
					setPendingFiles(previousPendingFiles);
					setPendingWork(previousPending);
					operationIdRef.current = "";
				}
			}
			if (currentContextRef.current !== submittedContextKey) return;
			setSendError({
				contextKey: submittedContextKey,
				message: requestStarted && error instanceof TypeError
					? "连接中断，发送结果尚未确认；请刷新并核对工作记录，或按原请求重试"
					: error instanceof Error ? error.message : String(error),
			});
			if (error instanceof ManagerWorkSubmissionError) {
				if (error.code === "session_creation_deleted") setStaleWorkOperation(true);
				else setFailedWorkSessionId(error.sessionId);
			}
		} finally { sendingRef.current = false; setSending(false); }
	};
	const selectHistorySession = (sessionId: string) => {
		locationQueue.current.invalidate();
		requestedSessionRef.current = sessionId;
		locatedSessionRef.current = null;
		setLocatedSessionId(null);
		setRequestedSessionId(sessionId);
		setSelectionNonce((value) => value + 1);
		setLinkError(null);
		routeQuery.current = `session=${encodeURIComponent(sessionId)}`;
		router.push(`/?session=${encodeURIComponent(sessionId)}`);
	};
	const targetSessionId = requestedSessionId && locatedSessionId === requestedSessionId && manager?.activeSession === requestedSessionId && manager.sessions.some((session) => session.id === requestedSessionId) ? requestedSessionId : null;
	useEffect(() => {
		if (!managerId) return;
		if (!requestedSessionId) {
			void locationQueue.current.enqueue((isCurrent) => {
				if (!isCurrent()) return;
				locatingHistory.current = false;
				void refresh();
			});
			return;
		}
		let cancelled = false;
		locatingHistory.current = true;
		refreshSequence.current += 1;
		void locationQueue.current.enqueue(async (isLatest) => {
			const current = () => !cancelled && isLatest();
			if (!current()) return;
			try {
				const location = await getManagerSessionLocation(managerId, requestedSessionId);
				if (!current()) return;
				if (!location.active) await switchRoomWorkspace(managerId, location.workspaceId, "in_place");
				if (!current()) return;
				await setActiveRoomSession(managerId, requestedSessionId);
				if (!current()) return;
				const updated = await getRoom(managerId);
				if (updated.activeSession !== requestedSessionId || !updated.sessions.some((session) => session.id === requestedSessionId)) throw new Error("目标 Session 未恢复到当前项目");
				if (current()) { refreshSequence.current += 1; currentContextRef.current = contextKeyForRoom(updated); setManager(updated); locatedSessionRef.current = requestedSessionId; setLocatedSessionId(requestedSessionId); setLinkError(null); }
			} catch (error) {
				if (current()) setLinkError(error instanceof Error ? error.message : String(error));
			} finally {
				if (current()) { locatingHistory.current = false; void refresh(); }
			}
		});
		return () => { cancelled = true; };
	}, [managerId, requestedSessionId, selectionNonce, refresh]);
	const handleManagerUpdated = useCallback((updated: RoomSummary) => {
		if (locatingHistory.current) return;
		refreshSequence.current += 1;
		currentContextRef.current = contextKeyForRoom(updated);
		if (targetSessionId && requestedSessionId && (updated.activeSession !== requestedSessionId || !updated.sessions.some((session) => session.id === requestedSessionId))) {
			locationQueue.current.invalidate();
			locatedSessionRef.current = null;
			setLocatedSessionId(null);
			setLinkError("当前项目或会话已在其他窗口改变，请重试定位");
		}
		setManager(updated);
	}, [requestedSessionId, targetSessionId]);
	const handleManagerContextActivated = useCallback((updated: RoomSummary) => {
		const sessionId = updated.activeSession;
		locationQueue.current.invalidate();
		refreshSequence.current += 1;
		currentContextRef.current = contextKeyForRoom(updated);
		setManager(updated);
		requestedSessionRef.current = sessionId;
		locatedSessionRef.current = sessionId;
		setRequestedSessionId(sessionId);
		setLocatedSessionId(sessionId);
		setSelectionNonce((value) => value + 1);
		setLinkError(null);
		const href = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/";
		routeQuery.current = href.split("?")[1] ?? "";
		router.push(href);
	}, [router]);
	const locatingSession = Boolean(requestedSessionId && !targetSessionId && !linkError);
	const historySessions = manager?.sessions.filter((session) => sessionTitle(undefined, session.firstMessage) !== null) ?? [];
	const pendingFilesMatch = !pendingWork?.attachmentCount || (workAttachmentFingerprints?.files === workAttachments && sameManagerWorkAttachments(workAttachmentFingerprints.values, pendingWork.attachmentFingerprints)) || (pendingFiles?.operationId === pendingWork.operationId &&
		pendingFiles.files.length === workAttachments.length && pendingFiles.files.every((file, index) => file === workAttachments[index]));
	const pendingMismatch = pendingWork ? !pendingFilesMatch || !pendingManagerWorkMatches({ content: draft, modelRef, thinkingLevel, attachmentCount: workAttachments.length }, pendingWork) : false;
	const pendingNeedsChoice = Boolean(pendingWork && (pendingMismatch || staleWorkOperation || visibleSendError));
	const reviewPendingWork = async () => {
		if (!manager || !pendingWork) return;
		const context = currentContextKey;
		try {
			const updated = await getRoom(manager.id);
			if (currentContextRef.current !== context || contextKeyForRoom(updated) !== context) throw new Error("当前项目已变化，请重新打开工作台后核对");
			setManager(updated);
			setPendingReviewed(true);
			setSendError({ contextKey: context, message: "工作记录已刷新；请核对原工作是否出现，再决定是否作为新工作发送" });
		} catch (error) {
			setPendingReviewed(false);
			setSendError({ contextKey: context, message: error instanceof Error ? error.message : String(error) });
		}
	};
	const today = localNow ? `${localNow.getFullYear()} 年 ${localNow.getMonth() + 1} 月 ${localNow.getDate()} 日 · ${new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(localNow)}` : "工作台";
	const greeting = !localNow ? "你好" : localNow.getHours() < 12 ? "早上好" : localNow.getHours() < 18 ? "下午好" : "晚上好";
	const showConversation = Boolean(requestedSessionId);
	const returnToWorkbench = () => {
		locationQueue.current.invalidate();
		requestedSessionRef.current = null;
		locatedSessionRef.current = null;
		setRequestedSessionId(null);
		setLocatedSessionId(null);
		setWorkspacePickerFromHome(false);
		setLinkError(null);
		routeQuery.current = "";
		router.push("/");
	};

	return (
		<div className="home-shell desktop-app-frame m1-app-shell h-dvh m1-workbench-shell">
			<Suspense fallback={null}><QueryRouteObserver onChange={onRouteChange} /></Suspense>
			<DesktopTitlebar />
			<div className="desktop-app-body">
				<div className="desktop-sidebar-stack desktop-sidebar-nav-only" data-app-sidebar-shell><NavRail view="workbench" returnSessionId={requestedSessionId ? targetSessionId : manager?.activeSession} /></div>
				<main className="m1-workbench-main">
					<header className="m1-workbench-topbar">
						<div className="m1-workbench-location"><SectionSidebarToggle /><span>{showConversation ? <><button type="button" className="m1-workbench-back" onClick={returnToWorkbench}>工作台</button> <span aria-hidden="true">/</span> Manager 对话</> : <>工作台 <span aria-hidden="true">/</span> Manager</>}</span></div>
					</header>
					{!showConversation ? <div className="m1-workbench-scroll">
						<div className="m1-workbench-inner">
							<p className="m1-workbench-date"><span>{today}</span><span className="m1-workbench-motto">让想法，接着发生。</span></p>
							<div className="m1-workbench-hero">
								<span className="m1-workbench-label"><i /> MANAGER</span>
								<h1>{greeting}{viewerName ? `，${viewerName}` : ""}<span>今天想推进什么？</span></h1>
								<p>向 Manager 交代一件事，或继续之前的工作。</p>
							</div>
							<section className="m1-workbench-new-work" aria-label="发起新工作">
								<label htmlFor="m1-new-work">发起新工作</label>
								<textarea id="m1-new-work" ref={newWorkInput} value={draftReady ? draft : ""} onChange={(event) => updateDraft(event.target.value)} onKeyDown={(event) => {
									if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.repeat) return;
									event.preventDefault();
									void submitNewWork();
								}} placeholder="描述你想让 Manager 推进的工作…" rows={4} disabled={!manager || !draftReady || sending || locatingSession} />
								<input ref={attachmentInput} type="file" multiple className="m1-workbench-file-input" aria-label="选择新工作附件" onChange={(event) => { const selected = Array.from(event.target.files ?? []); if (selected.length) updateAttachments([...workAttachments, ...selected]); event.target.value = ""; }} />
								{draftReady && workAttachments.length > 0 ? <div className="m1-workbench-attachments" aria-label="待发送附件">{workAttachments.map((file, index) => <span key={`${file.name}:${file.size}:${index}`}><PaperclipIcon size={12} />{file.name}<button type="button" aria-label={`移除附件 ${file.name}`} disabled={sending} onClick={() => updateAttachments(workAttachments.filter((_, itemIndex) => itemIndex !== index))}><XIcon size={12} /></button></span>)}</div> : null}
								{attachmentError ? <span role="alert" className="m1-workbench-attachment-error">{attachmentError} <button type="button" onClick={() => updateAttachments([])}>清除附件选择</button></span> : null}
								<div className="m1-workbench-new-work-footer">
									<div className="m1-workbench-context">
										<button type="button" className="m1-workbench-attach" aria-label="添加新工作附件" title="最多 5 个，每个 8MB，总计 20MB" disabled={!manager || !draftReady || sending || locatingSession} onClick={() => attachmentInput.current?.click()}><PaperclipIcon size={14} /><span>附件</span></button>
										<NewWorkKnowledgePicker bindings={knowledgePicker?.contextKey === currentContextKey ? knowledgePicker.bindings.filter((binding) => binding.availability !== "revoked") : []} selection={knowledgePicker?.contextKey === currentContextKey ? knowledgePicker.selection : null} loading={!knowledgePicker || knowledgePicker.contextKey !== currentContextKey || knowledgePicker.status === "loading"} saving={knowledgePicker?.contextKey === currentContextKey && knowledgePicker.status === "saving"} error={knowledgePicker?.contextKey === currentContextKey && knowledgePicker.status === "error" ? knowledgePicker.error ?? "知识库列表不可用" : null} disabled={!manager || !draftReady || sending || locatingSession} onToggle={toggleKnowledgeBinding} />
									<button type="button" className="m1-workbench-workspace" aria-label={`选择工作项目，当前：${manager?.workspace?.name ?? "默认目录"}`} aria-haspopup="dialog" disabled={!manager || locatingSession} onClick={() => setWorkspacePickerFromHome(true)}><FolderGit2Icon size={15} /><span>{manager?.workspace?.name ?? "默认目录"}</span><ChevronDownIcon size={13} /></button>
									<DropdownMenu onOpenChange={openSkillMenu}><DropdownMenuTrigger asChild><button ref={skillTriggerRef} {...skillTriggerInteractionProps} type="button" className="m1-workbench-skill" disabled={!manager?.activeSession || !draftReady || sending || locatingSession} aria-label="选择已启用的 Skill"><SparklesIcon size={14} /><span>技能</span><ChevronDownIcon size={13} /></button></DropdownMenuTrigger><DropdownMenuContent align="start" className="m1-workbench-skill-menu" onCloseAutoFocus={blurSkillTriggerOnClose}>{skillMenu?.contextKey !== currentContextKey || skillMenu.sessionId !== manager?.activeSession || skillMenu.status === "loading" ? <DropdownMenuItem disabled>正在读取可用 Skill…</DropdownMenuItem> : skillMenu.status === "error" ? <DropdownMenuItem disabled>{skillMenu.message ?? "Skill 列表不可用"}</DropdownMenuItem> : skillMenu.commands.length === 0 ? <DropdownMenuItem disabled>当前项目没有可用 Skill</DropdownMenuItem> : skillMenu.commands.map((command) => <DropdownMenuItem key={command.name} onSelect={() => { if (currentContextRef.current !== currentContextKey || skillMenu.sessionId !== manager?.activeSession) return; updateDraft(`/${command.name} ${draft}`); newWorkInput.current?.focus(); }}><span className="m1-workbench-skill-item"><strong>/{command.name}</strong><small>{command.description || "显式调用这个 Skill"}</small></span></DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
									{visibleSendError || visibleDraftIdentityError ? <span role="alert">{visibleSendError ?? `无法加载草稿身份：${visibleDraftIdentityError}`}</span> : null}
								</div>
								<div className="m1-workbench-runtime">
									<NewWorkModelPicker value={draftReady ? modelRef : ""} disabled={!manager || !draftReady || sending || locatingSession} onChange={updateModelRef} />
									<NewWorkThinkingPicker modelRef={modelRef} value={draftReady ? thinkingLevel : ""} disabled={!manager || !draftReady || sending || locatingSession} onChange={updateThinkingLevel} />
									<button type="button" className="m1-workbench-send" aria-label={sending ? "发送中…" : "发送并开始"} title={sending ? "发送中…" : "发送并开始（Enter）"} aria-keyshortcuts="Enter" onClick={() => void submitNewWork()} disabled={!manager || !draftReady || !draft.trim() || Boolean(attachmentError) || sending || locatingSession}><SendIcon size={15} /></button>
								</div>
							</div>
								{visibleDraftIdentityError ? <button type="button" className="m1-workbench-reserved-link" onClick={() => { setDraftIdentityError(null); setDraftIdentityRetry((value) => value + 1); }}>重试加载草稿</button> : null}
								{failedWorkSessionId ? <button type="button" className="m1-workbench-reserved-link" onClick={() => selectHistorySession(failedWorkSessionId)}>查看已预约的工作</button> : null}
								{pendingNeedsChoice && draftReady ? <div className="m1-workbench-pending-actions"><span>原请求可能稍后完成；另发可能产生第二个工作。</span><button type="button" className="m1-workbench-reserved-link" disabled={sending || locatingSession} onClick={() => void reviewPendingWork()}>刷新并核对工作记录</button><button type="button" className="m1-workbench-reserved-link" disabled={!pendingReviewed || !manager || !draft.trim() || Boolean(attachmentError) || sending || locatingSession} onClick={() => void submitNewWork(true)}>核对后作为新工作发送</button></div> : null}
							</section>
							<div className="m1-workbench-quick-starts" aria-label="快捷起手式">{QUICK_STARTS.map(({ label, icon: Icon, prompt }) => <button key={label} type="button" disabled={!draftReady || sending || locatingSession} onClick={() => { updateDraft(draft.trim() ? `${draft}\n\n${prompt}` : prompt); newWorkInput.current?.focus(); }}><Icon size={15} /><span>{label}</span><ArrowUpRightIcon size={13} /></button>)}</div>
							<section className="m1-workbench-history" aria-label="当前工作空间的历史工作">
								<div className="m1-workbench-history-head"><h2>当前项目的工作记录</h2><span>{manager ? `${manager.workspace?.name ?? "默认工作目录"} · ${historySessions.length} 条` : loadError ? "读取失败" : managerListReady ? "Manager 未就绪" : "正在加载"}</span></div>
								{loadError ? <div className="m1-workbench-history-error" role="alert">工作记录暂时无法更新：{loadError}<button type="button" onClick={() => void refresh()}>重试</button></div> : null}
								{manager ? historySessions.length ? <div className="m1-workbench-history-list">{historySessions.map((session) => <button key={session.id} type="button" onClick={() => selectHistorySession(session.id)}><span>{sessionTitle(session.name, session.firstMessage)}</span><time>{session.modifiedAt ? compactTime(session.modifiedAt) : ""}</time></button>)}</div> : <p className="m1-workbench-history-empty">这个项目还没有历史工作。</p> : !loadError ? <p className="m1-workbench-history-empty" role="status">{managerListReady ? "Manager 尚不可用。" : "正在加载工作记录…"}</p> : null}
							</section>
						</div>
					</div> : null}
					{showConversation ? <section className="m1-workbench-conversation" aria-label="Manager 对话">
								{manager && requestedSessionId && !targetSessionId ? (
									<div className="m1-workbench-unavailable" role={linkError ? "alert" : "status"}>
										<div>{linkError ?? "正在定位历史工作与原工作空间…"}{linkError ? <span className="m1-workbench-link-actions"><button type="button" onClick={() => { locationQueue.current.invalidate(); locatedSessionRef.current = null; setLocatedSessionId(null); setLinkError(null); setSelectionNonce((value) => value + 1); }}>重试定位</button><button type="button" onClick={returnToWorkbench}>返回工作台</button></span> : null}</div>
									</div>
								) : manager ? (
								<ChatPane key={`${manager.id}:${selectionNonce}`} roomId={manager.id} requestedSessionId={targetSessionId} requestedSessionActivation="parent" onOpenWindow={(id, sourceSessionId) => router.push(`/chats?room=${encodeURIComponent(id)}${sourceSessionId ? `&returnSession=${encodeURIComponent(sourceSessionId)}` : ""}`)} onRoomUpdated={handleManagerUpdated} onWorkspaceSwitched={handleManagerContextActivated} onSessionActivated={handleManagerContextActivated} onRoomsMayHaveChanged={() => void refresh()} />
								) : (
									<div className="m1-workbench-unavailable" role="status">
										{loadError ? "Manager 对话暂时不可用，请重试读取工作记录。" : managerListReady ? <div><span>Manager 尚不可用，请检查智能体配置。</span><Link href="/agents">查看智能体</Link></div> : "正在加载 Manager 对话…"}
									</div>
								)}
						</section> : null}
					{!showConversation && workspacePickerFromHome && manager ? (
						<div className="hidden">
							<ChatPane
								key={`${manager.id}:workspace-picker`}
								roomId={manager.id}
								requestedSessionActivation="parent"
								workspaceDialogOnly
								openWorkspaceOnMount
								onWorkspacePickerClosed={() => { setWorkspacePickerFromHome(false); void refresh(); }}
								onRoomUpdated={handleManagerUpdated}
								onRoomsMayHaveChanged={() => void refresh()}
							/>
						</div>
					) : null}
				</main>
			</div>
		</div>
	);
}
