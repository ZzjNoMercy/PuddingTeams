import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { WorkerActivity } from "./types.js";
import { redactValue } from "./redaction.js";

export interface DelegationTimelineEvent extends WorkerActivity {
	id: string;
	delegationId: string;
	seq: number;
	timestamp: string;
}

type TimelineListener = (event: DelegationTimelineEvent) => void;

function redactActivity(activity: WorkerActivity): WorkerActivity {
	return redactValue(activity);
}

/**
 * Append-only, delegation-scoped worker activity log.
 *
 * One JSONL file per delegation keeps high-frequency CLI events out of the
 * delegation metadata snapshot. Per-delegation serialization assigns a stable
 * local sequence and makes history + live subscription race-free.
 */
export class DelegationTimelineStore {
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly nextSeq = new Map<string, number>();
	private readonly listeners = new Map<string, Set<TimelineListener>>();

	constructor(private readonly rootDir: string) {}

	async init(): Promise<void> {
		await mkdir(this.rootDir, { recursive: true });
	}

	private fileFor(delegationId: string): string {
		if (!/^[A-Za-z0-9._-]+$/.test(delegationId)) throw new Error("invalid delegation id");
		return path.join(this.rootDir, `${delegationId}.jsonl`);
	}

	private serialize<T>(delegationId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(delegationId) ?? Promise.resolve();
		const run = previous.then(fn, fn);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.queues.set(delegationId, tail);
		void tail.finally(() => {
			if (this.queues.get(delegationId) === tail) this.queues.delete(delegationId);
		});
		return run;
	}

	private async readUnlocked(delegationId: string, afterSeq = 0): Promise<DelegationTimelineEvent[]> {
		let raw: string;
		try {
			raw = await readFile(this.fileFor(delegationId), "utf-8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
		const events: DelegationTimelineEvent[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as DelegationTimelineEvent;
				if (typeof event.seq === "number" && event.seq > afterSeq) events.push(event);
			} catch {
				// A torn final line must not make the otherwise valid timeline unreadable.
			}
		}
		return events.sort((a, b) => a.seq - b.seq);
	}

	async append(delegationId: string, activity: WorkerActivity): Promise<DelegationTimelineEvent> {
		return this.serialize(delegationId, async () => {
			let seq = this.nextSeq.get(delegationId);
			if (seq === undefined) {
				const existing = await this.readUnlocked(delegationId);
				seq = existing.at(-1)?.seq ?? 0;
			}
			seq += 1;
			this.nextSeq.set(delegationId, seq);
			const event: DelegationTimelineEvent = {
				...redactActivity(activity),
				id: `${delegationId}:${seq}`,
				delegationId,
				seq,
				timestamp: new Date().toISOString(),
			};
			await mkdir(this.rootDir, { recursive: true });
			await appendFile(this.fileFor(delegationId), `${JSON.stringify(event)}\n`, { encoding: "utf-8", mode: 0o600 });
			for (const listener of this.listeners.get(delegationId) ?? []) listener(event);
			return event;
		});
	}

	async list(delegationId: string, afterSeq = 0): Promise<DelegationTimelineEvent[]> {
		return this.serialize(delegationId, () => this.readUnlocked(delegationId, afterSeq));
	}

	/** Atomically capture retained events and subscribe before later appends. */
	async subscribeFrom(
		delegationId: string,
		afterSeq: number,
		listener: TimelineListener,
	): Promise<{ events: DelegationTimelineEvent[]; unsubscribe: () => void }> {
		return this.serialize(delegationId, async () => {
			const listeners = this.listeners.get(delegationId) ?? new Set<TimelineListener>();
			listeners.add(listener);
			this.listeners.set(delegationId, listeners);
			return {
				events: await this.readUnlocked(delegationId, afterSeq),
				unsubscribe: () => {
					const current = this.listeners.get(delegationId);
					current?.delete(listener);
					if (current?.size === 0) this.listeners.delete(delegationId);
				},
			};
		});
	}
}
