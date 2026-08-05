"use client";

import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Loader } from "@/components/ai-elements/loader";
import { useChat } from "@/hooks/useChat";
import { Composer } from "./composer";
import { Message } from "./message";

export function ChatPane({ sessionId }: { sessionId: string }) {
	const { messages, status, running, error, send, stop } = useChat(sessionId);

	const statusLabel =
		status === "connected"
			? "已连接 pi manager"
			: status === "connecting"
				? "连接中…"
				: status === "reconnecting"
					? "连接中断，重连中…"
					: "连接已断开，仍在后台重试";

	return (
		<div className="relative flex h-full flex-col">
			<header className="flex items-center justify-between px-4 py-2">
				<span
					className={`flex items-center gap-2 text-xs ${
						status === "connected"
							? "text-muted-foreground"
							: status === "connecting" || status === "reconnecting"
								? "text-muted-foreground/70"
								: "text-destructive"
					}`}
				>
					{(status === "connecting" || status === "reconnecting") && <Loader size={12} />}
					{statusLabel}
				</span>
				<div className="flex items-center gap-2">
					{error ? (
						<span className="max-w-[60%] truncate text-xs text-destructive">{error}</span>
					) : null}
				</div>
			</header>
			<Conversation>
				<ConversationContent className="mx-auto w-full max-w-3xl gap-6">
					{messages.length === 0 ? (
						<div className="flex flex-1 items-center justify-center pt-20 text-sm text-muted-foreground">
							开始和 pi manager 对话
						</div>
					) : (
						messages.map((m) => <Message key={m.id} message={m} />)
					)}
				</ConversationContent>
				<ConversationScrollButton className="z-10" />
			</Conversation>
			<Composer sessionId={sessionId} disabled={running} onSend={send} onStop={stop} />
		</div>
	);
}
