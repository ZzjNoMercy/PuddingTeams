"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { RoomSession, RoomSummary } from "@/lib/types";
import { SessionMenu } from "./session-menu";
import { ManagerAvatar, WorkerAvatar } from "./worker-avatar";

function GroupAvatar({ room }: { room: RoomSummary }) {
	const shownMembers = room.members.slice(0, 4);
	const positions =
		shownMembers.length === 2
			? ["left-1 top-5", "right-1 top-5"]
			: shownMembers.length === 3
				? ["left-5 top-1", "left-1 bottom-1", "right-1 bottom-1"]
				: ["left-1 top-1", "right-1 top-1", "left-1 bottom-1", "right-1 bottom-1"];
	return (
		<div className="relative size-16 shrink-0 rounded-2xl border bg-muted/40">
			{shownMembers.map((member, index) => (
				<WorkerAvatar
					key={member.name}
					name={member.name}
					size={24}
					className={`absolute ring-2 ring-background ${positions[index]}`}
				/>
			))}
		</div>
	);
}

function InfoRow({
	label,
	value,
	detail,
	onSelect,
}: {
	label: string;
	value: string;
	detail?: string;
	onSelect?: () => void;
}) {
	const content = (
		<>
			<span className="shrink-0 text-sm font-medium">{label}</span>
			<span className="ml-auto flex min-w-0 max-w-[68%] items-center gap-2">
				<span className="min-w-0 flex-1 text-right">
					<span className="block truncate text-sm text-muted-foreground" title={value}>{value}</span>
					{detail ? (
						<span className="mt-0.5 block truncate text-xs text-muted-foreground/70" title={detail}>{detail}</span>
					) : null}
				</span>
				{onSelect ? <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/60" /> : null}
			</span>
		</>
	);

	return onSelect ? (
		<button
			type="button"
			onClick={onSelect}
			className="flex min-h-14 w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&+&]:border-t"
		>
			{content}
		</button>
	) : (
		<div className="flex min-h-14 w-full items-center gap-4 px-4 py-3 [&+&]:border-t">
			{content}
		</div>
	);
}

const SessionInfoRow = forwardRef<
	HTMLButtonElement,
	{ value: string } & ButtonHTMLAttributes<HTMLButtonElement>
>(function SessionInfoRow({ value, ...props }, ref) {
	return (
		<button
			ref={ref}
			type="button"
			{...props}
			className="flex min-h-14 w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&+&]:border-t"
		>
			<span className="shrink-0 text-sm font-medium">当前会话</span>
			<span className="ml-auto flex min-w-0 max-w-[68%] items-center gap-2">
				<span className="block min-w-0 flex-1 truncate text-right text-sm text-muted-foreground" title={value}>
					{value}
				</span>
				<ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/60" />
			</span>
		</button>
	);
});

export function ChatInfoDialog({
	room,
	open,
	onOpenChange,
	onRename,
	onEditPrompt,
	onSwitchWorkspace,
	onSwitchSession,
	onNewSession,
	onRenameSession,
	onDeleteSession,
}: {
	room: RoomSummary;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRename: () => void;
	onEditPrompt: () => void;
	onSwitchWorkspace: () => void;
	onSwitchSession: (sessionId: string) => void | Promise<void>;
	onNewSession: () => void | Promise<void>;
	onRenameSession: (session: RoomSession) => void;
	onDeleteSession: (session: RoomSession) => void;
}) {
	const isGroup = room.type === "group";
	const isDirect = room.type === "direct";
	const directMember = isDirect ? room.members[0] : undefined;
	const activeSession = room.sessions.find((session) => session.active);
	const activeSessionName = activeSession?.name || activeSession?.firstMessage || "新会话";
	const workspaceName = room.workspace?.name ?? "默认目录";
	const workspacePath = room.workspace?.rootPath ?? room.cwdSnapshot;
	const profileDescription = isGroup
		? `${room.members.length} 位成员共同协作，Manager 负责分工与汇总。`
		: isDirect
			? directMember?.description || "执行具体任务并返回结果。"
			: "负责理解消息、安排任务并汇总结果。";
	const typeLabel = isGroup ? "群聊" : isDirect ? `单聊 · ${directMember?.name ?? ""}` : "Manager";

	const runAction = (action: () => void) => {
		onOpenChange(false);
		setTimeout(action, 0);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[85vh] gap-0 overflow-y-auto p-0 sm:max-w-xl">
				<DialogHeader className="border-b px-5 py-4 text-left">
					<DialogTitle>聊天信息</DialogTitle>
				</DialogHeader>

				<div className="space-y-5 p-5">
					<div className="flex items-center gap-4 rounded-xl bg-muted/40 p-4">
						{isGroup ? (
							<GroupAvatar room={room} />
						) : isDirect && directMember ? (
							<WorkerAvatar name={directMember.name} size={64} />
						) : (
							<ManagerAvatar size={64} />
						)}
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								<h2 className="truncate text-base font-semibold">{room.name}</h2>
								<span className="shrink-0 rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground">
									{typeLabel}
								</span>
							</div>
							<p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
								{profileDescription}
							</p>
							{directMember ? (
								<div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
									<span className={`size-1.5 rounded-full ${directMember.enabled === false ? "bg-muted-foreground/40" : "bg-foreground"}`} />
									{directMember.enabled === false ? "已停用" : "可用"}
								</div>
							) : null}
						</div>
					</div>

					{isGroup ? (
						<section>
							<div className="mb-2 flex items-center justify-between px-1">
								<h3 className="text-sm font-medium">群成员</h3>
								<span className="text-xs tabular-nums text-muted-foreground">{room.members.length} 位</span>
							</div>
							<div className="grid grid-cols-4 gap-2 rounded-xl border bg-muted/20 p-3 sm:grid-cols-5">
								{room.members.map((member) => (
									<div key={member.name} className="flex min-w-0 flex-col items-center gap-1.5 py-1" title={member.description}>
										<div className="relative">
											<WorkerAvatar name={member.name} size={42} />
											<span
												className={`absolute right-0 bottom-0 size-2.5 rounded-full border-2 border-background ${member.enabled === false ? "bg-muted-foreground/40" : "bg-foreground"}`}
												title={member.enabled === false ? "已停用" : "可用"}
											/>
										</div>
										<span className="w-full truncate text-center text-xs">{member.name}</span>
									</div>
								))}
							</div>
						</section>
					) : null}

					<section>
						<h3 className="mb-2 px-1 text-sm font-medium">聊天设置</h3>
						<div className="overflow-hidden rounded-xl border bg-background">
							<InfoRow
								label={isGroup ? "群聊名称" : "对话名称"}
								value={room.name}
								onSelect={() => runAction(onRename)}
							/>
							{room.type === "group" ? (
								<InfoRow
									label="协作提示词"
									value={room.prompt || "使用默认协作规则"}
									onSelect={() => runAction(onEditPrompt)}
								/>
							) : null}
						</div>
					</section>

					<section>
						<h3 className="mb-2 px-1 text-sm font-medium">聊天上下文</h3>
						<div className="overflow-hidden rounded-xl border bg-background">
							<InfoRow
								label="运行项目"
								value={workspaceName}
								detail={workspacePath}
								onSelect={() => runAction(onSwitchWorkspace)}
							/>
							<SessionMenu
								sessions={room.sessions}
								trigger={<SessionInfoRow value={activeSessionName} />}
								onSwitch={onSwitchSession}
								onNew={onNewSession}
								onRename={(session) => runAction(() => onRenameSession(session))}
								onDelete={(session) => runAction(() => onDeleteSession(session))}
							/>
							<InfoRow label="会话数量" value={`${room.sessions.length} 个`} />
						</div>
					</section>
				</div>
			</DialogContent>
		</Dialog>
	);
}
