"use client";

import type { ReactElement } from "react";
import { CheckIcon, PencilIcon, PlusIcon } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RoomSession } from "@/lib/types";
import { homePortalContainer } from "@/lib/home-portal";

function updateLabel(session: RoomSession): string {
	const modifiedAt = new Date(session.modifiedAt);
	if (Number.isNaN(modifiedAt.getTime())) return session.active ? "当前会话" : "";

	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const startOfModified = new Date(modifiedAt.getFullYear(), modifiedAt.getMonth(), modifiedAt.getDate());
	const dayDelta = Math.round((startOfToday.getTime() - startOfModified.getTime()) / 86_400_000);
	const elapsed = Math.max(0, now.getTime() - modifiedAt.getTime());

	let update: string;
	if (elapsed < 60_000) update = "刚刚更新";
	else if (elapsed < 3_600_000) update = `${Math.floor(elapsed / 60_000)} 分钟前更新`;
	else if (dayDelta === 0) update = "今天更新";
	else if (dayDelta === 1) update = "昨天更新";
	else update = `${modifiedAt.getMonth() + 1}月${modifiedAt.getDate()}日更新`;

	return session.active ? `当前会话 · ${update}` : update;
}

export function SessionMenu({
	sessions,
	trigger,
	onSwitch,
	onNew,
	onRename,
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
							<strong>{session.name || session.firstMessage || "新对话"}</strong>
							<span>{updateLabel(session)}</span>
						</span>
						<button
							type="button"
							aria-label={`重命名会话「${session.name || session.firstMessage || "新对话"}」`}
							onClick={(event) => {
								event.stopPropagation();
								onRename(session);
							}}
							className="home-session-menu-edit"
						>
							<PencilIcon />
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
