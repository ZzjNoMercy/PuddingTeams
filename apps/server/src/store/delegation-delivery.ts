import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface DelegationDeliveryRecord {
	eventId: string; delegationId: string; ownerSessionId: string; toolCallId?: string; receiptId: string;
	kind?: "tool_result" | "terminal_event";
	state: "pending" | "deferred" | "appended" | "wake_requested" | "observed" | "gone";
	attempts: number; lastError?: string;
}

/** Only delivery facts live here; results and receipts remain Runtime authority. */
export class DelegationDeliveryStore {
	private queue: Promise<unknown> = Promise.resolve();
	constructor(private readonly file: string) {}
	async list(): Promise<DelegationDeliveryRecord[]> {
		try {
			const data = JSON.parse(await readFile(this.file, "utf8"));
			if (data.version !== 1 || !Array.isArray(data.deliveries)) throw new Error("invalid delegation delivery ledger");
			return data.deliveries;
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
	}
	async put(record: DelegationDeliveryRecord): Promise<void> {
		const pending = this.queue.then(async () => {
			const all = await this.list();
			const index = all.findIndex(item => item.eventId === record.eventId);
			if (index < 0) all.push(record); else all[index] = record;
			const dir = path.dirname(this.file); await mkdir(dir, { recursive: true });
			const temp = `${this.file}.${randomUUID()}.tmp`;
			const handle = await open(temp, "wx", 0o600);
			try { await handle.writeFile(JSON.stringify({ version: 1, deliveries: all }) + "\n"); await handle.sync(); } finally { await handle.close(); }
			await rename(temp, this.file);
			const directory = await open(dir, "r"); try { await directory.sync(); } finally { await directory.close(); }
		});
		this.queue = pending.catch(() => undefined); await pending;
	}
}
