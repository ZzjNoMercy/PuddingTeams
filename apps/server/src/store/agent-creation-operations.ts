import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

export interface AgentCreationOperation {
	key: string;
	bodyHash: string;
	agentName: string;
	phase: "reserved" | "attached";
}

function validRecords(value: unknown): value is Record<string, AgentCreationOperation> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.entries(value).every(([key, raw]) => {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(key) || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
		const record = raw as Record<string, unknown>;
		return record.key === key && typeof record.bodyHash === "string" && /^[a-f0-9]{64}$/.test(record.bodyHash) &&
			typeof record.agentName === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(record.agentName) &&
			(record.phase === "reserved" || record.phase === "attached");
	});
}

export class AgentCreationOperationConflict extends Error {
	constructor(message: string, readonly code: "idempotency_conflict" | "agent_creation_uncertain" | "agent_creation_stale", readonly agentName?: string) {
		super(message);
		this.name = "AgentCreationOperationConflict";
	}
}

/** Reserve the generated Agent identity before writing agents.json. */
export class AgentCreationOperations {
	private queue: Promise<void> = Promise.resolve();
	constructor(private readonly file: string) {}

	private async transact<T>(action: (records: Record<string, AgentCreationOperation>) => Promise<{ value: T; save: boolean }>): Promise<T> {
		const run = this.queue.then(async () => {
			let records: Record<string, AgentCreationOperation> = Object.create(null) as Record<string, AgentCreationOperation>;
			try {
				const parsed: unknown = JSON.parse(await readFile(this.file, "utf8"));
				if (!validRecords(parsed)) throw new Error(`Agent 创建操作账本无效：${this.file}`);
				records = parsed;
			}
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			const result = await action(records);
			if (result.save) {
				await mkdir(path.dirname(this.file), { recursive: true });
				const temp = `${this.file}.${randomUUID()}.tmp`;
				await writeFile(temp, JSON.stringify(records) + "\n", { flag: "wx" });
				await rename(temp, this.file);
			}
			return result.value;
		});
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	async reserve(key: string, bodyHash: string, baseName: string, autoName: boolean, existingNames: readonly string[]): Promise<AgentCreationOperation> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(key)) throw new Error("Idempotency-Key 必须是 8–128 位字母、数字、点、下划线或连字符");
		if (!/^[a-f0-9]{64}$/.test(bodyHash)) throw new Error("Agent 创建内容摘要无效");
		return this.transact(async (records) => {
			const existing = Object.hasOwn(records, key) ? records[key] : undefined;
			if (existing) {
				if (existing.bodyHash !== bodyHash) throw new AgentCreationOperationConflict("同一 Idempotency-Key 被用于不同 Agent 创建请求", "idempotency_conflict");
				return { value: existing, save: false };
			}
			const taken = new Set([...existingNames, ...Object.values(records).map((record) => record.agentName)]);
			let agentName = baseName;
			if (autoName) {
				for (let index = 1; ; index += 1) {
					const suffix = index === 1 ? "" : `-${index}`;
					const stem = baseName.slice(0, Math.max(1, 32 - suffix.length)).replace(/[-_]+$/g, "") || "worker";
					const candidate = `${stem}${suffix}`;
					if (!taken.has(candidate)) { agentName = candidate; break; }
				}
			}
			const record: AgentCreationOperation = { key, bodyHash, agentName, phase: "reserved" };
			records[key] = record;
			return { value: record, save: true };
		});
	}

	async markAttached(key: string, agentName: string): Promise<void> {
		await this.transact(async (records) => {
			const record = Object.hasOwn(records, key) ? records[key] : undefined;
			if (!record || record.agentName !== agentName) throw new Error("Agent 创建操作不存在或身份不匹配");
			if (record.phase === "attached") return { value: undefined, save: false };
			record.phase = "attached";
			return { value: undefined, save: true };
		});
	}
}
