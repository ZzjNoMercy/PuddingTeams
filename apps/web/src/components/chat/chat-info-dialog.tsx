"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { ChevronDownIcon, XIcon } from "lucide-react";
import type { RoomSession, RoomSummary } from "@/lib/types";
import { SessionMenu } from "./session-menu";
import { WorkerAvatar } from "./worker-avatar";

function GroupAvatar({ room }: { room: RoomSummary }) {
	const shownMembers = room.members.slice(0, 2);
	return (
		<div className="flex shrink-0 -space-x-2 pl-0.5">
			{shownMembers.map((member, index) => (
				<WorkerAvatar
					key={member.name}
					name={member.name}
					size={36}
					className={`ring-2 ring-background ${index === 0 ? "relative z-10" : ""}`}
				/>
			))}
			{shownMembers.length === 0 ? <span className="chat-manager-avatar">M</span> : null}
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
			<span className="chat-info-label shrink-0">{label}</span>
			<span className="ml-auto flex min-w-0 max-w-[68%] items-center gap-2">
				<span className="min-w-0 flex-1 text-right">
					<span className="chat-info-value block truncate" title={value}>{value}</span>
					{detail ? (
						<span className="chat-info-detail mt-0.5 block truncate" title={detail}>{detail}</span>
					) : null}
				</span>
				{onSelect ? <ChevronDownIcon className="size-3 shrink-0 text-foreground/70" /> : null}
			</span>
		</>
	);

	return onSelect ? (
		<button
			type="button"
			onClick={onSelect}
			className="chat-info-row"
		>
			{content}
		</button>
	) : (
		<div className="chat-info-row cursor-default">
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
			className="chat-info-row"
		>
			<span className="chat-info-label shrink-0">当前会话</span>
			<span className="ml-auto flex min-w-0 max-w-[68%] items-center gap-2">
				<span className="chat-info-value block min-w-0 flex-1 truncate text-right" title={value}>
					{value}
				</span>
				<ChevronDownIcon className="size-3 shrink-0 text-foreground/70" />
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
	const profileDescription = isGroup
		? `${room.members.length} 位 Worker 共同协作，Manager 负责分工与汇总。`
		: isDirect
			? directMember?.description || "执行具体任务并返回结果。"
			: "负责理解消息、安排任务并汇总结果。";
	const runAction = (action: () => void) => {
		onOpenChange(false);
		setTimeout(action, 0);
	};

	return (
		<aside className={`chat-info-inspector ${open ? "open" : ""}`} aria-hidden={!open} inert={!open}>
			<div className="chat-info-panel flex h-full flex-col gap-0 overflow-hidden">
				<header className="chat-info-head flex items-center justify-between text-left">
					<h2 className="chat-info-title leading-none">聊天信息</h2>
					<p className="sr-only">查看并管理当前聊天的成员、规则、项目和会话。</p>
					<button type="button" aria-label="关闭聊天信息" onClick={() => onOpenChange(false)} className="chat-info-close"><XIcon className="size-4" /></button>
				</header>

				<div className="chat-info-scroll">
					<div className="chat-info-profile">
						{isGroup ? (
							<GroupAvatar room={room} />
						) : isDirect && directMember ? (
							<WorkerAvatar name={directMember.name} size={40} />
						) : (
							<span className="chat-manager-avatar">M</span>
						)}
						<div className="min-w-0 flex-1">
							<h2 className="chat-info-profile-title truncate">{room.name}</h2>
							<p className="chat-info-profile-description mt-1 line-clamp-2">
								{profileDescription}
							</p>
						</div>
					</div>

					{isGroup ? (
						<section className="chat-info-section">
							<div className="chat-info-section-label">成员 · {room.members.length + 1}</div>
							<div className="chat-member-grid">
								<div className="chat-member-item"><span className="chat-manager-avatar small">M</span><span>Manager</span></div>
								{room.members.map((member) => (
									<div key={member.name} className="chat-member-item" title={member.description}>
										<WorkerAvatar name={member.name} size={34} />
										<span>{member.name}</span>
									</div>
								))}
							</div>
						</section>
					) : null}

					<section className="chat-info-section">
						<h3 className="chat-info-section-label">聊天</h3>
						<div className="chat-info-list">
							<InfoRow
								label={isGroup ? "群聊名称" : "对话名称"}
								value={room.name}
								onSelect={() => runAction(onRename)}
							/>
							{room.type === "group" ? (
								<InfoRow
									label="协作规则"
									value={room.prompt || "使用默认协作规则"}
									onSelect={() => runAction(onEditPrompt)}
								/>
							) : null}
						</div>
					</section>

					<section className="chat-info-section">
						<h3 className="chat-info-section-label">上下文</h3>
						<div className="chat-info-list">
							<InfoRow
								label="运行项目"
								value={workspaceName}
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
			</div>
		</aside>
	);
}
