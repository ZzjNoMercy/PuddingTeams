import { createHash, randomUUID } from "node:crypto";
import {
	RoomContextTooLargeError,
	buildRoomContext,
	type BuiltRoomContext,
} from "./room-context.js";
import { RoomEventStore, type RoomAttachmentRef, type RoomEvent } from "./room-event-store.js";
import {
	ParticipantTurnStore,
	type ParticipantInput,
	type ParticipantTurn,
	type ParticipantTurnExecution,
	type ParticipantTurnStatus,
} from "./participant-turn-store.js";
import type { ParticipantBinding, ParticipantBindingPort } from "./participant-binding-registry.js";
import { RoomTurnService, type ProjectionResult } from "./room-turn-service.js";
import { RoomOperationStore } from "./room-operation-store.js";
import { withRoomAdmissionLock } from "./room-admission-lock.js";
import { publicTurn, type RoomEventBus } from "./room-event-bus.js";
import type { RoomActivityStore } from "./room-activity-store.js";

/**
 * 房间消息路由（方案 §6、§8.1、§8.2、§19.2、§21.2）。
 *
 * send() 只负责准入：在同一房间的原子锁内完成操作账本 reserve、用户
 * RoomEvent、ParticipantTurn/ParticipantInput 与 accepted。runner 在锁外执行，
 * HTTP 响应不等待模型生成；终态由 execute() 投影。
 */

export class RoomMessageError extends Error {
	constructor(readonly code:
		| "invalid_message"
		| "invalid_mentions"
		| "invalid_delivery"
		| "room_turn_active"
		| "participant_binding_required"
		| "context_too_large"
		| "message_operation_conflict"
		| "message_delivery_unconfirmed"
		| "participant_unavailable"
		| "participant_delivery_unsupported", message: string) {
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
	/** runner 在组合输入真正落盘/接单后调用；调用前 accepted 不会返回。 */
	markInputDurable(agentUserEntryId?: string): Promise<void>;
}

export interface RoomParticipantRunnerResult {
	status: "completed" | "failed" | "cancelled" | "waiting_input" | "unknown" | "reconciling";
	finalContent?: string;
	terminalReason?: string;
	execution?: ParticipantTurnExecution;
	delegationIds?: string[];
}

export interface RoomParticipantFollowUpInput {
	roomSessionId: string;
	turn: ParticipantTurn;
	binding: ParticipantBinding;
	text: string;
	markInputDurable(agentUserEntryId?: string): Promise<void>;
}

export interface RoomParticipantRunner {
	run(input: RoomParticipantRunnerInput): Promise<RoomParticipantRunnerResult>;
	/** 原生 followUp：应把输入交给同一 Agent 会话队列，不另起 runner。 */
	followUp?(input: RoomParticipantFollowUpInput): Promise<"durable" | "queued">;
	/** 写 RoomEvent 之前先判定该 Participant 是否支持 followUp。 */
	supportsFollowUp?(binding: ParticipantBinding): Promise<boolean>;
}

export interface RoomContextBudget {
	/** 模型上下文总预算（字符上界）。 */
	maxChars: number;
	/** Agent 指令/Skills/模板等固定占用。 */
	agentInstructionChars?: number;
	/** 预留给模型输出的空间。 */
	reservedOutputChars?: number;
}

export interface RoomMessageRouterDeps {
	events: RoomEventStore;
	turns: ParticipantTurnStore;
	bindings: ParticipantBindingPort;
	turnService: RoomTurnService;
	operations: RoomOperationStore;
	runner: RoomParticipantRunner;
	/** 目标还没有 ParticipantBinding 时创建（P0-A 由测试夹具提供）。 */
	ensureParticipant?: (roomSessionId: string, agentId: string) => Promise<ParticipantBinding>;
	managerAgentId: string;
	agentNames?: Record<string, string>;
	budget: RoomContextBudget;
	bus?: RoomEventBus;
	activity?: RoomActivityStore;
	now?: () => string;
}

export interface SendRoomMessageInput {
	roomSessionId: string;
	content: string;
	mentions: string[];
	attachments?: RoomAttachmentRef[];
	operationId: string;
	delivery?: "normal" | "followUp";
	/** followUp 必填：迟到的输入不能追加到下一回合。 */
	expectedParticipantTurnId?: string;
}

export interface SendRoomMessageResult {
	/** followUp 排队时 accepted 只代表 SDK 已接单，原生输入仍未落盘。 */
	persistence?: "durable" | "pending";
	roomEventId: string;
	turnId: string;
	status: ParticipantTurnStatus;
	replayed: boolean;
}

const ACTIVE_STATUSES: ReadonlySet<ParticipantTurnStatus> = new Set([
	"admitted", "running", "waiting_input", "reconciling", "unknown",
]);

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function requestHash(input: SendRoomMessageInput, content: string): string {
	return createHash("sha256").update(JSON.stringify({
		content,
		mentions: [...input.mentions].sort(),
		attachments: (input.attachments ?? []).map((item) => [item.name, item.sha256, item.size]),
		delivery: input.delivery ?? "normal",
		expectedParticipantTurnId: input.expectedParticipantTurnId ?? null,
	})).digest("hex");
}

function effectiveBudget(budget: RoomContextBudget): number {
	for (const [name, value] of Object.entries(budget)) {
		if (!Number.isSafeInteger(value) || value < 0) throw new RoomMessageError("invalid_delivery", `房间上下文预算 ${name} 必须是非负整数`);
	}
	const effective = budget.maxChars - (budget.agentInstructionChars ?? 0) - (budget.reservedOutputChars ?? 0);
	if (effective <= 0) throw new RoomMessageError("context_too_large", "房间上下文预算不足以容纳固定占用");
	return effective;
}

export class RoomMessageRouter {
	private readonly executions = new Map<string, Promise<void>>();

	constructor(private readonly deps: RoomMessageRouterDeps) {}

	/** 活动读模型不得阻断准入/投影；失败只丢投影，重启可重建。 */
	private async recordActivity(roomSessionId: string, event: RoomEvent, unread = true): Promise<void> {
		try { await this.deps.activity?.record(roomSessionId, { eventId: event.id, at: event.createdAt, preview: event.content, unread }); }
		catch { /* read model only */ }
	}

	private now(): string {
		return this.deps.now?.() ?? new Date().toISOString();
	}

	private executionKey(roomSessionId: string, turnId: string): string {
		return `${roomSessionId}\u0000${turnId}`;
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

	/** 准入返回后执行在后台继续；测试/调用方可用 waitForTurn 等终态。 */
	async send(input: SendRoomMessageInput): Promise<SendRoomMessageResult> {
		const content = input.content.trim();
		if (!content) throw new RoomMessageError("invalid_message", "消息正文不能为空");
		const delivery = input.delivery ?? "normal";
		if (delivery === "normal" && input.expectedParticipantTurnId) throw new RoomMessageError("invalid_delivery", "normal 消息不能携带 expectedParticipantTurnId");
		if (delivery === "followUp" && !input.expectedParticipantTurnId) throw new RoomMessageError("invalid_delivery", "followUp 必须携带 expectedParticipantTurnId");
		const hash = requestHash({ ...input, content }, content);

		return withRoomAdmissionLock(input.roomSessionId, async () => {
			const replay = await this.deps.operations.getMessage(input.roomSessionId, input.operationId);
			if (replay) {
				if (replay.requestHash !== hash) throw new RoomMessageError("message_operation_conflict", "同一消息键已用于不同请求");
				if ((replay.phase === "accepted" || replay.phase === "participant_input_durable")
					&& replay.roomEventId && replay.participantTurnId) {
					const turn = await this.deps.turns.get(input.roomSessionId, replay.participantTurnId);
					if (!turn) throw new RoomMessageError("message_delivery_unconfirmed", "消息账本指向的 Turn 不存在；请刷新时间线核对");
					const durable = turn.inputs.some((item) => item.operationId === input.operationId && item.persistence === "durable");
					if (!durable) throw new RoomMessageError("message_delivery_unconfirmed", "输入尚未落盘；请刷新时间线核对");
					if (replay.phase !== "accepted") await this.deps.operations.advanceMessage(input.roomSessionId, input.operationId, "accepted");
					return { roomEventId: replay.roomEventId, turnId: replay.participantTurnId, status: turn.status, replayed: true };
				}
				if (replay.phase === "participant_bound" && replay.participantTurnId) {
					const turn = await this.deps.turns.get(input.roomSessionId, replay.participantTurnId);
					const pending = turn?.inputs.find((item) => item.operationId === input.operationId && item.delivery === "followUp");
					if (pending) return { roomEventId: replay.roomEventId ?? "", turnId: replay.participantTurnId, status: turn!.status, replayed: true, persistence: "pending" };
				}
				throw new RoomMessageError("message_delivery_unconfirmed", "消息已受理但尚未确认输入落盘；请刷新时间线核对");
			}

			let events: RoomEvent[];
			try { events = await this.deps.events.read(input.roomSessionId); }
			catch (error) {
				if (error instanceof Error && error.name === "RoomSessionNotFoundError") {
					await this.deps.events.create(input.roomSessionId);
					events = [];
				} else throw error;
			}
			if (delivery === "followUp") {
				const active = await this.activeTurn(input.roomSessionId);
				if (!active || active.id !== input.expectedParticipantTurnId) {
					throw new RoomMessageError("invalid_delivery", "followUp 的目标回合已不活动");
				}
				const binding = await this.deps.bindings.findActiveBySession(input.roomSessionId, active.agentSessionId);
				if (!binding) throw new RoomMessageError("participant_binding_required", "followUp 的 ParticipantSession 没有 active binding");
				if (input.mentions.length > 0 && !input.mentions.includes(binding.agentId)) {
					throw new RoomMessageError("invalid_delivery", `followUp 的 mentions 必须指向当前 Participant: ${binding.agentId}`);
				}
				if (!this.deps.runner.followUp
					|| (this.deps.runner.supportsFollowUp && !(await this.deps.runner.supportsFollowUp(binding)))) {
					throw new RoomMessageError("participant_delivery_unsupported", "当前 Participant 不支持原生 followUp");
				}
				const eventId = randomUUID();
				const mentions = [binding.agentId];
				const draft = {
					id: eventId, kind: "message" as const, actor: { kind: "user" as const },
					content, mentions,
					...(input.attachments?.length ? { attachments: input.attachments } : {}),
					createdAt: this.now(),
				};
				let followContext: BuiltRoomContext;
				try {
					followContext = buildRoomContext({
						roomSessionId: input.roomSessionId,
						events,
						...(binding.lastRoomEntryId ? { after: binding.lastRoomEntryId } : {}),
						current: {
							eventId, content, mentions,
							...(input.attachments?.length ? { attachments: input.attachments } : {}),
							targetAgentName: this.deps.agentNames?.[binding.agentId] ?? binding.agentId,
						},
						maxChars: effectiveBudget(this.deps.budget),
						...(this.deps.agentNames ? { agentNames: this.deps.agentNames } : {}),
					});
				} catch (error) {
					if (error instanceof RoomContextTooLargeError) throw new RoomMessageError("context_too_large", error.message);
					throw error;
				}
				const reserved = await this.deps.operations.reserveMessage(input.roomSessionId, { key: input.operationId, requestHash: hash });
				if (!reserved.created) throw new RoomMessageError("message_delivery_unconfirmed", "消息操作已存在但未确认 accepted");
				const userEvent = await this.deps.events.append(input.roomSessionId, draft);
				await this.deps.operations.advanceMessage(input.roomSessionId, input.operationId, "user_event_appended", { roomEventId: userEvent.id });
				this.deps.bus?.publish(input.roomSessionId, { type: "room_event", event: userEvent });
				await this.recordActivity(input.roomSessionId, userEvent, false);
				const appended = await this.deps.turns.appendInput(input.roomSessionId, active.id, {
					operationId: input.operationId,
					sourceRoomEventId: userEvent.id,
					...(binding.lastRoomEntryId ? { contextFromAfterRoomEventId: binding.lastRoomEntryId } : {}),
					contextThroughRoomEventId: userEvent.id,
					inputHash: hashText(followContext.text),
					delivery: "followUp",
					persistence: "pending",
				});
				await this.deps.operations.advanceMessage(input.roomSessionId, input.operationId, "participant_bound", {
					agentSessionId: binding.agentSessionId, participantTurnId: active.id,
				});
				let durableMarked = false;
				let acceptedMarked = false;
				let resolveDurable!: () => void;
				const durableReached = new Promise<void>((resolve) => { resolveDurable = resolve; });
				const finalizeAccepted = async () => {
					if (acceptedMarked) return;
					await this.deps.operations.advanceMessage(input.roomSessionId, input.operationId, "accepted");
					acceptedMarked = true;
				};
				const markInputDurable = async (agentUserEntryId?: string) => {
					if (durableMarked) return;
					await this.deps.turnService.markInputDurable(input.roomSessionId, active.id, input.operationId, agentUserEntryId);
					await this.deps.operations.advanceMessage(input.roomSessionId, input.operationId, "participant_input_durable");
					durableMarked = true;
					resolveDurable();
					await finalizeAccepted();
				};
				const pendingDurable = this.deps.runner.followUp({ roomSessionId: input.roomSessionId, turn: appended.turn, binding, text: followContext.text, markInputDurable });
				let disposition: "durable" | "queued";
				try {
					disposition = await pendingDurable;
				} catch (error) {
					// 排队后输入落盘由 watcher 负责；runner 抛错表示 SDK 拒绝受理。
					throw error instanceof RoomMessageError ? error
						: new RoomMessageError("participant_delivery_unsupported", error instanceof Error ? error.message : String(error));
				}
				if (disposition === "queued") {
					// 用户事件已公开、Turn 保持 active；输入由 watcher 在 native user entry
					// 落盘后推进 durable/accepted。这里只确认 SDK 接单。
					return { roomEventId: userEvent.id, turnId: active.id, status: appended.turn.status, replayed: false, persistence: "pending" };
				}
				await Promise.race([durableReached, Promise.resolve()]);
				if (!durableMarked) throw new RoomMessageError("message_delivery_unconfirmed", "followUp 输入未确认落盘；请刷新时间线核对");
				await finalizeAccepted();
				return { roomEventId: userEvent.id, turnId: active.id, status: appended.turn.status, replayed: false, persistence: "durable" };
			}
			const active = await this.activeTurn(input.roomSessionId);
			if (active) throw new RoomMessageError("room_turn_active", `房间已有未终态公开回合：${active.id}`);
			const target = await this.resolveTarget(input.roomSessionId, input.mentions);
			const binding = await this.deps.bindings.get(input.roomSessionId, target.agentId);
			if (!binding) throw new RoomMessageError("participant_binding_required", `agent ${target.agentId} 没有 active binding`);

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
					roomSessionId: input.roomSessionId,
					events,
					...(binding.lastRoomEntryId ? { after: binding.lastRoomEntryId } : {}),
					current: {
						eventId,
						content,
						mentions,
						...(input.attachments?.length ? { attachments: input.attachments } : {}),
						targetAgentName: this.deps.agentNames?.[target.agentId] ?? target.agentId,
					},
					maxChars: effectiveBudget(this.deps.budget),
					...(this.deps.agentNames ? { agentNames: this.deps.agentNames } : {}),
				});
			} catch (error) {
				if (error instanceof RoomContextTooLargeError) throw new RoomMessageError("context_too_large", error.message);
				throw error;
			}

			const reserved = await this.deps.operations.reserveMessage(input.roomSessionId, { key: input.operationId, requestHash: hash });
			if (!reserved.created) throw new RoomMessageError("message_delivery_unconfirmed", "消息操作已存在但未确认 accepted");
			const userEvent = await this.deps.events.append(input.roomSessionId, draft);
			await this.deps.operations.advanceMessage(input.roomSessionId, input.operationId, "user_event_appended", { roomEventId: userEvent.id });
			this.deps.bus?.publish(input.roomSessionId, { type: "room_event", event: userEvent });
			await this.recordActivity(input.roomSessionId, userEvent, false);

			const begun = await this.deps.turnService.begin({
				roomSessionId: input.roomSessionId,
				agentId: target.agentId,
				agentSessionId: target.agentSessionId,
				sourceRoomEventId: userEvent.id,
				operationId: input.operationId,
				inputHash: hashText(context.text),
				...(binding.lastRoomEntryId ? { contextFromAfterRoomEventId: binding.lastRoomEntryId } : {}),
			});
			const turn = await this.deps.turnService.start(input.roomSessionId, begun.turn.id);
			this.deps.bus?.publish(input.roomSessionId, { type: "participant_turn", turn: publicTurn(turn) });
			await this.deps.operations.advanceMessage(input.roomSessionId, input.operationId, "participant_bound", {
				agentSessionId: target.agentSessionId, participantTurnId: turn.id,
			});
			let durableMarked = false;
			let resolveDurable!: () => void;
			const durableReached = new Promise<void>((resolve) => { resolveDurable = resolve; });
			const markInputDurable = async (agentUserEntryId?: string) => {
				if (durableMarked) return;
				await this.deps.turnService.markInputDurable(input.roomSessionId, turn.id, input.operationId, agentUserEntryId);
				await this.deps.operations.advanceMessage(input.roomSessionId, input.operationId, "participant_input_durable");
				durableMarked = true;
				resolveDurable();
			};
			const execution = this.execute(input.roomSessionId, turn.id, {
				roomSessionId: input.roomSessionId,
				turn,
				binding,
				prompt: context.text,
				context,
				markInputDurable,
			});
			await Promise.race([durableReached, execution.then(() => undefined, () => undefined)]);
			if (!durableMarked) {
				throw new RoomMessageError("message_delivery_unconfirmed", "组合输入未确认落盘；消息已公开，请刷新时间线核对");
			}
			await this.deps.operations.advanceMessage(input.roomSessionId, input.operationId, "accepted");
			return { roomEventId: userEvent.id, turnId: turn.id, status: turn.status, replayed: false };
		});
	}

	/** followUp 可能仍在 native 队列；完成终态前必须等所有输入 durable。 */
	private async waitForDurableInputs(roomSessionId: string, turnId: string, timeoutMs = 30 * 60_000): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const turn = await this.deps.turns.get(roomSessionId, turnId);
			if (!turn) return false;
			if (!["admitted", "running", "waiting_input", "reconciling"].includes(turn.status)) return true;
			if (turn.inputs.every((input) => input.persistence === "durable")) return true;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return false;
	}

	private execute(roomSessionId: string, turnId: string, runnerInput: RoomParticipantRunnerInput): Promise<void> {
		const key = this.executionKey(roomSessionId, turnId);
		const run: Promise<void> = (async () => {
			let result: RoomParticipantRunnerResult;
			try {
				result = await this.deps.runner.run(runnerInput);
			} catch (error) {
				// 输入已 durable 时无法证明远端没有执行；按 unknown 交人工对账。
				await this.deps.turnService.markUnknown(roomSessionId, turnId, error instanceof Error ? error.message : String(error));
				return;
			}
			if (result.execution || result.delegationIds?.length) {
				await this.deps.turns.update(roomSessionId, turnId, {
					...(result.execution ? { execution: result.execution } : {}),
					...(result.delegationIds?.length ? { delegationIds: result.delegationIds } : {}),
				});
			}
			if (result.status === "waiting_input") {
				const updated = await this.deps.turns.update(roomSessionId, turnId, { status: "waiting_input" });
				this.deps.bus?.publish(roomSessionId, { type: "participant_turn", turn: publicTurn(updated) });
				return;
			}
			if (result.status === "unknown") {
				const updated = await this.deps.turnService.markUnknown(roomSessionId, turnId, result.terminalReason ?? "执行结果不确定");
				this.deps.bus?.publish(roomSessionId, { type: "participant_turn", turn: publicTurn(updated) });
				return;
			}
			if (result.status === "reconciling") {
				const updated = await this.deps.turns.update(roomSessionId, turnId, { status: "reconciling" });
				this.deps.bus?.publish(roomSessionId, { type: "participant_turn", turn: publicTurn(updated) });
				return;
			}
			if (result.status === "completed" && result.finalContent?.trim()) {
				// 等待排队输入不能持有房间准入锁：否则长 delegation 期间所有发送都被挂起。
				while (true) {
					const ready = await this.waitForDurableInputs(roomSessionId, turnId);
					if (!ready) {
						const unknown = await this.deps.turnService.markUnknown(roomSessionId, turnId, "followUp 输入未在超时内落盘");
						this.deps.bus?.publish(roomSessionId, { type: "participant_turn", turn: publicTurn(unknown) });
						return;
					}
					const finished = await withRoomAdmissionLock(roomSessionId, async () => {
						const latest = await this.deps.turns.get(roomSessionId, turnId);
						if (!latest || !["admitted", "running", "waiting_input", "reconciling"].includes(latest.status)) return true;
						if (latest.inputs.some((input) => input.persistence !== "durable")) return false;
						const completed = await this.deps.turnService.complete(roomSessionId, turnId, result.finalContent!);
						const projection = await this.deps.turnService.project(roomSessionId, completed.id);
						if (projection.event) {
							this.deps.bus?.publish(roomSessionId, { type: "room_event", event: projection.event });
							await this.recordActivity(roomSessionId, projection.event);
						}
						this.deps.bus?.publish(roomSessionId, { type: "participant_turn", turn: publicTurn(projection.turn) });
						return true;
					});
					if (finished) return;
				}
			}
			if (result.status === "cancelled") {
				const cancelled = await this.deps.turnService.cancel(roomSessionId, turnId, result.terminalReason ?? "用户取消", result.finalContent);
				const projection = await this.deps.turnService.project(roomSessionId, cancelled.id);
				if (projection.event) {
					this.deps.bus?.publish(roomSessionId, { type: "room_event", event: projection.event });
					await this.recordActivity(roomSessionId, projection.event);
				}
				this.deps.bus?.publish(roomSessionId, { type: "participant_turn", turn: publicTurn(projection.turn) });
				return;
			}
			const failed = await this.deps.turnService.fail(
				roomSessionId,
				turnId,
				result.terminalReason ?? (result.status === "completed" ? "模型没有返回可发布的最终文本" : "执行失败"),
				result.finalContent,
			);
			const projection = await this.deps.turnService.project(roomSessionId, failed.id);
			if (projection.event) {
				this.deps.bus?.publish(roomSessionId, { type: "room_event", event: projection.event });
				await this.recordActivity(roomSessionId, projection.event);
			}
			this.deps.bus?.publish(roomSessionId, { type: "participant_turn", turn: publicTurn(projection.turn) });
		})().finally(() => {
			if (this.executions.get(key) === run) this.executions.delete(key);
		});
		this.executions.set(key, run);
		void run.catch(() => undefined);
		return run;
	}

	/** 等待某个 Turn 的后台执行结束（测试/内部对账用）。 */
	async waitForTurn(roomSessionId: string, turnId: string): Promise<ParticipantTurn | undefined> {
		const running = this.executions.get(this.executionKey(roomSessionId, turnId));
		if (running) await running;
		return this.deps.turns.get(roomSessionId, turnId);
	}

	async closeUnknown(roomSessionId: string, turnId: string, reason: string): Promise<ProjectionResult> {
		const closed = await this.deps.turnService.closeUnknown(roomSessionId, turnId, reason);
		if (closed.projection.event) await this.recordActivity(roomSessionId, closed.projection.event);
		return closed.projection;
	}

	/** 最小房间时间线：公共事件 + 回合；不含任何私有执行记录。 */
	async timeline(roomSessionId: string): Promise<{ events: RoomEvent[]; turns: ParticipantTurn[]; activeTurn?: ParticipantTurn }> {
		const [events, turns] = await Promise.all([
			this.deps.events.read(roomSessionId),
			this.deps.turns.list(roomSessionId),
		]);
		const activeTurn = turns.find((turn) => ACTIVE_STATUSES.has(turn.status));
		return { events, turns, ...(activeTurn ? { activeTurn } : {}) };
	}
}
