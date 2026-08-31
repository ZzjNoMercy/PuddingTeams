"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowRightLeftIcon, CheckIcon, ExternalLinkIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cancelInteraction, getInteraction, submitInteractionResponse } from "@/lib/api";
import { useAgentLabel } from "@/lib/avatars";
import { WorkerAvatar } from "./worker-avatar";

type CardStatus = "pending" | "busy" | "approved" | "rejected" | "expired" | "failed" | "replaced";

function statusLabel(status: CardStatus): string {
	switch (status) {
		case "pending":
			return "等待审批";
		case "busy":
			return "处理中…";
		case "approved":
			return "已批准";
		case "rejected":
			return "已拒绝";
		case "expired":
			return "已过期";
		case "failed":
			return "处理失败";
		case "replaced":
			return "已换 Worker";
		default:
			return status;
	}
}

/**
 * HITL 审批卡（§6.5）。承载面：
 * - `pudding:interaction_required` custom message（needs_input 时由 invoker
 *   写入 manager 会话；solo 还会镜像进对方单聊窗口）——唯一事实源；
 * - 委托工具结果只保留文本说明，不再内联渲染审批卡（避免同一窗口两张卡）；
 * - 409 冲突卡（无交互正文，只有状态与「去处理」跳转）除外。
 *
 * 状态以服务端为事实源：挂载时和每次操作后通过 GET /api/interactions/:id 对账，
 * 支持页面刷新后恢复（pending/approved/rejected/expired 都可重放）。
 */
export function InteractionCard({
	interactionId,
	worker,
	requests,
	revision,
	kind,
	windowId,
	goalId,
	source,
	workerStarted,
	statusHint,
	compact,
	onOpenWindow,
}: {
	interactionId?: string;
	worker: string;
	requests?: Array<{ requestId: string; prompt: string; command?: string; path?: string; risk?: string; options?: string[] }>;
	revision?: number;
	kind?: "permission" | "question" | "confirmation";
	windowId?: string;
	goalId?: string;
	source?: "worker" | "platform_policy";
	workerStarted?: boolean;
	statusHint?: string;
	compact?: boolean;
	onOpenWindow?: (windowId: string) => void;
}) {
	const [status, setStatus] = useState<CardStatus>(
		statusHint === "conflict" || (statusHint && !["needs_input"].includes(statusHint)) ? (statusHint as CardStatus) : "pending",
	);
	// worker prop 是内部 id（头像用），卡面展示显示名。
	const workerLabel = useAgentLabel(worker);
	const [busy, setBusy] = useState(false);
	// 多轮审批（needs_input 后同 id、revision+1）：以服务端对账的 revision 为准，
	// props 里的 revision 只是首渲染快照。
	const [liveRevision, setLiveRevision] = useState<number | undefined>(revision);
	const [liveKind, setLiveKind] = useState<"permission" | "question" | "confirmation">(kind ?? "permission");
	// Goal identity is authoritative on the Delegation. Historical/mirrored cards
	// may predate the goalId projection, so refresh it together with the
	// interaction instead of trusting only the message snapshot.
	const [liveGoalId, setLiveGoalId] = useState<string | undefined>(goalId);
	const [liveSource, setLiveSource] = useState<"worker" | "platform_policy">(source ?? "worker");
	const [liveWorkerStarted, setLiveWorkerStarted] = useState(workerStarted ?? false);
	const [replacementCandidates, setReplacementCandidates] = useState<Array<{
		agentId: string;
		displayName: string;
		readOnlyEnforcement: "sandbox" | "remote_policy";
	}>>([]);
	const [replacementCandidatesLoaded, setReplacementCandidatesLoaded] = useState(false);
	const [replacementMode, setReplacementMode] = useState(false);
	const [selectedReplacement, setSelectedReplacement] = useState<string>();
	const [replacementLabel, setReplacementLabel] = useState<string>();
	const [replacementFailed, setReplacementFailed] = useState(false);
	const platformAdmission = liveSource === "platform_policy";
	const reqs = requests ?? [];
	const firstReq = reqs[0];
	// M4：授权范围从服务端 options 派生，去掉 "reject"（那是动作不是范围），
	// 默认取第一个合法范围，避免 options 不含 "once" 时 409。
	// 兜底选项对齐 puddingclaw deploy-cli 的 respond 校验（仅 once|session）。
	const allowedScopes = liveKind === "permission"
		? (firstReq?.options?.length ? firstReq.options : ["once", "session"]).filter((s) => s !== "reject")
		: [];
	const businessOptions = liveKind === "permission" ? [] : (firstReq?.options ?? []).filter((option) => option !== "reject");
	const [scope, setScope] = useState<string>(allowedScopes[0] ?? "once");
	const [answer, setAnswer] = useState("");

	// 对账：有 interactionId 时以服务端为准，刷新/重放后恢复状态。
	useEffect(() => {
		if (!interactionId) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			try {
				const { interaction, delegation } = await getInteraction(interactionId);
				if (cancelled) return;
				setLiveRevision(interaction.revision);
				setLiveKind(interaction.kind);
				setLiveGoalId(delegation?.goalId ?? goalId);
				setLiveSource(interaction.source);
				setLiveWorkerStarted(delegation?.workerStarted ?? false);
				setReplacementCandidates(interaction.replacementCandidates ?? []);
				setReplacementCandidatesLoaded(true);
				setSelectedReplacement((current) => current ?? interaction.replacementCandidates?.[0]?.agentId);
				if (interaction.decision?.chosenAction === "select_another_worker") {
					setReplacementLabel(
						interaction.replacementCandidates?.find((item) => item.agentId === interaction.decision?.replacementAgentId)?.displayName
							?? interaction.decision.replacementAgentId,
					);
					if (interaction.application?.status === "applied") {
						setStatus("replaced");
						setBusy(false);
						return;
					}
					if (interaction.application?.status === "failed") setReplacementFailed(true);
				}
				if (interaction.application?.status === "failed") {
					setStatus("failed");
					setBusy(false);
					return;
				}
				if (interaction.source === "platform_policy" && interaction.application?.status === "applying") {
					setStatus("busy");
					setBusy(true);
					timer = setTimeout(() => void refresh(), 1_500);
					return;
				}
				const s = interaction.status as CardStatus;
				if (s === "approved" || s === "rejected" || s === "expired" || s === "failed") {
					setStatus(s);
					setBusy(false);
				}
			} catch (err: unknown) {
				// L3：服务端明确 404（已删除/过期）→ 卡片转已过期；网络错误保留 pending。
				if (!cancelled && err instanceof Error && /404|not found/i.test(err.message)) {
					setStatus("expired");
					setBusy(false);
				} else if (!cancelled) {
					timer = setTimeout(() => void refresh(), 2_000);
				}
			}
		};
		void refresh();
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	}, [goalId, interactionId]);

	const submit = useCallback(
		async (action: "approve" | "reject" | "answer" | "confirm", chosenScope?: string, value?: unknown) => {
			if (!interactionId) return;
			setBusy(true);
			try {
				const outcome = (await submitInteractionResponse(interactionId, {
					requestId: crypto.randomUUID(),
					revision: liveRevision ?? revision ?? 0,
					...(liveGoalId ? { expectedGoalId: liveGoalId } : {}),
					...(windowId ? { windowId } : {}),
					responses: (requests ?? []).map((r) => ({
						requestId: r.requestId,
						action,
						scope: action === "approve" ? chosenScope ?? scope : undefined,
						value,
					})),
				})) as { outcome?: { status?: string; result?: { error?: string } } };
				const status = outcome?.outcome?.status;
				if (status === "replaced") {
					const selected = replacementCandidates.find((item) => item.agentId === value);
					setReplacementLabel(selected?.displayName ?? (typeof value === "string" ? value : undefined));
					setStatus("replaced");
					setReplacementMode(false);
					toast.success(`已改派给 ${selected?.displayName ?? "替代 Worker"}`);
					return;
				}
				if (status === "failed" || status === "rejected") {
					// M1：失败/被拒不能显示成功。
					toast.error(outcome.outcome!.result?.error ?? "审批处理失败");
					getInteraction(interactionId)
						.then(({ interaction }) => {
							setLiveRevision(interaction.revision);
							setReplacementCandidates(interaction.replacementCandidates ?? []);
							setReplacementCandidatesLoaded(true);
							if (interaction.application?.status === "failed") {
								setReplacementFailed(interaction.decision?.chosenAction === "select_another_worker");
								setStatus("failed");
							} else setStatus(interaction.status as CardStatus);
						})
						.catch(() => undefined);
					return;
				}
				if (status === "needs_input") {
					// 多轮审批：worker 又提了新问题（同 id、revision+1），
					// 不能显示"已批准"，重新对账回到 pending 等用户再操作。
					toast("已提交，worker 需要进一步审批");
					getInteraction(interactionId)
						.then(({ interaction }) => {
							setLiveRevision(interaction.revision);
							setStatus(interaction.status === "pending" ? "pending" : (interaction.status as CardStatus));
						})
						.catch(() => undefined);
					return;
				}
				setStatus(action === "reject" ? "rejected" : "approved");
				if (platformAdmission && action !== "reject") setLiveWorkerStarted(true);
				toast.success(action === "reject" ? "已拒绝该请求" : "已批准");
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
				// 409 等错误后重新对账，避免状态卡死。
				getInteraction(interactionId)
					.then(({ interaction }) => {
						setLiveRevision(interaction.revision);
						setReplacementCandidates(interaction.replacementCandidates ?? []);
						setReplacementCandidatesLoaded(true);
						if (interaction.application?.status === "failed") {
							setReplacementFailed(interaction.decision?.chosenAction === "select_another_worker");
							setStatus("failed");
						} else setStatus(interaction.status as CardStatus);
					})
					.catch(() => undefined);
			} finally {
				setBusy(false);
			}
		},
		[interactionId, liveGoalId, liveRevision, platformAdmission, replacementCandidates, revision, requests, scope, windowId],
	);

	const cancel = useCallback(async () => {
		if (!interactionId) return;
		setBusy(true);
		try {
			await cancelInteraction(interactionId, liveGoalId);
			setStatus("expired");
			toast.success("已取消该审批");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [interactionId, liveGoalId]);

	// A failed platform application can still own a pre-start Delegation. Keep a
	// single explicit Cancel action available so the user can close that task.
	const resolved = status !== "pending" && status !== "busy" && !(platformAdmission && status === "failed" && !replacementFailed);

	return (
		<div className="w-full overflow-hidden rounded-lg border border-border/60 bg-muted/60">
			<div className="flex items-center justify-between gap-2 px-3 pt-2">
				<div className="flex min-w-0 items-center gap-2">
					<WorkerAvatar name={worker} size={20} />
					<span className="truncate font-mono text-sm font-medium">{workerLabel}</span>
					{statusHint === "conflict" ? (
						<Badge variant="destructive" className="gap-1">
							<ShieldAlertIcon className="size-3" />
							会话占用
						</Badge>
					) : null}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{statusHint === "conflict" && windowId && onOpenWindow ? (
						<button
							type="button"
							onClick={() => onOpenWindow(windowId)}
							className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
						>
							去处理
							<ExternalLinkIcon className="size-3" />
						</button>
					) : null}
					<Badge
						variant={
							status === "rejected" || status === "expired"
								? "destructive"
								: status === "approved"
									? "secondary"
									: "secondary"
						}
					>
						{platformAdmission && status === "pending" ? "等待 Teams 准入" : platformAdmission && status === "approved" ? "已允许使用" : statusLabel(status)}
					</Badge>
				</div>
			</div>
			<div className="flex flex-col gap-2.5 p-3">
				{platformAdmission ? (
					<div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs">
						<p className="font-medium">
							{status === "replaced" ? `原 Worker 未启动，已改派给 ${replacementLabel ?? "替代 Worker"}` : liveWorkerStarted ? "Worker 已开始执行" : "Worker 尚未启动"}
						</p>
						<p className="mt-1 text-muted-foreground">
							{status === "replaced"
								? "新 Worker 使用独立 Delegation 和会话，原 Worker 不会再启动。"
								: "继续仅允许 Teams 使用这个 Worker，不会改变其权限，也不代表只读已得到保证。"}
						</p>
					</div>
				) : workerStarted === false ? <p className="text-xs text-muted-foreground">Worker 尚未启动</p> : null}
				{reqs.map((r) => (
					<div key={r.requestId} className="flex flex-col gap-1">
						<p className="text-sm whitespace-pre-wrap">{r.prompt}</p>
						{(r.command || r.path || r.risk) && !compact ? (
							<pre className="overflow-x-auto rounded-md bg-muted/60 p-2 text-xs">
								{[r.command ? `命令：${r.command}` : "", r.path ? `路径：${r.path}` : "", r.risk ? `风险：${r.risk}` : ""]
									.filter(Boolean)
									.join("\n")}
							</pre>
						) : null}
					</div>
				))}

				{!resolved && !statusHint?.includes("conflict") ? (
					<>
						{!platformAdmission && businessOptions.length > 0 && status !== "busy" ? (
							<div className="flex flex-wrap gap-2" role="group" aria-label="可选回答">
								{businessOptions.map((option) => (
									<Button key={option} type="button" size="sm" variant="outline" disabled={busy} onClick={() => void submit(liveKind === "confirmation" ? "confirm" : "answer", undefined, option)}>
										{option}
									</Button>
								))}
							</div>
						) : null}
						{!platformAdmission && liveKind === "question" && businessOptions.length === 0 && status !== "busy" ? (
							<div className="flex gap-2">
								<Input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="输入给 Worker 的回答" aria-label="给 Worker 的回答" />
								<Button type="button" size="sm" disabled={busy || !answer.trim()} onClick={() => void submit("answer", undefined, answer.trim())}>提交回答</Button>
							</div>
						) : null}
						{!platformAdmission && liveKind === "permission" && allowedScopes.length > 1 && status !== "busy" ? (
							<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<span>授权范围：</span>
								{allowedScopes.map((s) => (
									<button
										key={s}
										type="button"
										onClick={() => setScope(s)}
										className={`rounded-full px-2 py-0.5 ${
											scope === s ? "bg-foreground text-background" : "bg-muted hover:bg-accent"
										}`}
									>
										{s === "once" ? "仅本次" : s === "run" ? "本次任务" : s === "session" ? "本次会话" : s}
									</button>
								))}
							</div>
						) : null}
						{platformAdmission && !replacementMode && replacementCandidatesLoaded && replacementCandidates.length === 0 && status !== "failed" ? (
							<p className="text-xs text-muted-foreground">当前没有其它声明了强制只读能力的可用 Worker。</p>
						) : null}
						{platformAdmission && replacementMode ? (
							<div className="rounded-md border border-border/70 bg-background/70 p-2.5">
								<p className="text-xs font-medium">选择能验证只读能力的 Worker</p>
								<div className="mt-2 flex flex-col gap-1.5">
									{replacementCandidates.map((candidate) => (
										<button
											key={candidate.agentId}
											type="button"
											onClick={() => setSelectedReplacement(candidate.agentId)}
											className={`flex items-center justify-between rounded-md border px-2.5 py-2 text-left text-xs ${selectedReplacement === candidate.agentId ? "border-primary bg-primary/5" : "border-border/60 hover:bg-muted"}`}
										>
											<span className="font-medium">{candidate.displayName}</span>
											<span className="text-muted-foreground">{candidate.readOnlyEnforcement === "sandbox" ? "只读沙箱" : "远端只读策略"}</span>
										</button>
									))}
								</div>
								<div className="mt-2 flex items-center gap-2">
									<Button type="button" size="sm" disabled={busy || !selectedReplacement} onClick={() => void submit("approve", "select_another_worker", selectedReplacement)}>
										<ArrowRightLeftIcon className="size-3.5" />
										确认改派
									</Button>
									<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setReplacementMode(false)}>返回</Button>
								</div>
							</div>
						) : (
						<div className="flex items-center gap-2">
							{platformAdmission && status !== "failed" ? (
								<Button type="button" size="sm" disabled={busy} onClick={() => void submit("approve", "proceed_with_worker")}>
									{busy ? null : <CheckIcon className="size-3.5" />}
									继续使用
								</Button>
							) : liveKind === "permission" && status !== "failed" ? (
								<Button type="button" size="sm" disabled={busy} onClick={() => void submit("approve", scope)}>
									{busy ? null : <CheckIcon className="size-3.5" />}
									允许
								</Button>
							) : null}
							{!platformAdmission && liveKind === "confirmation" && businessOptions.length === 0 && status !== "failed" ? (
								<Button type="button" size="sm" disabled={busy} onClick={() => void submit("confirm")}>确认</Button>
							) : null}
							{platformAdmission && status !== "failed" && replacementCandidates.length > 0 ? (
								<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setReplacementMode(true)}>
									<ArrowRightLeftIcon className="size-3.5" />
									换 Worker
								</Button>
							) : null}
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy}
							onClick={() => void (status === "failed" && platformAdmission ? cancel() : submit("reject"))}
							>
								<XIcon className="size-3.5" />
								{platformAdmission ? "取消任务" : "拒绝"}
							</Button>
							{interactionId && !platformAdmission ? (
								<Button
									type="button"
									size="sm"
									variant="ghost"
									className="ml-auto text-xs text-muted-foreground"
									disabled={busy}
									onClick={() => void cancel()}
								>
									取消
								</Button>
							) : null}
						</div>
						)}
					</>
				) : resolved ? (
					<p className="text-xs text-muted-foreground">{statusLabel(status)}</p>
				) : null}
			</div>
		</div>
	);
}
