import { MANAGER_AGENT_NAME, type TeamsStore } from "../store/teams.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type { AgentInvoker } from "../agent-runtime/invoker.js";
import { RoomEventStore } from "./room-event-store.js";
import { ParticipantTurnStore } from "./participant-turn-store.js";
import { RoomOperationStore } from "./room-operation-store.js";
import { RoomTurnService } from "./room-turn-service.js";
import { RoomMessageRouter, type RoomParticipantRunner, type RoomParticipantRunnerInput, type RoomParticipantRunnerResult } from "./room-message-router.js";
import { PiParticipantRunner, DirectChatParticipantRunner } from "./participant-runners.js";
import { TeamsParticipantBindingPort } from "./teams-binding-port.js";

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
}): RoomRuntime {
	const events = new RoomEventStore(input.root, { attachmentRoot: undefined });
	const turns = new ParticipantTurnStore(input.root);
	const operations = new RoomOperationStore(input.root);
	const bindings = new TeamsParticipantBindingPort(input.teams);
	const turnService = new RoomTurnService({ events, turns, bindings });
	const runner = input.runner ?? new ConnectorParticipantRunner({
		teams: input.teams,
		pi: new PiParticipantRunner({ sessions: input.sessions }),
		direct: input.invoker ? new DirectChatParticipantRunner({ invoker: input.invoker }) : undefined,
	});
	const router = new RoomMessageRouter({
		events,
		turns,
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
			if (!context) throw new Error(`RoomSession 不存在: ${roomSessionId}`);
			const agent = await input.teams.getAgent(agentId);
			if (!agent) throw new Error(`agent not found: ${agentId}`);
			if (agent.enabled === false) throw new Error(`agent disabled: ${agentId}`);
			const created = await input.sessions.create(undefined, {
				type: "group",
				members: context.window.members,
				prompt: context.window.prompt,
				workspaceId: context.window.workspaceId,
				cwd: context.window.cwdSnapshot,
			}, undefined, { ownerAgentId: agentId });
			try {
				const ensured = await bindings.ensure({
					roomId: context.window.id,
					roomSessionId,
					agentId,
					role: agentId === MANAGER_AGENT_NAME ? "manager" : "worker",
					agentSessionId: created.id,
					...(context.window.workspaceId ? { workspaceId: context.window.workspaceId } : {}),
					cwdSnapshot: context.window.cwdSnapshot,
				});
				return ensured.binding;
			} catch (error) {
				await input.sessions.remove(created.id).catch(() => undefined);
				throw error;
			}
		},
	});
	return { router, events, turns, operations, bindings };
}
