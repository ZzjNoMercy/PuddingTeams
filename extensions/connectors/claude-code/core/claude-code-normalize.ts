import type { AgentEvent, DriverCapabilities } from "@puddingteams/pwcp/types";

/**
 * Claude Code CLI（claude -p --output-format stream-json --verbose）的
 * JSONL 事件流归一化（§4.2）。
 *
 * 实测事件形态（Claude Code 2.1）：
 * - {"type":"system","subtype":"init","session_id":"…","model":"…",…}
 * - {"type":"system","subtype":"thinking_tokens",…}  ← 每 token 一条，必须过滤
 * - {"type":"assistant","message":{"content":[{type:"text"|"thinking"|"tool_use",…}]}}
 * - {"type":"result","subtype":"success","is_error":false,"result":"…",
 *    "session_id":"…","usage":{…},"total_cost_usd":…,"num_turns":…}
 *
 * headless（-p）模式没有跨进程审批能力：不会产生 input_required，
 * interactionKinds 诚实声明为空（§9.2）。
 */

interface ClaudeFinal {
	success: boolean;
	content: string;
	sessionId?: string;
	usage?: { turns?: number; inputTokens?: number; outputTokens?: number; cost?: number };
	error?: string;
}

/** 逐事件归约器：纯函数式累积，无 I/O，driver 与单测共用。 */
export class ClaudeCodeEventReducer {
	sessionId: string | undefined;
	private final: ClaudeFinal | undefined;

	/**
	 * 喂入一行已解析的 JSON 事件；返回可选的 progress 文本（供 onUpdate）。
	 * thinking_tokens / thinking / text 块都不产生 progress（最终文本由
	 * result 事件携带，避免重复展示）。
	 */
	push(raw: unknown): string | undefined {
		if (!raw || typeof raw !== "object") return undefined;
		const ev = raw as Record<string, unknown>;
		const type = typeof ev.type === "string" ? ev.type : "";

		if (type === "system") {
			if (ev.subtype === "init" && typeof ev.session_id === "string") {
				this.sessionId = ev.session_id;
			}
			// thinking_tokens 及其余 system 事件全部静默。
			return undefined;
		}
		if (type === "assistant") {
			return this.onAssistant(ev.message as Record<string, unknown> | undefined);
		}
		if (type === "result") {
			this.onResult(ev);
			return undefined;
		}
		return undefined;
	}

	private onAssistant(message: Record<string, unknown> | undefined): string | undefined {
		const content = Array.isArray(message?.content) ? (message!.content as unknown[]) : [];
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			if (b.type === "tool_use" && typeof b.name === "string") {
				return toolProgress(b.name, b.input as Record<string, unknown> | undefined);
			}
		}
		return undefined;
	}

	private onResult(ev: Record<string, unknown>): void {
		const subtype = typeof ev.subtype === "string" ? ev.subtype : "";
		const isError = ev.is_error === true || (subtype !== "" && subtype !== "success");
		const usage = ev.usage as Record<string, unknown> | undefined;
		this.final = {
			success: !isError,
			content: typeof ev.result === "string" ? ev.result : "",
			...(typeof ev.session_id === "string" ? { sessionId: ev.session_id } : {}),
			usage: {
				...(typeof ev.num_turns === "number" ? { turns: ev.num_turns } : {}),
				...(typeof usage?.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
				...(typeof usage?.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
				...(typeof ev.total_cost_usd === "number" ? { cost: ev.total_cost_usd } : {}),
			},
			...(isError
				? { error: typeof ev.result === "string" && ev.result ? ev.result : `claude 执行失败（${subtype || "error"}）` }
				: {}),
		};
		if (this.final.sessionId) this.sessionId = this.final.sessionId;
	}

	/**
	 * 进程正常结束后的边界事件（§4.2：恰好一个边界）。
	 * 没有收到 result 事件时返回 undefined，由 driver 判 protocol_error。
	 */
	boundary(agentId: string): AgentEvent | undefined {
		if (!this.final) return undefined;
		const handles = this.sessionId ? { sessionHandle: this.sessionId, runHandle: this.sessionId } : {};
		if (!this.final.success) {
			return {
				type: "failed",
				result: {
					agentId,
					status: "failed",
					...handles,
					errorCode: "worker_failed",
					error: this.final.error ?? "claude 执行失败",
					recoverable: true,
				},
			};
		}
		return {
			type: "completed",
			result: {
				agentId,
				status: "completed",
				...handles,
				content: this.final.content || "（claude 无文本输出）",
				...(this.final.usage ? { usage: this.final.usage } : {}),
			},
		};
	}
}

function toolProgress(name: string, input: Record<string, unknown> | undefined): string {
	const detail =
		name === "Bash" && typeof input?.command === "string"
			? `: ${truncate(input.command, 100)}`
			: (name === "Edit" || name === "Write" || name === "Read") && typeof input?.file_path === "string"
				? `: ${input.file_path}`
				: "";
	return `使用工具 ${name}${detail}`;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

export const CLAUDE_CODE_CAPABILITIES: DriverCapabilities = {
	operations: ["run", "continue", "cancel"],
	interactionKinds: [],
	progress: "stream",
	transport: "spawn",
};
