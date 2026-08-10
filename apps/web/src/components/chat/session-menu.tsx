"use client";

import type { ReactElement } from "react";
import { CheckIcon, PencilIcon, PlusIcon, XIcon } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RoomSession } from "@/lib/types";

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
			<DropdownMenuContent align={align} className="max-h-80 w-72 overflow-y-auto">
				<div className="px-2 py-1.5 text-xs text-muted-foreground">{sessions.length} 个会话</div>
				{sessions.map((session) => (
					<DropdownMenuItem
						key={session.id}
						onSelect={() => void onSwitch(session.id)}
						className="gap-2"
					>
						<span className="min-w-0 flex-1 truncate">
							{session.name || session.firstMessage || "新对话"}
						</span>
						{session.active ? <CheckIcon className="size-3.5 shrink-0" /> : null}
						<button
							type="button"
							aria-label={`重命名会话「${session.name || session.firstMessage || "新对话"}」`}
							onClick={(event) => {
								event.stopPropagation();
								onRename(session);
							}}
							className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
						>
							<PencilIcon className="size-3" />
						</button>
						<button
							type="button"
							aria-label={`删除会话「${session.name || session.firstMessage || "新对话"}」`}
							onClick={(event) => {
								event.stopPropagation();
								onDelete(session);
							}}
							className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
						>
							<XIcon className="size-3" />
						</button>
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={() => void onNew()}>
					<PlusIcon className="size-3.5" />
					新建会话
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
