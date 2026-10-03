import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface ConversationTurn { role: "user" | "assistant"; content: string; timestamp: number }

/** Rehydrate the visible conversation when no usable Worker transcript exists.
 * The current durable user entry is a boundary, not a second copy of this turn. */
export function directConversationHistory(branch: readonly SessionEntry[], operationId: string): ConversationTurn[] {
	const current = branch.findIndex(entry => entry.type === "custom_message" && entry.customType === "pudding:user_message" &&
		(entry.details as { operationId?: string } | undefined)?.operationId === operationId);
	if (current < 0) throw new Error("当前消息尚未落盘，不能恢复聊天上下文");
	const prior = branch.slice(0, current);
	const latestResults = new Map<string, number>();
	prior.forEach((entry, index) => {
		if (entry.type !== "custom_message" || entry.customType !== "pudding:task_result") return;
		const details = entry.details as { taskId?: string; delegationId?: string } | undefined;
		const key = details?.taskId ?? details?.delegationId;
		if (key) latestResults.set(key, index);
	});
	return prior.flatMap<ConversationTurn>((entry, index) => {
		if (entry.type !== "custom_message") return [];
		const details = entry.details as { executionText?: string } | undefined;
		const content = entry.customType === "pudding:user_message" && details?.executionText ? details.executionText : entry.content;
		if (typeof content !== "string" || !content.trim()) return [];
		const timestamp = Date.parse(entry.timestamp);
		if (entry.customType === "pudding:user_message") return [{ role: "user" as const, content, timestamp }];
		if (entry.customType === "pudding:task_result") {
			const result = entry.details as { taskId?: string; delegationId?: string } | undefined;
			const key = result?.taskId ?? result?.delegationId;
			if (key && latestResults.get(key) !== index) return [];
			return [{ role: "assistant" as const, content, timestamp }];
		}
		return [];
	});
}
