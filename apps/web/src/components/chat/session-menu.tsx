"use client";

import type { ReactElement } from "react";
import { CheckIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RoomSession, WorkerSessionSummary } from "@/lib/types";
import { homePortalContainer } from "@/lib/home-portal";

/** pi 元数据的 "(no messages)" 是占位不是名字（direct 窗口全是 custom 卡，
 *  没有 user 角色消息可摘），与「新对话」一样不参与展示。 */
function sessionDisplayName(session: Pick<RoomSession, "name" | "firstMessage">): string {
	const first = session.firstMessage;
	const meaningful = first && first !== "新对话" && first !== "(no messages)" ? first : "";
	return session.name || meaningful || "新对话";
}

function updateLabel(session: Pick<RoomSession, "modifiedAt">): string {	const modifiedAt = new Date(session.modifiedAt);
	if (Number.isNaN(modifiedAt.getTime())) return "";

	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const startOfModified = new Date(modifiedAt.getFullYear(), modifiedAt.getMonth(), modifiedAt.getDate());
	const dayDelta = Math.round((startOfToday.getTime() - startOfModified.getTime()) / 86_400_000);
	const elapsed = Math.max(0, now.getTime() - modifiedAt.getTime());

	if (elapsed < 60_000) return "刚刚";
	if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
	if (dayDelta === 0) return "今天";
	if (dayDelta === 1) return "昨天";
	return `${modifiedAt.getMonth() + 1}月${modifiedAt.getDate()}日`;
}

export function SessionMenu({
	sessions,
	workerSessions,
	activeWorkerView,
	trigger,
	onSwitch,
	onNew,
	onRename,
	onDelete,
	onRenameWorker,
	onDeleteWorker,
	align = "end",
}: {
	sessions: RoomSession[];
	/** Manager 委派产生的 worker 执行 session（直派执行面不单列）；传入时按「直接对话 / Manager 委派」分组渲染。 */
	workerSessions?: WorkerSessionSummary[];
	/** 当前查看的执行 session handle；命中时对勾标在对应 worker session 上。 */
	activeWorkerView?: string | null;
	trigger: ReactElement;
	onSwitch: (sessionId: string) => void | Promise<void>;
	onNew?: () => void | Promise<void>;
	onRename: (session: RoomSession) => void;
	onDelete: (session: RoomSession) => void;
	onRenameWorker?: (session: WorkerSessionSummary) => void;
	onDeleteWorker?: (session: WorkerSessionSummary) => void;
	align?: "start" | "center" | "end";
}) {
	const delegated = workerSessions ?? [];
	const grouped = delegated.length > 0;
	// 查看执行面时，容器 activeSession 不是当前查看目标，对勾要让位。
	const containerActive = (session: RoomSession) => !activeWorkerView && session.active;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
			<DropdownMenuContent align={align} sideOffset={8} className="home-session-menu" container={homePortalContainer()}>
				<div className="home-session-menu-count">{sessions.length + delegated.length} 个会话</div>
				{grouped ? <div className="home-session-menu-group">直接对话</div> : null}
				{sessions.map((session) => (
					<DropdownMenuItem
						key={session.id}
						onSelect={() => void onSwitch(session.id)}
						className={`home-session-menu-item ${containerActive(session) ? "is-active" : ""}`}
					>
						<span className="home-session-menu-check" aria-hidden="true">
							{containerActive(session) ? <CheckIcon /> : null}
						</span>
						<span className="home-session-menu-copy">
							<strong>{sessionDisplayName(session)}</strong>
							<span>{updateLabel(session)}</span>
						</span>
						<button
							type="button"
							aria-label={`重命名会话「${sessionDisplayName(session)}」`}
							onClick={(event) => {
								event.stopPropagation();
								onRename(session);
							}}
							className="home-session-menu-edit"
						>
							<PencilIcon />
						</button>
						<button
							type="button"
							aria-label={`删除会话「${sessionDisplayName(session)}」`}
							onClick={(event) => {
								event.stopPropagation();
								onDelete(session);
							}}
							className="home-session-menu-delete"
						>
							<Trash2Icon />
						</button>
					</DropdownMenuItem>
				))}
				{grouped ? <div className="home-session-menu-group">Manager 委派</div> : null}
				{delegated.map((session) => {
					const name = sessionDisplayName(session);
					const active = activeWorkerView === session.id;
					const source = session.sourceWindowName ? `来自${session.sourceWindowName}` : "";
					return (
						<DropdownMenuItem
							key={session.id}
							onSelect={() => void onSwitch(session.id)}
							className={`home-session-menu-item ${active ? "is-active" : ""}`}
						>
							<span className="home-session-menu-check" aria-hidden="true">
								{active ? <CheckIcon /> : null}
							</span>
							<span className="home-session-menu-copy">
								<strong>{name}</strong>
								{session.running ? <span className="home-session-menu-dot" aria-label="运行中" title="运行中" /> : null}
								<span>{session.running ? [source, "运行中"].filter(Boolean).join(" · ") : [source, updateLabel(session)].filter(Boolean).join(" · ")}</span>
							</span>
							<button
								type="button"
								aria-label={`重命名会话「${name}」`}
								onClick={(event) => {
									event.stopPropagation();
									onRenameWorker?.(session);
								}}
								className="home-session-menu-edit"
							>
								<PencilIcon />
							</button>
							<button
								type="button"
								aria-label={`删除会话「${name}」`}
								onClick={(event) => {
									event.stopPropagation();
									onDeleteWorker?.(session);
								}}
								className="home-session-menu-delete"
							>
								<Trash2Icon />
							</button>
						</DropdownMenuItem>
					);
				})}
				{onNew ? <DropdownMenuItem onSelect={() => void onNew()} className="home-session-menu-new">
					<PlusIcon />
					<span>新建会话</span>
				</DropdownMenuItem> : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
