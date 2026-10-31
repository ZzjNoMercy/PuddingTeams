import type { TeamsStore } from "../store/teams.js";
import type { ParticipantSessionRefV4 } from "../store/windows-v4.js";
import {
	ParticipantBindingConflictError,
	ParticipantBindingRevisionConflictError,
	type ParticipantBinding,
	type ParticipantBindingPort,
	type ensureParticipantBindingInput,
} from "./participant-binding-registry.js";

/** windows v4 participantSessions 到 Room 服务端口的适配。 */
export function bindingFromRecord(record: ParticipantSessionRefV4): ParticipantBinding {
	return {
		agentSessionId: record.agentSessionId,
		roomId: record.roomId,
		roomSessionId: record.roomSessionId,
		agentId: record.agentId,
		role: record.role,
		state: record.state,
		...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
		cwdSnapshot: record.cwdSnapshot,
		...(record.lastRoomEntryId ? { lastRoomEntryId: record.lastRoomEntryId } : {}),
		revision: record.revision,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		...(record.retiredAt ? { retiredAt: record.retiredAt } : {}),
		...(record.retireReason ? { retireReason: record.retireReason } : {}),
	};
}

export class TeamsParticipantBindingPort implements ParticipantBindingPort {
	constructor(private readonly teams: TeamsStore) {}

	async get(roomSessionId: string, agentId: string): Promise<ParticipantBinding | undefined> {
		const participants = await this.teams.participantSessionsForRoom(roomSessionId);
		const record = participants.find((participant) => participant.state === "active" && participant.agentId === agentId);
		return record ? bindingFromRecord(record) : undefined;
	}

	async findActiveBySession(roomSessionId: string, agentSessionId: string): Promise<ParticipantBinding | undefined> {
		const record = await this.teams.participantSession(agentSessionId);
		if (!record || record.roomSessionId !== roomSessionId || record.state !== "active") return undefined;
		return bindingFromRecord(record);
	}

	async ensure(input: ensureParticipantBindingInput): Promise<{ binding: ParticipantBinding; created: boolean }> {
		const existing = await this.get(input.roomSessionId, input.agentId);
		if (existing) {
			if (existing.agentSessionId !== input.agentSessionId) throw new ParticipantBindingConflictError(`agent ${input.agentId} 已有另一 active binding`);
			return { binding: existing, created: false };
		}
		const room = await this.teams.roomSession(input.roomSessionId);
		if (!room) throw new ParticipantBindingConflictError(`RoomSession 不存在: ${input.roomSessionId}`);
		const record = await this.teams.addParticipantSession({
			windowId: room.roomId,
			roomSessionId: input.roomSessionId,
			agentSessionId: input.agentSessionId,
			agentId: input.agentId,
			role: input.role,
			...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
			cwdSnapshot: input.cwdSnapshot,
		});
		return { binding: bindingFromRecord(record), created: true };
	}

	async advanceWatermark(roomSessionId: string, agentId: string, expectedRevision: number, eventId: string): Promise<ParticipantBinding> {
		try {
			const record = await this.teams.advanceParticipantWatermark(roomSessionId, agentId, expectedRevision, eventId);
			return bindingFromRecord(record);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const match = /expected (\d+), actual (\d+)/.exec(message);
			if (match) throw new ParticipantBindingRevisionConflictError(Number(match[1]), Number(match[2]));
			throw new ParticipantBindingConflictError(message);
		}
	}

	async retire(roomSessionId: string, agentId: string, reason: "configuration_changed" | "room_session_deleted"): Promise<ParticipantBinding> {
		return bindingFromRecord(await this.teams.retireParticipantSession(roomSessionId, agentId, reason));
	}
}
