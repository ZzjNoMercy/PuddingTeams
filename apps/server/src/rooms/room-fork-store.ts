import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** RoomSession Fork 的幂等账本：operationKey → reserved/attached 目标。 */
export interface RoomForkOperation {
	key: string;
	sourceRoomSessionId: string;
	throughEventSeq: number;
	targetRoomSessionId: string;
	managerAgentSessionId: string;
	phase: "reserved" | "snapshot_saved" | "session_saved" | "attached";
	createdAt: string;
	updatedAt: string;
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const SAFE_ROOM = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

export class RoomForkStore {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly file: string) {}

	private async read(): Promise<Record<string, RoomForkOperation>> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as { version?: unknown; operations?: unknown };
			if (parsed.version !== 1 || !parsed.operations || typeof parsed.operations !== "object" || Array.isArray(parsed.operations)) {
				throw new Error("invalid room fork operations");
			}
			return parsed.operations as Record<string, RoomForkOperation>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}

	private async write(operations: Record<string, RoomForkOperation>): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
		const temp = `${this.file}.${randomUUID()}.tmp`;
		await writeFile(temp, JSON.stringify({ version: 1, operations }) + "\n", { mode: 0o600 });
		const handle = await open(temp, "r");
		try { await handle.sync(); } finally { await handle.close(); }
		await rename(temp, this.file);
		const directory = await open(path.dirname(this.file), "r");
		try { await directory.sync(); } finally { await directory.close(); }
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.then(operation, operation);
		this.queue = next.then(() => undefined, () => undefined);
		return next;
	}

	async get(key: string): Promise<RoomForkOperation | undefined> {
		if (!SAFE_KEY.test(key)) return undefined;
		return (await this.read())[key];
	}

	/** 同 key 已存在时返回旧记录（由调用方校验 source/cutoff）。 */
	async reserve(input: { key: string; sourceRoomSessionId: string; throughEventSeq: number; targetRoomSessionId: string; managerAgentSessionId: string }): Promise<{ operation: RoomForkOperation; created: boolean }> {
		if (!SAFE_KEY.test(input.key)) throw new Error("invalid fork operation key");
		if (!SAFE_ROOM.test(input.sourceRoomSessionId) || !SAFE_ROOM.test(input.targetRoomSessionId)) throw new Error("invalid room session id");
		return this.serialize(async () => {
			const operations = await this.read();
			const existing = operations[input.key];
			if (existing) return { operation: existing, created: false };
			const now = new Date().toISOString();
			const operation: RoomForkOperation = { ...input, phase: "reserved", createdAt: now, updatedAt: now };
			operations[input.key] = operation;
			await this.write(operations);
			return { operation, created: true };
		});
	}

	async list(): Promise<RoomForkOperation[]> {
		return Object.values(await this.read());
	}

	/** 只允许向前推进：reserved → snapshot_saved → session_saved → attached。 */
	async advance(key: string, phase: Exclude<RoomForkOperation["phase"], "reserved">): Promise<RoomForkOperation> {
		const order = ["reserved", "snapshot_saved", "session_saved", "attached"] as const;
		return this.serialize(async () => {
			const operations = await this.read();
			const operation = operations[key];
			if (!operation) throw new Error(`fork operation not found: ${key}`);
			if (order.indexOf(phase) < order.indexOf(operation.phase)) return operation;
			operation.phase = phase;
			operation.updatedAt = new Date().toISOString();
			operations[key] = operation;
			await this.write(operations);
			return operation;
		});
	}

	async markAttached(key: string): Promise<RoomForkOperation> {
		return this.advance(key, "attached");
	}

	async remove(key: string): Promise<void> {
		await this.serialize(async () => {
			const operations = await this.read();
			if (!operations[key]) return;
			delete operations[key];
			await this.write(operations);
		});
	}
}
