import type { AgentEvent, DriverCapabilities } from "@puddingteams/pwcp/types";

/**
 * Codex CLI（codex exec --json）的 JSONL 事件流归一化（§4.2）。
 *
 * 实测事件形态（codex-cli 0.145）：
 * - {"type":"thread.started","thread_id":"…"}
 * - {"type":"turn.started"}
 * - {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
 *   （item 还有 reasoning / command_execution / file_change 等类型）
 * - {"type":"turn.completed","usage":{…}}
 *
 * Codex headless 没有跨进程审批能力：不会产生 input_required，
 * interactionKinds 诚实声明为空（§9.2）。
 */

export interface CodexUsage {
	inputTokens?: number;
	outputTokens?: number;
}

/** 逐事件归约器：纯函数式累积，无 I/O，driver 与单测共用。 */
export class CodexEventReducer {
	threadId: string | undefined;
	usage: CodexUsage | undefined;
	sawTurnCompleted = false;
	private error: string | undefined;
	private readonly contentParts: string[] = [];

	/**
	 * 喂入一行已解析的 JSON 事件；返回可选的 progress 文本（供 onUpdate）。
	 * agent_message 不产生 progress（其文本即最终交付，避免与 completed
	 * content 重复展示）。
	 */
	push(raw: unknown): string | undefined {
		if (!raw || typeof raw !== "object") return undefined;
		const ev = raw as Record<string, unknown>;
		const type = typeof ev.type === "string" ? ev.type : "";

		if (type === "thread.started" && typeof ev.thread_id === "string") {
			this.threadId = ev.thread_id;
			return undefined;
		}
		if (type === "item.completed") {
			return this.onItem(ev.item as Record<string, unknown> | undefined);
		}
		if (type === "turn.completed") {
			this.sawTurnCompleted = true;
			const usage = ev.usage as Record<string, unknown> | undefined;
			if (usage) {
				this.usage = {
					...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
					...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
				};
			}
			return undefined;
		}
		if (type === "turn.failed" || type === "error") {
			const err = (ev.error ?? ev.message) as unknown;
			this.error = typeof err === "string" ? err : "codex turn failed";
			return undefined;
		}
		return undefined;
	}

	private onItem(item: Record<string, unknown> | undefined): string | undefined {
		if (!item || typeof item !== "object") return undefined;
		const itemType = typeof item.type === "string" ? item.type : "";
		switch (itemType) {
			case "agent_message": {
				if (typeof item.text === "string" && item.text) this.contentParts.push(item.text);
				return undefined;
			}
			case "command_execution": {
				const cmd = typeof item.command === "string" ? item.command : "";
				return cmd ? `$ ${truncate(cmd, 120)}` : undefined;
			}
			case "file_change": {
				const changes = Array.isArray(item.changes) ? item.changes : [];
				const paths = changes
					.map((c) => (c && typeof c === "object" && typeof (c as Record<string, unknown>).path === "string" ? ((c as Record<string, unknown>).path as string) : ""))
					.filter(Boolean);
				return paths.length ? `修改 ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? " …" : ""}` : "修改文件";
			}
			case "web_search": {
				const q = typeof item.query === "string" ? item.query : "";
				return q ? `搜索 ${truncate(q, 80)}` : "搜索网络";
			}
			default:
				return undefined;
		}
	}

	/** 进程正常结束后的边界事件（§4.2：恰好一个边界）。 */
	boundary(agentId: string): AgentEvent {
		if (this.error) {
			return {
				type: "failed",
				result: {
					agentId,
					status: "failed",
					...(this.threadId ? { sessionHandle: this.threadId, runHandle: this.threadId } : {}),
					errorCode: "worker_failed",
					error: this.error,
					recoverable: true,
				},
			};
		}
		const content = this.contentParts.join("\n\n");
		return {
			type: "completed",
			result: {
				agentId,
				status: "completed",
				...(this.threadId ? { sessionHandle: this.threadId, runHandle: this.threadId } : {}),
				content: content || "（codex 无文本输出）",
				...(this.usage ? { usage: this.usage } : {}),
			},
		};
	}
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

export const CODEX_CAPABILITIES: DriverCapabilities = {
	operations: ["run", "continue", "cancel"],
	interactionKinds: [],
	progress: "stream",
	transport: "spawn",
};
