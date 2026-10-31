import { randomUUID } from "node:crypto";
import {
	RoomEventConflictError,
	RoomEventStore,
	type RoomEvent,
} from "./room-event-store.js";
import {
	ParticipantTurnStore,
	RoomTurnConflictError,
	RoomTurnNotFoundError,
	type ParticipantInput,
	type ParticipantTurn,
	type ParticipantTurnExecution,
	type ParticipantTurnStatus,
} from "./participant-turn-store.js";
import {
	ParticipantBindingRevisionConflictError,
	type ParticipantBinding,
	type ParticipantBindingPort,
} from "./participant-binding-registry.js";

/**
 * 公开回合的公共投影服务（方案 §8.2、§20.2、§22.2 rule 6）。
 *
 * - final 先持久到 ParticipantTurn，再以 sourceParticipantTurnId 幂等追加 RoomEvent；
 * - 终态没有可公开正文时只写一条 terminal；
 * - 只有 message 投影才把 binding 水位推进到自己的 final；失败/取消 terminal
 *   不推进，留待下一回合补读。
 */

export class RoomTurnServiceError extends Error {
	constructor(readonly code: "participant_binding_required" | "turn_not_terminal" | "turn_not_found" | "invalid_cutoff" | "input_not_durable" | "watermark_conflict", message: string) {
		super(message);
		this.name = "RoomTurnServiceError";
	}
}

export interface BeginRoomTurnInput {
	roomSessionId: string;
	agentId: string;
	agentSessionId: string;
	sourceRoomEventId: string;
	operationId: string;
	inputHash: string;
	contextFromAfterRoomEventId?: string;
	execution?: ParticipantTurnExecution;
	/** 仅测试/恢复用；缺省随机生成。 */
	turnId?: string;
}

export interface ProjectionResult {
	turn: ParticipantTurn;
	event?: RoomEvent;
	created: boolean;
	watermarkAdvanced: boolean;
}

function terminalText(status: ParticipantTurnStatus, reason: string | undefined, finalContent: string | undefined): string {
	if (finalContent?.trim()) return finalContent;
	const suffix = reason?.trim() ? `：${reason.trim()}` : "。";
	if (status === "cancelled") return `本次执行已取消${suffix}`;
	if (status === "failed") return `本次执行失败${suffix}`;
	if (status === "interrupted_unknown") return `本次执行结果未知，已由用户标记为中断${suffix}`;
	return `本次回合未发布最终回复${suffix}`;
}

export class RoomTurnService {
	constructor(private readonly deps: {
		events: RoomEventStore;
		turns: ParticipantTurnStore;
		bindings: ParticipantBindingPort;
		now?: () => string;
	}) {}

	private now(): string {
		return this.deps.now?.() ?? new Date().toISOString();
	}

	private async requireBinding(roomSessionId: string, agentId: string): Promise<ParticipantBinding> {
		const binding = await this.deps.bindings.get(roomSessionId, agentId);
		if (!binding) throw new RoomTurnServiceError("participant_binding_required", `room session ${roomSessionId} 没有 agent ${agentId} 的 active binding`);
		return binding;
	}

	/**
	 * 冻结输入范围并创建 admitted Turn。调用方必须已经把用户 RoomEvent
	 * 追加为 sourceRoomEventId；本方法只做存在性/归属校验，不写公共事件。
	 */
	async begin(input: BeginRoomTurnInput): Promise<{ turn: ParticipantTurn; created: boolean; binding: ParticipantBinding }> {
		const binding = await this.requireBinding(input.roomSessionId, input.agentId);
		if (binding.agentSessionId !== input.agentSessionId) {
			throw new RoomTurnServiceError("participant_binding_required", `agentSessionId 与 active binding 不一致: ${input.agentSessionId}`);
		}
		const events = await this.deps.events.read(input.roomSessionId);
		const source = events.find((event) => event.id === input.sourceRoomEventId);
		if (!source) throw new RoomTurnServiceError("invalid_cutoff", `sourceRoomEventId 不存在: ${input.sourceRoomEventId}`);
		if (input.contextFromAfterRoomEventId && !events.some((event) => event.id === input.contextFromAfterRoomEventId)) {
			throw new RoomTurnServiceError("invalid_cutoff", `contextFromAfterRoomEventId 不存在: ${input.contextFromAfterRoomEventId}`);
		}
		const initialInput: ParticipantInput = {
			operationId: input.operationId,
			sourceRoomEventId: input.sourceRoomEventId,
			...(input.contextFromAfterRoomEventId ? { contextFromAfterRoomEventId: input.contextFromAfterRoomEventId } : {}),
			contextThroughRoomEventId: input.sourceRoomEventId,
			inputHash: input.inputHash,
			delivery: "normal",
			persistence: "pending",
		};
		const admitted = await this.deps.turns.admit(input.roomSessionId, {
			id: input.turnId ?? randomUUID(),
			agentSessionId: input.agentSessionId,
			sourceRoomEventId: input.sourceRoomEventId,
			...(input.contextFromAfterRoomEventId ? { contextFromAfterRoomEventId: input.contextFromAfterRoomEventId } : {}),
			contextThroughRoomEventId: input.sourceRoomEventId,
			inputHash: input.inputHash,
			operationId: input.operationId,
			bindingRevision: binding.revision,
			inputs: [initialInput],
			...(input.execution ? { execution: input.execution } : {}),
		});
		return { ...admitted, binding };
	}

	async start(roomSessionId: string, turnId: string, execution?: ParticipantTurnExecution): Promise<ParticipantTurn> {
		return this.deps.turns.update(roomSessionId, turnId, { status: "running", ...(execution ? { execution } : {}) });
	}

	private async ensureRunning(roomSessionId: string, turn: ParticipantTurn): Promise<ParticipantTurn> {
		if (turn.status === "admitted") return this.deps.turns.update(roomSessionId, turn.id, { status: "running" });
		return turn;
	}

	/** final 只落 Turn（pending）；公共投影由 project() 单独完成。 */
	async complete(roomSessionId: string, turnId: string, finalContent: string): Promise<ParticipantTurn> {
		if (!finalContent.trim()) throw new RoomTurnConflictError(roomSessionId, "completed Turn 的 finalContent 不能为空");
		const current = await this.deps.turns.get(roomSessionId, turnId);
		if (!current) throw new RoomTurnNotFoundError(roomSessionId, turnId);
		if (current.inputs.some((input) => input.persistence !== "durable")) {
			throw new RoomTurnServiceError("input_not_durable", `turn ${turnId} 仍有未确认的输入，不能 completed`);
		}
		await this.ensureRunning(roomSessionId, current);
		return this.deps.turns.update(roomSessionId, turnId, { status: "completed", finalContent });
	}

	/** 输入确认落盘/接单；只有 durable 的输入才把 binding 水位推进到该事件。 */
	async markInputDurable(roomSessionId: string, turnId: string, operationId: string, agentUserEntryId?: string): Promise<{ turn: ParticipantTurn; watermarkAdvanced: boolean }> {
		const turn = await this.deps.turns.get(roomSessionId, turnId);
		if (!turn) throw new RoomTurnNotFoundError(roomSessionId, turnId);
		const input = turn.inputs.find((item) => item.operationId === operationId);
		if (!input) throw new RoomTurnConflictError(roomSessionId, `输入 ${operationId} 不属于 turn ${turnId}`);
		const updated = await this.deps.turns.markInputDurable(roomSessionId, turnId, operationId, agentUserEntryId);
		const binding = await this.deps.bindings.findActiveBySession(roomSessionId, updated.agentSessionId);
		if (!binding) return { turn: updated, watermarkAdvanced: false };
		const events = await this.deps.events.read(roomSessionId);
		const target = events.find((event) => event.id === input.contextThroughRoomEventId);
		if (!target) throw new RoomTurnServiceError("invalid_cutoff", `输入 cutoff 事件不存在: ${input.contextThroughRoomEventId}`);
		const current = binding.lastRoomEntryId ? events.find((event) => event.id === binding.lastRoomEntryId) : undefined;
		if (current && current.seq >= target.seq) return { turn: updated, watermarkAdvanced: false };
		await this.deps.bindings.advanceWatermark(roomSessionId, binding.agentId, binding.revision, target.id);
		return { turn: updated, watermarkAdvanced: true };
	}

	async markUnknown(roomSessionId: string, turnId: string, reason: string): Promise<ParticipantTurn> {
		return this.deps.turns.markUnknown(roomSessionId, turnId, reason);
	}

	async closeUnknown(roomSessionId: string, turnId: string, reason: string): Promise<{ turn: ParticipantTurn; projection: ProjectionResult }> {
		const turn = await this.deps.turns.closeUnknown(roomSessionId, turnId, reason);
		return { turn, projection: await this.project(roomSessionId, turnId) };
	}

	async fail(roomSessionId: string, turnId: string, reason: string, finalContent?: string): Promise<ParticipantTurn> {
		const current = await this.deps.turns.get(roomSessionId, turnId);
		if (!current) throw new RoomTurnNotFoundError(roomSessionId, turnId);
		if (current.status === "admitted") await this.ensureRunning(roomSessionId, current);
		return this.deps.turns.update(roomSessionId, turnId, { status: "failed", terminalReason: reason, ...(finalContent ? { finalContent } : {}) });
	}

	async cancel(roomSessionId: string, turnId: string, reason: string, finalContent?: string): Promise<ParticipantTurn> {
		const current = await this.deps.turns.get(roomSessionId, turnId);
		if (!current) throw new RoomTurnNotFoundError(roomSessionId, turnId);
		return this.deps.turns.update(roomSessionId, turnId, { status: "cancelled", terminalReason: reason, ...(finalContent ? { finalContent } : {}) });
	}

	/**
	 * 幂等投影终态：message（有 finalContent）或 terminal；成功后标记 projected。
	 * 崩溃恢复重复调用不会产生第二条公共事件。
	 */
	async project(roomSessionId: string, turnId: string): Promise<ProjectionResult> {
		const turn = await this.deps.turns.get(roomSessionId, turnId);
		if (!turn) throw new RoomTurnNotFoundError(roomSessionId, turnId);
		if (!["completed", "failed", "cancelled", "interrupted_unknown"].includes(turn.status)) {
			throw new RoomTurnServiceError("turn_not_terminal", `turn ${turnId} 尚未终态: ${turn.status}`);
		}
		const binding = await this.deps.bindings.findActiveBySession(roomSessionId, turn.agentSessionId);
		if (!binding) throw new RoomTurnServiceError("participant_binding_required", `turn ${turnId} 的 agentSession 没有 active binding`);
		const hasContent = Boolean(turn.finalContent?.trim());
		const kind = hasContent ? "message" : "terminal";
		const content = hasContent ? turn.finalContent! : terminalText(turn.status, turn.terminalReason, undefined);
		const projected = await this.deps.events.appendIdempotent(roomSessionId, {
			id: randomUUID(),
			kind,
			actor: { kind: "agent", agentId: binding.agentId },
			content,
			mentions: [],
			sourceParticipantTurnId: turn.id,
			createdAt: this.now(),
		});
		let watermarkAdvanced = false;
		const allDurable = turn.inputs.length > 0 && turn.inputs.every((input) => input.persistence === "durable");
		if (kind === "message" && allDurable) {
			const events = await this.deps.events.read(roomSessionId);
			const current = binding.lastRoomEntryId ? events.find((event) => event.id === binding.lastRoomEntryId) : undefined;
			if (!current || current.seq < projected.event.seq) {
				try {
					await this.deps.bindings.advanceWatermark(roomSessionId, binding.agentId, binding.revision, projected.event.id);
					watermarkAdvanced = true;
				} catch (error) {
					if (error instanceof ParticipantBindingRevisionConflictError) {
						throw new RoomTurnServiceError("watermark_conflict", `turn ${turnId} 水位推进 CAS 冲突；投影保持 pending`);
					}
					throw error;
				}
			}
		}
		if (turn.publicProjectionState !== "projected") {
			// 水位先推进、再标记 projected：崩溃在两者之间时 recoverPending 可重试，
			// 不会出现“已 projected 但水位永久落后”。
			await this.deps.turns.update(roomSessionId, turnId, { publicProjectionState: "projected" });
		}
		const refreshed = await this.deps.turns.get(roomSessionId, turnId);
		return { turn: refreshed ?? turn, event: projected.event, created: projected.created, watermarkAdvanced };
	}

	/** 只写 terminal 的显式投影（例如没有 final 的失败）。 */
	async projectTerminal(roomSessionId: string, turnId: string): Promise<ProjectionResult> {
		return this.project(roomSessionId, turnId);
	}

	/** 启动/重连对账：补齐所有 pending 的终态投影。 */
	async recoverPending(roomSessionId: string): Promise<Array<{ turnId: string; projected: boolean; error?: string }>> {
		const turns = await this.deps.turns.list(roomSessionId);
		const pending = turns.filter((turn) => turn.publicProjectionState === "pending" &&
			["completed", "failed", "cancelled", "interrupted_unknown"].includes(turn.status));
		const results: Array<{ turnId: string; projected: boolean; error?: string }> = [];
		for (const turn of pending) {
			try {
				await this.project(roomSessionId, turn.id);
				results.push({ turnId: turn.id, projected: true });
			} catch (error) {
				results.push({ turnId: turn.id, projected: false, error: error instanceof Error ? error.message : String(error) });
			}
		}
		return results;
	}
}
