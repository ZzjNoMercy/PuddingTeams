import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface RoomFanoutPlan {
	operationId: string;
	roomSessionId: string;
	sourceEventId: string;
	targetAgentIds: string[];
	nextIndex: number;
	createdAt: string;
}

/** 多 @ fanout 的持久化计划：崩溃后至少能显式收尾剩余目标。 */
export class RoomFanoutStore {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly file: string) {}

	private async read(): Promise<Record<string, RoomFanoutPlan>> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf8")) as { version?: unknown; plans?: unknown };
			if (parsed.version !== 1 || !parsed.plans || typeof parsed.plans !== "object" || Array.isArray(parsed.plans)) throw new Error("invalid room fanout plans");
			return parsed.plans as Record<string, RoomFanoutPlan>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}

	private async write(plans: Record<string, RoomFanoutPlan>): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
		const temp = `${this.file}.${randomUUID()}.tmp`;
		await writeFile(temp, JSON.stringify({ version: 1, plans }) + "\n", { mode: 0o600 });
		const handle = await open(temp, "r");
		try { await handle.sync(); } finally { await handle.close(); }
		await rename(temp, this.file);
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.queue.then(operation, operation);
		this.queue = next.then(() => undefined, () => undefined);
		return next;
	}

	async list(): Promise<RoomFanoutPlan[]> {
		return Object.values(await this.read());
	}

	async put(plan: RoomFanoutPlan): Promise<void> {
		await this.serialize(async () => {
			const plans = await this.read();
			plans[plan.operationId] = plan;
			await this.write(plans);
		});
	}

	async advance(operationId: string, nextIndex: number): Promise<void> {
		await this.serialize(async () => {
			const plans = await this.read();
			const plan = plans[operationId];
			if (!plan) return;
			plan.nextIndex = Math.max(plan.nextIndex, nextIndex);
			await this.write(plans);
		});
	}

	async remove(operationId: string): Promise<void> {
		await this.serialize(async () => {
			const plans = await this.read();
			if (!plans[operationId]) return;
			delete plans[operationId];
			await this.write(plans);
		});
	}
}
