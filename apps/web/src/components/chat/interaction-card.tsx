"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckIcon, ExternalLinkIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cancelInteraction, getInteraction, submitInteractionResponse } from "@/lib/api";
import { useAgentLabel } from "@/lib/avatars";
import { WorkerAvatar } from "./worker-avatar";

type CardStatus = "pending" | "busy" | "approved" | "rejected" | "expired" | "failed";

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
	windowId,
	statusHint,
	compact,
	onOpenWindow,
}: {
	interactionId?: string;
	worker: string;
	requests?: Array<{ requestId: string; prompt: string; command?: string; path?: string; risk?: string; options?: string[] }>;
	revision?: number;
	windowId?: string;
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
	const reqs = requests ?? [];
	const firstReq = reqs[0];
	// M4：授权范围从服务端 options 派生，去掉 "reject"（那是动作不是范围），
	// 默认取第一个合法范围，避免 options 不含 "once" 时 409。
	// 兜底选项对齐 puddingclaw deploy-cli 的 respond 校验（仅 once|session）。
	const allowedScopes = (firstReq?.options?.length ? firstReq.options : ["once", "session"]).filter(
		(s) => s !== "reject",
	);
	const [scope, setScope] = useState<string>(allowedScopes[0] ?? "once");

	// 对账：有 interactionId 时以服务端为准，刷新/重放后恢复状态。
	useEffect(() => {
		if (!interactionId) return;
		let cancelled = false;
		getInteraction(interactionId)
			.then(({ interaction }) => {
				if (cancelled) return;
				setLiveRevision(interaction.revision);
				const s = interaction.status as CardStatus;
				if (s === "approved" || s === "rejected" || s === "expired" || s === "failed") {
					setStatus(s);
					setBusy(false);
				}
			})
			.catch((err: unknown) => {
				// L3：服务端明确 404（已删除/过期）→ 卡片转已过期；网络错误保留 pending。
				if (!cancelled && err instanceof Error && /404|not found/i.test(err.message)) {
					setStatus("expired");
					setBusy(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [interactionId]);

	const submit = useCallback(
		async (action: "approve" | "reject" | "confirm", chosenScope?: string) => {
			if (!interactionId) return;
			setBusy(true);
			try {
				const outcome = (await submitInteractionResponse(interactionId, {
					requestId: crypto.randomUUID(),
					revision: liveRevision ?? revision ?? 0,
					...(windowId ? { windowId } : {}),
					responses: (requests ?? []).map((r) => ({
						requestId: r.requestId,
						action,
						scope: action === "reject" ? undefined : chosenScope ?? scope,
					})),
				})) as { outcome?: { status?: string; result?: { error?: string } } };
				const status = outcome?.outcome?.status;
				if (status === "failed" || status === "rejected") {
					// M1：失败/被拒不能显示成功。
					toast.error(outcome.outcome!.result?.error ?? "审批处理失败");
					getInteraction(interactionId)
						.then(({ interaction }) => {
							setLiveRevision(interaction.revision);
							setStatus(interaction.status as CardStatus);
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
				toast.success(action === "reject" ? "已拒绝该请求" : "已批准");
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
				// 409 等错误后重新对账，避免状态卡死。
				getInteraction(interactionId)
					.then(({ interaction }) => {
						setLiveRevision(interaction.revision);
						setStatus(interaction.status as CardStatus);
					})
					.catch(() => undefined);
			} finally {
				setBusy(false);
			}
		},
		[interactionId, liveRevision, revision, requests, scope, windowId],
	);

	const cancel = useCallback(async () => {
		if (!interactionId) return;
		setBusy(true);
		try {
			await cancelInteraction(interactionId);
			setStatus("expired");
			toast.success("已取消该审批");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}, [interactionId]);

	const resolved = status !== "pending" && status !== "busy";

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
						{statusLabel(status)}
					</Badge>
				</div>
			</div>
			<div className="flex flex-col gap-2.5 p-3">
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
						{allowedScopes.length > 1 && status !== "busy" ? (
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
						<div className="flex items-center gap-2">
							<Button type="button" size="sm" disabled={busy} onClick={() => void submit("approve", scope)}>
								{busy ? null : <CheckIcon className="size-3.5" />}
								允许
							</Button>
							<Button
								type="button"
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() => void submit("reject")}
							>
								<XIcon className="size-3.5" />
								拒绝
							</Button>
							{interactionId ? (
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
					</>
				) : resolved ? (
					<p className="text-xs text-muted-foreground">{statusLabel(status)}</p>
				) : null}
			</div>
		</div>
	);
}
