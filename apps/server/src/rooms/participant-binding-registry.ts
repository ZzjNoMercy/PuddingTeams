/**
 * ParticipantBinding 的存储端口（方案 §17.2/§18.1）。
 *
 * P0-A 只用内存实现验证语义；P0-B 由 windows v4 的 participantSessions
 * 实现同一端口，服务层不感知持久位置。
 */

export type ParticipantBindingState = "active" | "retired" | "tombstoned";

export interface ParticipantBinding {
	agentSessionId: string;
	roomId: string;
	roomSessionId: string;
	agentId: string;
	role: "manager" | "worker";
	state: ParticipantBindingState;
	workspaceId?: string;
	cwdSnapshot: string;
	lastRoomEntryId?: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	retiredAt?: string;
	retireReason?: "configuration_changed" | "room_session_deleted";
}

export class ParticipantBindingConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ParticipantBindingConflictError";
	}
}

export class ParticipantBindingRevisionConflictError extends Error {
	constructor(readonly expected: number, readonly actual: number) {
		super(`participant binding revision conflict: expected ${expected}, actual ${actual}`);
		this.name = "ParticipantBindingRevisionConflictError";
	}
}

export interface ensureParticipantBindingInput {
	roomId: string;
	roomSessionId: string;
	agentId: string;
	role: "manager" | "worker";
	agentSessionId: string;
	workspaceId?: string;
	cwdSnapshot: string;
}

export interface ParticipantBindingPort {
	get(roomSessionId: string, agentId: string): Promise<ParticipantBinding | undefined>;
	findActiveBySession(roomSessionId: string, agentSessionId: string): Promise<ParticipantBinding | undefined>;
	ensure(input: ensureParticipantBindingInput): Promise<{ binding: ParticipantBinding; created: boolean }>;
	/** CAS：只有 revision 未漂移时才把水位推进到 eventId。 */
	advanceWatermark(roomSessionId: string, agentId: string, expectedRevision: number, eventId: string): Promise<ParticipantBinding>;
	retire(roomSessionId: string, agentId: string, reason: "configuration_changed" | "room_session_deleted", at?: string): Promise<ParticipantBinding>;
}

/** P0-A 内存实现；不用于生产持久化。按 agentSessionId 保留 retired 审计。 */
export class InMemoryParticipantBindingRegistry implements ParticipantBindingPort {
	private readonly byRoom = new Map<string, Map<string, ParticipantBinding>>();

	private room(roomSessionId: string): Map<string, ParticipantBinding> {
		let room = this.byRoom.get(roomSessionId);
		if (!room) { room = new Map(); this.byRoom.set(roomSessionId, room); }
		return room;
	}

	private activeFor(roomSessionId: string, agentId: string): ParticipantBinding | undefined {
		for (const binding of this.room(roomSessionId).values()) {
			if (binding.state === "active" && binding.agentId === agentId) return binding;
		}
		return undefined;
	}

	async get(roomSessionId: string, agentId: string): Promise<ParticipantBinding | undefined> {
		const binding = this.activeFor(roomSessionId, agentId);
		return binding ? { ...binding } : undefined;
	}

	async findActiveBySession(roomSessionId: string, agentSessionId: string): Promise<ParticipantBinding | undefined> {
		const binding = this.room(roomSessionId).get(agentSessionId);
		return binding?.state === "active" ? { ...binding } : undefined;
	}

	async ensure(input: ensureParticipantBindingInput): Promise<{ binding: ParticipantBinding; created: boolean }> {
		const room = this.room(input.roomSessionId);
		const existing = this.activeFor(input.roomSessionId, input.agentId);
		if (existing) {
			if (existing.agentSessionId !== input.agentSessionId) {
				throw new ParticipantBindingConflictError(`agent ${input.agentId} 已有另一 active binding`);
			}
			return { binding: { ...existing }, created: false };
		}
		const now = new Date().toISOString();
		const binding: ParticipantBinding = {
			agentSessionId: input.agentSessionId,
			roomId: input.roomId,
			roomSessionId: input.roomSessionId,
			agentId: input.agentId,
			role: input.role,
			state: "active",
			...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
			cwdSnapshot: input.cwdSnapshot,
			revision: 1,
			createdAt: now,
			updatedAt: now,
		};
		if (room.has(input.agentSessionId)) throw new ParticipantBindingConflictError(`agentSessionId 已存在: ${input.agentSessionId}`);
		room.set(input.agentSessionId, binding);
		return { binding: { ...binding }, created: true };
	}

	async advanceWatermark(roomSessionId: string, agentId: string, expectedRevision: number, eventId: string): Promise<ParticipantBinding> {
		const binding = this.activeFor(roomSessionId, agentId);
		if (!binding) throw new ParticipantBindingConflictError(`agent ${agentId} 没有 active binding`);
		if (binding.revision !== expectedRevision) throw new ParticipantBindingRevisionConflictError(expectedRevision, binding.revision);
		binding.lastRoomEntryId = eventId;
		binding.revision += 1;
		binding.updatedAt = new Date().toISOString();
		return { ...binding };
	}

	async retire(roomSessionId: string, agentId: string, reason: "configuration_changed" | "room_session_deleted", at?: string): Promise<ParticipantBinding> {
		const binding = this.activeFor(roomSessionId, agentId);
		if (!binding) throw new ParticipantBindingConflictError(`agent ${agentId} 没有 active binding`);
		binding.state = reason === "room_session_deleted" ? "tombstoned" : "retired";
		binding.revision += 1;
		binding.retireReason = reason;
		binding.retiredAt = at ?? new Date().toISOString();
		binding.updatedAt = binding.retiredAt;
		return { ...binding };
	}
}
