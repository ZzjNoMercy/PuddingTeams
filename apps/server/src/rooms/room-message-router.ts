import { createHash, randomUUID } from "node:crypto";
import {
	RoomContextTooLargeError,
	buildRoomContext,
	type BuiltRoomContext,
} from "./room-context.js";
import { RoomEventStore, type RoomAttachmentRef, type RoomEvent } from "./room-event-store.js";
import {
	ParticipantTurnStore,
	type ParticipantTurn,
	type ParticipantTurnExecution,
	type ParticipantTurnStatus,
} from "./participant-turn-store.js";
import type { ParticipantBinding, ParticipantBindingPort } from "./participant-binding-registry.js";
import { RoomTurnService, type ProjectionResult } from "./room-turn-service.js";

/**
 * 房间消息路由（方案 §6、§21.2 的垂直切片）。
 *
 * 首期：无 mentions → Manager；一个 Worker mention → 该 Worker；
 * 同一 RoomSession 只允许一个未终态的公开回合。Manager 模型是否被调用完
 * 全取决于目标：@Worker 时只调该 Worker 的 runner。
 */

export class RoomMessageError extends Error {
	constructor(readonly code:
		| "invalid_message"
		| "invalid_mentions"
		| "room_turn_active"
		| "participant_binding_required"
		| "context_too_large", message: string) {
		super(message);
		this.name = "RoomMessageError";
	}
}

export interface RoomParticipantTarget {
	agentId: string;
	agentSessionId: string;
	role: "manager" | "worker";
}

export interface RoomParticipantRunnerInput {
	roomSessionId: string;
	turn: ParticipantTurn;
	binding: ParticipantBinding;
	prompt: string;
	context: BuiltRoomContext;
	signal?: AbortSignal;
}

export interface RoomParticipantRunnerResult {
	status: "completed" | "failed" | "cancelled";
	finalContent?: string;
	terminalReason?: string;
	execution?: ParticipantTurnExecution;
	delegationIds?: string[];
}

export interface RoomParticipantRunner {
	run(input: RoomParticipantRunnerInput): Promise<RoomParticipantRunnerResult>;
}

export interface RoomMessageRouterDeps {
	events: RoomEventStore;
	turns: ParticipantTurnStore;
	bindings: ParticipantBindingPort;
	turnService: RoomTurnService;
	runner: RoomParticipantRunner;
	/** 目标还没有 ParticipantBinding 时创建（P0-A 由测试夹具提供）。 */
	ensureParticipant?: (roomSessionId: string, agentId: string) => Promise<ParticipantBinding>;
	managerAgentId: string;
	agentNames?: Record<string, string>;
	maxContextChars?: number;
	now?: () => string;
}

export interface SendRoomMessageInput {
	roomSessionId: string;
	content: string;
	mentions: string[];
	attachments?: RoomAttachmentRef[];
	operationId: string;
}

export interface SendRoomMessageResult {
	roomEventId: string;
	turnId: string;
	status: ParticipantTurnStatus;
	finalContent?: string;
	projection?: ProjectionResult;
}

const ACTIVE_STATUSES: ReadonlySet<ParticipantTurnStatus> = new Set([
	"admitted", "running", "waiting_input", "reconciling", "unknown",
]);

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

export class RoomMessageRouter {
	constructor(private readonly deps: RoomMessageRouterDeps) {}

	private now(): string {
		return this.deps.now?.() ?? new Date().toISOString();
	}

	/** 结构化接收人：首期只接受 0 或 1 个 mention。 */
	async resolveTarget(roomSessionId: string, mentions: readonly string[]): Promise<RoomParticipantTarget> {
		const unique = [...new Set(mentions)];
		if (unique.length !== mentions.length) throw new RoomMessageError("invalid_mentions", "mentions 不能重复");
		if (unique.length > 1) throw new RoomMessageError("invalid_mentions", "首期一次只支持一个 mention");
		const agentId = unique[0] ?? this.deps.managerAgentId;
		let binding = await this.deps.bindings.get(roomSessionId, agentId);
		if (!binding && this.deps.ensureParticipant) binding = await this.deps.ensureParticipant(roomSessionId, agentId);
		if (!binding) throw new RoomMessageError("participant_binding_required", `agent ${agentId} 没有可用的 ParticipantSession`);
		return { agentId: binding.agentId, agentSessionId: binding.agentSessionId, role: binding.role };
	}

	private async activeTurn(roomSessionId: string): Promise<ParticipantTurn | undefined> {
		const turns = await this.deps.turns.list(roomSessionId);
		return turns.find((turn) => ACTIVE_STATUSES.has(turn.status));
	}

	async send(input: SendRoomMessageInput): Promise<SendRoomMessageResult> {
		const content = input.content.trim();
		if (!content) throw new RoomMessageError("invalid_message", "消息正文不能为空");
		const active = await this.activeTurn(input.roomSessionId);
		if (active) throw new RoomMessageError("room_turn_active", `房间已有未终态公开回合：${active.id}`);
		const target = await this.resolveTarget(input.roomSessionId, input.mentions);
		const binding = await this.deps.bindings.get(input.roomSessionId, target.agentId);
		if (!binding) throw new RoomMessageError("participant_binding_required", `agent ${target.agentId} 没有 active binding`);
		const events = await this.deps.events.read(input.roomSessionId);
		const eventId = randomUUID();
		const mentions = [...new Set(input.mentions)];
		const draft = {
			id: eventId,
			kind: "message" as const,
			actor: { kind: "user" as const },
			content,
			mentions,
			...(input.attachments?.length ? { attachments: input.attachments } : {}),
			createdAt: this.now(),
		};

		let context: BuiltRoomContext;
		try {
			context = buildRoomContext({
				events,
				...(binding.lastRoomEntryId ? { after: binding.lastRoomEntryId } : {}),
				current: {
					eventId,
					content,
					mentions,
					...(input.attachments?.length ? { attachments: input.attachments } : {}),
					targetAgentName: this.deps.agentNames?.[target.agentId] ?? target.agentId,
				},
				...(this.deps.maxContextChars ? { maxChars: this.deps.maxContextChars } : {}),
				...(this.deps.agentNames ? { agentNames: this.deps.agentNames } : {}),
			});
		} catch (error) {
			if (error instanceof RoomContextTooLargeError) throw new RoomMessageError("context_too_large", error.message);
			throw error;
		}

		const userEvent = await this.deps.events.append(input.roomSessionId, draft);
		const begun = await this.deps.turnService.begin({
			roomSessionId: input.roomSessionId,
			agentId: target.agentId,
			agentSessionId: target.agentSessionId,
			sourceRoomEventId: userEvent.id,
			operationId: input.operationId,
			inputHash: hashText(context.text),
			...(binding.lastRoomEntryId ? { contextFromAfterRoomEventId: binding.lastRoomEntryId } : {}),
		});
		await this.deps.turnService.start(input.roomSessionId, begun.turn.id);

		let result: RoomParticipantRunnerResult;
		try {
			result = await this.deps.runner.run({
				roomSessionId: input.roomSessionId,
				turn: begun.turn,
				binding,
				prompt: context.text,
				context,
			});
		} catch (error) {
			result = { status: "failed", terminalReason: error instanceof Error ? error.message : String(error) };
		}

		if (result.execution || result.delegationIds?.length) {
			await this.deps.turns.update(input.roomSessionId, begun.turn.id, {
				...(result.execution ? { execution: result.execution } : {}),
				...(result.delegationIds?.length ? { delegationIds: result.delegationIds } : {}),
			});
		}
		let turn: ParticipantTurn | undefined;
		if (result.status === "completed" && result.finalContent?.trim()) {
			turn = await this.deps.turnService.complete(input.roomSessionId, begun.turn.id, result.finalContent);
		} else if (result.status === "cancelled") {
			turn = await this.deps.turnService.cancel(input.roomSessionId, begun.turn.id, result.terminalReason ?? "用户取消", result.finalContent);
		} else {
			turn = await this.deps.turnService.fail(
				input.roomSessionId,
				begun.turn.id,
				result.terminalReason ?? (result.status === "completed" ? "模型没有返回可发布的最终文本" : "执行失败"),
				result.finalContent,
			);
		}
		const projection = await this.deps.turnService.project(input.roomSessionId, turn.id);
		return {
			roomEventId: userEvent.id,
			turnId: turn.id,
			status: turn.status,
			...(turn.finalContent ? { finalContent: turn.finalContent } : {}),
			projection,
		};
	}

	/** 最小房间时间线：公共事件 + 未终态回合；不含任何私有执行记录。 */
	async timeline(roomSessionId: string): Promise<{ events: RoomEvent[]; turns: ParticipantTurn[]; activeTurn?: ParticipantTurn }> {
		const [events, turns] = await Promise.all([
			this.deps.events.read(roomSessionId),
			this.deps.turns.list(roomSessionId),
		]);
		const activeTurn = turns.find((turn) => ACTIVE_STATUSES.has(turn.status));
		return { events, turns, ...(activeTurn ? { activeTurn } : {}) };
	}
}
