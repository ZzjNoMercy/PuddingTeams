import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TeamsStore } from "../store/teams.js";
import { RoomEventStore, RoomSessionNotFoundError } from "./room-event-store.js";
import { RoomOperationStore, RoomOperationRecoveryRequiredError, type RoomCreationPhase } from "./room-operation-store.js";

/**
 * RoomSession 创建账本启动对账（方案 §18.4 step 2、§21.1）。
 *
 * 目标：
 * - 已提交的 RoomSession + Manager binding：补齐 ledger 到 attached；
 * - 只有账本/空事件文件且无房间归属：清理精确孤儿；
 * - 已有公共事件或归属不明：保留现场并标记 recovery_required，不自动删除。
 */

const PHASES: RoomCreationPhase[] = ["reserved", "event_file_created", "manager_created", "manager_bound", "attached"];
const SAFE_ROOM = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

export interface RoomCreationReconcileResult {
	kept: number;
	removed: number;
	recoveryRequired: Array<{ roomSessionId: string; reason: string }>;
}

export interface RoomCreationReconcilerDeps {
	root: string;
	events: RoomEventStore;
	operations: RoomOperationStore;
	teams: Pick<TeamsStore, "listWindows" | "roomSession" | "participantSession" | "managerSessionForRoom">;
	sessionExists: (agentSessionId: string) => Promise<boolean>;
	removeSession: (agentSessionId: string) => Promise<unknown>;
	log?: (message: string) => void;
}

export class RoomCreationReconciler {
	constructor(private readonly deps: RoomCreationReconcilerDeps) {}

	private async knownRoomSessionIds(): Promise<Set<string>> {
		const ids = new Set<string>();
		for (const window of await this.deps.teams.listWindows()) {
			if (window.type !== "group") continue;
			for (const id of window.roomSessionIds ?? []) ids.add(id);
		}
		return ids;
	}

	private async roomDirectories(): Promise<string[]> {
		let names: string[];
		try { names = await readdir(this.deps.root); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const rooms: string[] = [];
		for (const name of names) {
			if (!SAFE_ROOM.test(name) || name.startsWith(".")) continue;
			try { if ((await stat(path.join(this.deps.root, name))).isDirectory()) rooms.push(name); }
			catch { /* 并发删除忽略 */ }
		}
		return rooms;
	}

	async reconcile(): Promise<RoomCreationReconcileResult> {
		const result: RoomCreationReconcileResult = { kept: 0, removed: 0, recoveryRequired: [] };
		const ids = await this.knownRoomSessionIds();
		for (const roomSessionId of await this.roomDirectories()) ids.add(roomSessionId);
		for (const roomSessionId of ids) {
			try {
				await this.reconcileOne(roomSessionId, result);
				if (!result.recoveryRequired.some((item) => item.roomSessionId === roomSessionId)) {
					await this.clearRecoveryMarker(roomSessionId);
				}
			} catch (error) {
				// 单个房间损坏只隔离该房间，不能阻断启动。
				result.recoveryRequired.push({ roomSessionId, reason: error instanceof Error ? error.message : String(error) });
			}
		}
		for (const item of result.recoveryRequired) await this.writeRecoveryMarker(item.roomSessionId, item.reason).catch(() => undefined);
		return result;
	}

	private recoveryPath(roomSessionId: string): string {
		return path.join(this.deps.root, roomSessionId, "recovery.json");
	}

	async recoveryReason(roomSessionId: string): Promise<string | undefined> {
		try {
			const parsed = JSON.parse(await readFile(this.recoveryPath(roomSessionId), "utf8")) as { reason?: unknown };
			return typeof parsed.reason === "string" ? parsed.reason : undefined;
		} catch { return undefined; }
	}

	private async writeRecoveryMarker(roomSessionId: string, reason: string): Promise<void> {
		await mkdir(path.join(this.deps.root, roomSessionId), { recursive: true, mode: 0o700 });
		await writeFile(this.recoveryPath(roomSessionId), JSON.stringify({ roomSessionId, reason, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
	}

	private async clearRecoveryMarker(roomSessionId: string): Promise<void> {
		await rm(this.recoveryPath(roomSessionId), { force: true });
	}

	private async reconcileOne(roomSessionId: string, result: RoomCreationReconcileResult): Promise<void> {
		const room = await this.deps.teams.roomSession(roomSessionId);
		let operations;
		try { operations = await this.deps.operations.listCreation(roomSessionId); }
		catch (error) {
			if (error instanceof RoomOperationRecoveryRequiredError) {
				// 还有窗口引用时不能删，交人工核对。
				if (room) result.recoveryRequired.push({ roomSessionId, reason: error.message });
				else {
					const kept = await this.cleanRoomDirectory(roomSessionId);
					if (kept) result.recoveryRequired.push({ roomSessionId, reason: error.message });
					else result.removed += 1;
				}
				return;
			}
			throw error;
		}
		if (room) {
			const manager = await this.deps.teams.managerSessionForRoom(roomSessionId);
			if (!manager || !(await this.deps.teams.participantSession(manager))) {
				result.recoveryRequired.push({ roomSessionId, reason: "RoomSession 缺少 Manager binding" });
				return;
			}
			await this.ensureAttached(roomSessionId, manager, operations[0]);
			result.kept += 1;
			return;
		}
		if (!operations.length) return;
		// 没有窗口归属：空事件文件才可以清理；有公共事件则保留现场。
		try {
			const events = await this.deps.events.read(roomSessionId);
			if (events.length > 0) {
				result.recoveryRequired.push({ roomSessionId, reason: "无房间归属但已有公共事件" });
				return;
			}
		} catch (error) {
			if (!(error instanceof RoomSessionNotFoundError)) {
				result.recoveryRequired.push({ roomSessionId, reason: error instanceof Error ? error.message : String(error) });
				return;
			}
		}
		const manager = operations[0]!.managerAgentSessionId;
		if (manager && await this.deps.sessionExists(manager)) {
			result.recoveryRequired.push({ roomSessionId, reason: "无房间归属但预留 Manager Session 已存在" });
			return;
		}
		if (manager) {
			try { await this.deps.removeSession(manager); }
			catch (error) {
				result.recoveryRequired.push({ roomSessionId, reason: `清理预留 Manager Session 失败：${error instanceof Error ? error.message : String(error)}` });
				return;
			}
		}
		try { await this.deps.events.remove(roomSessionId); }
		catch (error) {
			result.recoveryRequired.push({ roomSessionId, reason: `清理 RoomSession 目录失败：${error instanceof Error ? error.message : String(error)}` });
			return;
		}
		this.deps.log?.(`room creation reconcile: removed orphan ${roomSessionId}`);
		result.removed += 1;
	}

	private async cleanRoomDirectory(roomSessionId: string): Promise<boolean> {
		try {
			const events = await this.deps.events.read(roomSessionId);
			if (events.length > 0) return true;
		} catch (error) {
			if (!(error instanceof RoomSessionNotFoundError)) return true;
		}
		await this.deps.events.remove(roomSessionId).catch(() => undefined);
		return false;
	}

	private async ensureAttached(roomSessionId: string, managerAgentSessionId: string, operation: { key: string; phase: RoomCreationPhase } | undefined): Promise<void> {
		await this.deps.events.create(roomSessionId);
		let key: string;
		let index: number;
		if (operation) {
			key = operation.key;
			index = PHASES.indexOf(operation.phase);
		} else {
			key = `recovered-${roomSessionId}`;
			index = -1;
			await this.deps.operations.reserveCreation(roomSessionId, { key, requestHash: `recovered-${roomSessionId}`, managerAgentSessionId });
		}
		for (let next = index + 1; next < PHASES.length; next += 1) {
			await this.deps.operations.advanceCreation(roomSessionId, key, PHASES[next]!);
		}
	}
}
