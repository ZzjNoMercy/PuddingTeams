"use client";

import type { ReactElement } from "react";
import { CheckIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RoomSession } from "@/lib/types";
import { homePortalContainer } from "@/lib/home-portal";

/** pi 元数据的 "(no messages)" 是占位不是名字（direct 窗口全是 custom 卡，
 *  没有 user 角色消息可摘），与「新对话」一样不参与展示。 */
function sessionDisplayName(session: RoomSession): string {
	const first = session.firstMessage;
	const meaningful = first && first !== "新对话" && first !== "(no messages)" ? first : "";
	return session.name || meaningful || "新对话";
}

function updateLabel(session: RoomSession): string {	const modifiedAt = new Date(session.modifiedAt);
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
	trigger,
	onSwitch,
	onNew,
	onRename,
	onDelete,
	align = "end",
}: {
	sessions: RoomSession[];
	trigger: ReactElement;
	onSwitch: (sessionId: string) => void | Promise<void>;
	onNew: () => void | Promise<void>;
	onRename: (session: RoomSession) => void;
	onDelete: (session: RoomSession) => void;
	align?: "start" | "center" | "end";
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
			<DropdownMenuContent align={align} sideOffset={8} className="home-session-menu" container={homePortalContainer()}>
				<div className="home-session-menu-count">{sessions.length} 个会话</div>
				{sessions.map((session) => (
					<DropdownMenuItem
						key={session.id}
						onSelect={() => void onSwitch(session.id)}
						className={`home-session-menu-item ${session.active ? "is-active" : ""}`}
					>
						<span className="home-session-menu-check" aria-hidden="true">
							{session.active ? <CheckIcon /> : null}
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
				<DropdownMenuItem onSelect={() => void onNew()} className="home-session-menu-new">
					<PlusIcon />
					<span>新建会话</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
