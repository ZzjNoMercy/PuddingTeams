import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import type { AgentInvokeParams, AgentInvokeResult, AgentInvoker } from "../agent-runtime/invoker.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type {
	RoomParticipantFollowUpInput,
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

interface RunnerSession {
	messages: MessageLike[];
	prompt(text: string, options?: { preflightResult?: (disposition: unknown) => void }): Promise<void>;
	sessionManager?: {
		getBranch(): Array<{ type?: string; id?: string; message?: { role?: string; content?: unknown } }>;
	};
	sessionFile?: string;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((item) => {
		if (typeof item === "string") return item;
		if (item && typeof item === "object" && (item as { type?: string }).type === "text") return String((item as { text?: unknown }).text ?? "");
		return "";
	}).join("");
}

function persistedUserEntry(session: RunnerSession, entryId: string, text: string): boolean {
	if (!session.sessionFile) return true;
	try {
		return readFileSync(session.sessionFile, "utf8").split("\n").some((line: string) => {
			if (!line) return false;
			try {
				const parsed = JSON.parse(line) as { id?: string; type?: string; message?: { role?: string; content?: unknown } };
				return parsed.id === entryId && parsed.type === "message" && parsed.message?.role === "user"
					&& contentText(parsed.message.content).trim() === text.trim();
			} catch { return false; }
		});
	} catch { return false; }
}

/** 轮询到新 user entry 出现（且 JSONL 已落盘）；超时返回 undefined。 */
async function waitForDurableUserEntry(session: RunnerSession, promptText: string, priorIds: Set<string>, priorCount: number): Promise<string | undefined> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const branch = session.sessionManager?.getBranch();
		if (branch) {
			const entry = branch.find((item) => item.type === "message" && item.message?.role === "user"
				&& !priorIds.has(item.id ?? "") && contentText(item.message.content).trim() === promptText.trim());
			if (entry?.id && persistedUserEntry(session, entry.id, promptText)) return entry.id;
		} else {
			const users = session.messages.filter((message) => message.role === "user");
			if (users.length > priorCount) {
				const last = users.at(-1) as { id?: string } | undefined;
				return last?.id ?? "user-entry";
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return undefined;
}

export class PiParticipantRunner implements RoomParticipantRunner {
	constructor(private readonly deps: { sessions: Pick<PiSessionStore, "open"> }) {}

	async run(input: RoomParticipantRunnerInput): Promise<RoomParticipantRunnerResult> {
		const session = await this.deps.sessions.open(input.binding.agentSessionId) as unknown as RunnerSession;
		const start = session.messages.length;
		const priorUserIds = new Set((session.sessionManager?.getBranch() ?? [])
			.filter((entry) => entry.type === "message" && entry.message?.role === "user")
			.map((entry) => entry.id).filter((id): id is string => Boolean(id)));
		try {
			// preflightResult 在 SDK 受理时同步触发，但此时 user entry 还没写入
			// JSONL；必须等新 user entry 真正落盘后再推进 watermark。
			let accepted!: () => void;
			const acceptedInput = new Promise<void>((resolve) => { accepted = resolve; });
			const prompt = session.prompt(input.prompt, { preflightResult: () => accepted() });
			const outcome = await Promise.race([
				acceptedInput.then(() => "accepted" as const),
				prompt.then(() => "finished" as const, () => "failed" as const),
			]);
			if (outcome === "failed") throw new Error("Agent 拒绝了房间输入");
			const userEntryId = await waitForDurableUserEntry(session, input.prompt, priorUserIds, start);
			if (!userEntryId) throw new Error("房间输入尚未写入 Agent 会话记录");
			await input.markInputDurable(userEntryId);
			if (outcome === "accepted") await prompt;
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

	async followUp(input: RoomParticipantFollowUpInput): Promise<void> {
		const session = await this.deps.sessions.open(input.binding.agentSessionId) as unknown as RunnerSession;
		const priorUserIds = new Set((session.sessionManager?.getBranch() ?? [])
			.filter((entry) => entry.type === "message" && entry.message?.role === "user")
			.map((entry) => entry.id).filter((id): id is string => Boolean(id)));
		const priorCount = session.messages.filter((message) => message.role === "user").length;
		let accepted!: () => void;
		const acceptedInput = new Promise<void>((resolve) => { accepted = resolve; });
		const prompt = session.prompt(input.text, {
			streamingBehavior: "followUp",
			preflightResult: () => accepted(),
		} as { preflightResult?: (disposition: unknown) => void });
		const outcome = await Promise.race([
			acceptedInput.then(() => "accepted" as const),
			prompt.then(() => "finished" as const, () => "failed" as const),
		]);
		if (outcome === "failed") throw new Error("Agent 拒绝了 followUp 输入");
		const userEntryId = await waitForDurableUserEntry(session, input.text, priorUserIds, priorCount);
		if (!userEntryId) throw new Error("followUp 输入尚未写入 Agent 会话记录");
		await input.markInputDurable(userEntryId);
		void prompt.catch(() => undefined);
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
		// delegate 已持久化 Delegation 接单；此时才推进 Room 输入水位。
		await input.markInputDurable(result.delegationId);
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
