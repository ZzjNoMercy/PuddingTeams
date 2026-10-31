import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentInvokeParams, AgentInvokeResult, AgentInvoker } from "../agent-runtime/invoker.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type {
	RoomParticipantRunner,
	RoomParticipantRunnerInput,
	RoomParticipantRunnerResult,
} from "./room-message-router.js";

/**
 * 公开回合的生产 runner 适配（方案 §20.1）。
 *
 * - Pi ParticipantSession：复用 PiSessionStore 的原生会话与 prompt；
 * - 非 Pi：复用 direct_chat Delegation，不新建 Run 类型。
 * 两者都只把 final content 交给 ParticipantTurn 投影。
 */

type MessagePart = { type?: string; text?: string };
type MessageLike = { role?: string; content?: unknown; stopReason?: string };

function messageText(message: MessageLike): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is MessagePart => Boolean(part) && typeof part === "object" && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text!)
		.join("\n");
}

/** 取本轮最后一条非空 assistant 文本；中间的 tool 旁白不参与 final。 */
export function finalAssistantFrom(messages: readonly MessageLike[], startIndex: number): { text?: string; stopReason?: string } {
	const reply = [...messages.slice(Math.max(0, startIndex))].reverse().find((message) => message.role === "assistant");
	if (!reply) return {};
	return { ...(messageText(reply).trim() ? { text: messageText(reply).trim() } : {}), ...(reply.stopReason ? { stopReason: reply.stopReason } : {}) };
}

export class PiParticipantRunner implements RoomParticipantRunner {
	constructor(private readonly deps: { sessions: Pick<PiSessionStore, "open"> }) {}

	async run(input: RoomParticipantRunnerInput): Promise<RoomParticipantRunnerResult> {
		const session = await this.deps.sessions.open(input.binding.agentSessionId) as unknown as {
			messages: MessageLike[];
			prompt(text: string): Promise<void>;
		};
		const start = session.messages.length;
		try {
			await session.prompt(input.prompt);
		} catch (error) {
			return { status: "failed", terminalReason: error instanceof Error ? error.message : String(error) };
		}
		const final = finalAssistantFrom(session.messages, start);
		if (final.stopReason === "aborted") {
			return { status: "cancelled", terminalReason: "aborted", ...(final.text ? { finalContent: final.text } : {}) };
		}
		if (final.stopReason === "error") {
			return { status: "failed", terminalReason: "模型返回 error", ...(final.text ? { finalContent: final.text } : {}) };
		}
		if (!final.text) return { status: "failed", terminalReason: "模型没有返回可发布的最终文本" };
		return { status: "completed", finalContent: final.text, execution: { kind: "native_pi" } };
	}
}

type DelegateFn = (params: AgentInvokeParams) => Promise<AgentInvokeResult>;

export class DirectChatParticipantRunner implements RoomParticipantRunner {
	constructor(private readonly deps: {
		invoker: Pick<AgentInvoker, "requireAgent"> & { delegate: DelegateFn };
		/** 读取持久 provider handle；缺省不续接（新 provider 会话）。 */
		handleFor?: (binding: RoomParticipantRunnerInput["binding"]) => Promise<string | undefined>;
		/** Driver started/完成带回 handle 时持久到 sessionRefs。 */
		rememberHandle?: (binding: RoomParticipantRunnerInput["binding"], agent: Awaited<ReturnType<AgentInvoker["requireAgent"]>>, handle: string) => Promise<void>;
	}) {}

	async run(input: RoomParticipantRunnerInput): Promise<RoomParticipantRunnerResult> {
		const agent = await this.deps.invoker.requireAgent(input.binding.agentId);
		const sessionHandle = await this.deps.handleFor?.(input.binding);
		const result = await this.deps.invoker.delegate({
			agent,
			windowId: input.binding.roomId,
			managerSessionId: input.binding.agentSessionId,
			invocationKind: "direct_chat",
			message: input.prompt,
			mode: "continue",
			...(sessionHandle ? { sessionHandle } : {}),
			operationId: input.turn.operationId,
			...(input.binding.workspaceId ? { workspaceId: input.binding.workspaceId } : {}),
			purpose: "execution",
			signal: input.signal,
		});
		if (result.sessionHandle && this.deps.rememberHandle) {
			await this.deps.rememberHandle(input.binding, agent, result.sessionHandle).catch(() => undefined);
		}
		if (!result.delegationId) return { status: "failed", terminalReason: "Worker 没有返回 Delegation 身份" };
		const base = {
			delegationIds: [result.delegationId],
			execution: { kind: "direct_chat" as const, delegationId: result.delegationId },
		};
		if (result.status === "completed") {
			if (!result.content.trim()) return { ...base, status: "failed", terminalReason: "Worker 没有返回可发布的最终文本" };
			return { ...base, status: "completed", finalContent: result.content };
		}
		if (result.status === "needs_input") return { ...base, status: "waiting_input" };
		if (result.status === "cancelled") return { ...base, status: "cancelled", terminalReason: "Worker 已取消" };
		if (result.status === "observation_lost") return { ...base, status: "unknown", terminalReason: "执行观测丢失，效果未知" };
		return { ...base, status: "failed", terminalReason: result.content || result.status };
	}
}

/** 测试/宿主用：把 session 对象适配成最小 prompt 接口。 */
export type PiSessionLike = Pick<AgentSession, "messages" | "prompt">;
