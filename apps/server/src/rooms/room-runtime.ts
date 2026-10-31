import { randomUUID } from "node:crypto";
import { MANAGER_AGENT_NAME, agentRunConfigRevision, type TeamsStore } from "../store/teams.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type { AgentInvoker } from "../agent-runtime/invoker.js";
import { RoomEventStore } from "./room-event-store.js";
import { ParticipantTurnStore } from "./participant-turn-store.js";
import { RoomOperationStore } from "./room-operation-store.js";
import { RoomTurnService } from "./room-turn-service.js";
import { RoomMessageError, RoomMessageRouter, type RoomParticipantRunner, type RoomParticipantRunnerInput, type RoomParticipantRunnerResult } from "./room-message-router.js";
import { PiParticipantRunner, DirectChatParticipantRunner } from "./participant-runners.js";
import { TeamsParticipantBindingPort } from "./teams-binding-port.js";
import { RoomEventBus } from "./room-event-bus.js";
import { publicTurn } from "./room-event-bus.js";

/**
 * 宿主装配：把 v4 房间账本、Pi/非 Pi runner 和 teams binding 端口接到
 * RoomMessageRouter。HTTP/WS 只依赖这个 runtime。
 */

export interface RoomRuntime {
	router: RoomMessageRouter;
	events: RoomEventStore;
	turns: ParticipantTurnStore;
	operations: RoomOperationStore;
	bindings: TeamsParticipantBindingPort;
	bus: RoomEventBus;
	abort(roomSessionId: string): Promise<{ turnId: string; status: string }>;
}

class ConnectorParticipantRunner implements RoomParticipantRunner {
	constructor(
		private readonly deps: {
			teams: Pick<TeamsStore, "getAgent">;
			pi: PiParticipantRunner;
			direct: DirectChatParticipantRunner | undefined;
		},
	) {}

	async run(input: RoomParticipantRunnerInput): Promise<RoomParticipantRunnerResult> {
		const agent = await this.deps.teams.getAgent(input.binding.agentId);
		if (!agent) return { status: "failed", terminalReason: `agent not found: ${input.binding.agentId}` };
		const pi = agent.invoke?.type === "pi" || agent.connector?.connectorId === "pi" || agent.pinned === true;
		if (pi) return this.deps.pi.run(input);
		if (!this.deps.direct) return { status: "failed", terminalReason: "非 Pi Worker 需要 AgentInvoker 才能执行" };
		return this.deps.direct.run(input);
	}
}

export function createRoomRuntime(input: {
	root: string;
	teams: TeamsStore;
	sessions: PiSessionStore;
	invoker?: AgentInvoker;
	/** 测试/宿主替换执行器。 */
	runner?: RoomParticipantRunner;
	maxContextChars?: number;
	attachmentRoot?: string;
}): RoomRuntime {
	const events = new RoomEventStore(input.root, { attachmentRoot: input.attachmentRoot });
	const turns = new ParticipantTurnStore(input.root);
	const operations = new RoomOperationStore(input.root);
	const bindings = new TeamsParticipantBindingPort(input.teams);
	const turnService = new RoomTurnService({ events, turns, bindings });
	const bus = new RoomEventBus();
	const runner = input.runner ?? new ConnectorParticipantRunner({
		teams: input.teams,
		pi: new PiParticipantRunner({ sessions: input.sessions }),
		direct: input.invoker ? new DirectChatParticipantRunner({
			invoker: input.invoker,
			handleFor: (binding) => input.teams.participantProviderHandle(binding.agentSessionId),
			rememberHandle: async (binding, agent, handle) => {
				await input.teams.setParticipantProviderHandle(binding.agentSessionId, {
					driverId: agent.connector?.connectorId ?? (agent.invoke?.type === "command" ? "command" : "legacy"),
					agentRevision: agentRunConfigRevision(agent),
					providerSessionHandle: handle,
				});
			},
		}) : undefined,
	});
	const router = new RoomMessageRouter({
		events,
		turns,
		bus,
		bindings,
		turnService,
		operations,
		runner,
		managerAgentId: MANAGER_AGENT_NAME,
		budget: {
			maxChars: input.maxContextChars ?? 200_000,
			agentInstructionChars: 20_000,
			reservedOutputChars: 32_000,
		},
		ensureParticipant: async (roomSessionId, agentId) => {
			const existing = await bindings.get(roomSessionId, agentId);
			if (existing) return existing;
			const context = await input.teams.contextForRoomSession(roomSessionId);
			if (!context) throw new RoomMessageError("participant_unavailable", `RoomSession 不存在: ${roomSessionId}`);
			const agent = await input.teams.getAgent(agentId);
			if (!agent || agent.enabled === false) throw new RoomMessageError("participant_unavailable", `agent 不可用: ${agentId}`);
			if (agentId === MANAGER_AGENT_NAME) {
				// Manager PS 必须在建房事务中创建；缺失属于 recovery，不能懒建第二个。
				throw new RoomMessageError("participant_binding_required", `RoomSession 缺少 Manager binding: ${roomSessionId}`);
			}
			if (!context.window.members.includes(agentId)) throw new RoomMessageError("participant_unavailable", `agent 不是当前房间成员: ${agentId}`);
			const agentSessionId = randomUUID();
			const created = await input.sessions.create(undefined, {
				type: "group",
				members: context.window.members,
				prompt: context.window.prompt,
				workspaceId: context.window.workspaceId,
				cwd: context.window.cwdSnapshot,
			}, agentSessionId, { ownerAgentId: agentId });
			try {
				const ensured = await bindings.ensure({
					roomId: context.window.id,
					roomSessionId,
					agentId,
					role: "worker",
					agentSessionId: created.id,
					...(context.window.workspaceId ? { workspaceId: context.window.workspaceId } : {}),
					cwdSnapshot: context.window.cwdSnapshot,
				});
				return ensured.binding;
			} catch (error) {
				await input.sessions.remove(created.id).catch(() => undefined);
				throw error instanceof RoomMessageError ? error
					: new RoomMessageError("participant_unavailable", error instanceof Error ? error.message : String(error));
			}
		},
	});
	const runtime: RoomRuntime = {
		router, events, turns, operations, bindings, bus,
		abort: async (roomSessionId) => {
			const active = (await turns.list(roomSessionId)).find((turn) =>
				["admitted", "running", "waiting_input", "reconciling", "unknown"].includes(turn.status));
			if (!active) throw new Error("房间没有进行中的公开回合");
			if (active.execution?.kind === "direct_chat" && input.invoker) {
				await input.invoker.cancel(active.execution.delegationId);
			} else {
				await input.sessions.abort(active.agentSessionId).catch(() => undefined);
			}
			const cancelled = await turnService.cancel(roomSessionId, active.id, "用户停止");
			const projection = await turnService.project(roomSessionId, cancelled.id);
			if (projection.event) bus.publish(roomSessionId, { type: "room_event", event: projection.event });
			bus.publish(roomSessionId, { type: "participant_turn", turn: publicTurn(projection.turn) });
			return { turnId: cancelled.id, status: cancelled.status };
		},
	};
	return runtime;
}
