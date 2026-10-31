import type { RoomEvent } from "./room-event-store.js";
import type { ParticipantTurn } from "./participant-turn-store.js";

/** 房间实时事件的最小进程内总线；WS 层订阅，不承载持久事实。 */
export type RoomLiveEvent =
	| { type: "room_event"; event: RoomEvent }
	| { type: "participant_turn"; turn: PublicTurn }
	| { type: "execution_projection"; projectionId: string };

export type PublicTurn = Pick<ParticipantTurn, "id" | "agentSessionId" | "sourceRoomEventId" | "status" | "publicProjectionState" | "createdAt" | "updatedAt"> & { finalContent?: string };

export function publicTurn(turn: ParticipantTurn): PublicTurn {
	return {
		id: turn.id,
		agentSessionId: turn.agentSessionId,
		sourceRoomEventId: turn.sourceRoomEventId,
		status: turn.status,
		publicProjectionState: turn.publicProjectionState,
		...(turn.finalContent ? { finalContent: turn.finalContent } : {}),
		createdAt: turn.createdAt,
		updatedAt: turn.updatedAt,
	};
}

export class RoomEventBus {
	private readonly subscribers = new Map<string, Set<(event: RoomLiveEvent) => void>>();

	subscribe(roomSessionId: string, listener: (event: RoomLiveEvent) => void): () => void {
		let set = this.subscribers.get(roomSessionId);
		if (!set) { set = new Set(); this.subscribers.set(roomSessionId, set); }
		set.add(listener);
		return () => {
			const current = this.subscribers.get(roomSessionId);
			current?.delete(listener);
			if (current?.size === 0) this.subscribers.delete(roomSessionId);
		};
	}

	publish(roomSessionId: string, event: RoomLiveEvent): void {
		for (const listener of this.subscribers.get(roomSessionId) ?? []) {
			try { listener(event); } catch { /* subscriber failures must not break the turn */ }
		}
	}
}
