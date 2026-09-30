import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { assertCustomProviderCatalogWritable, CustomProviderConflictError, CustomProviderDurabilityError, deleteCustomProvider, listCustomProvidersSnapshot, type CustomProviderRecord } from "./custom-providers.js";

export interface ProviderCredentialPort {
	snapshotProviderCredential(id: string): Promise<unknown>;
	removeProviderKey(id: string): Promise<void>;
	restoreProviderCredential(id: string, credential: unknown): Promise<void>;
}

interface Journal {
	version: 1;
	id: string;
	expectedRevision: string;
	provider: CustomProviderRecord;
	credential?: unknown;
	phase: "reserved" | "removing-key";
}

export class ProviderRecoveryRequiredError extends Error {
	constructor(message = "Provider 删除状态需启动恢复，当前配置写入已封锁") {
		super(message);
		this.name = "ProviderRecoveryRequiredError";
	}
}

/** Durable intent before changing platform auth.json and shared pi models.json. */
export class ProviderDeletionCoordinator {
	private queue: Promise<void> = Promise.resolve();
	private uncertain = false;
	constructor(
		private readonly file: string,
		private readonly credentials: ProviderCredentialPort,
		private readonly afterCatalogCommit?: () => Promise<void>,
	) {}

	private async syncDirectory(): Promise<void> {
		const dir = await open(path.dirname(this.file), "r");
		try { await dir.sync(); }
		finally { await dir.close(); }
	}

	private async write(record: Journal): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		const temp = `${this.file}.${randomUUID()}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let renamed = false;
		try {
			handle = await open(temp, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(record)}\n`);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temp, this.file);
			renamed = true;
			await this.syncDirectory();
		} catch (error) {
			if (renamed) this.uncertain = true;
			await handle?.close().catch(() => undefined);
			await unlink(temp).catch(() => undefined);
			throw error;
		}
	}

	private async read(): Promise<Journal | null> {
		let raw: string;
		try { raw = await readFile(this.file, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderRecoveryRequiredError("Provider 删除日志结构无效，需人工核对");
		const record = value as Partial<Journal>;
		if (record.version !== 1 || typeof record.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(record.id) ||
			typeof record.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(record.expectedRevision) ||
			!record.provider || record.provider.id !== record.id ||
			(record.phase !== "reserved" && record.phase !== "removing-key")) {
			throw new ProviderRecoveryRequiredError("Provider 删除日志内容无效，需人工核对");
		}
		return record as Journal;
	}

	private async clear(): Promise<void> {
		try { await unlink(this.file); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		try { await this.syncDirectory(); }
		catch (error) { this.uncertain = true; throw error; }
	}

	private async serial<T>(action: () => Promise<T>): Promise<T> {
		const run = this.queue.then(action, action);
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	/** Called before HTTP listen. An unresolved journal blocks startup. */
	async recover(): Promise<"none" | "restored" | "deleted"> {
		const record = await this.read();
		if (!record) { this.uncertain = false; return "none"; }
		const snapshot = await listCustomProvidersSnapshot();
		const current = snapshot.providers.find((provider) => provider.id === record.id);
		if (record.phase === "reserved") {
			await this.clear();
			this.uncertain = false;
			return "none";
		}
		if (current) {
			if (JSON.stringify(current) !== JSON.stringify(record.provider)) {
				throw new ProviderRecoveryRequiredError("待恢复 Provider 已被外部改动，不能自动恢复旧凭证");
			}
			await this.credentials.restoreProviderCredential(record.id, record.credential);
			await this.clear();
			this.uncertain = false;
			return "restored";
		}
		await this.credentials.removeProviderKey(record.id);
		await this.clear();
		this.uncertain = false;
		return "deleted";
	}

	async withMutation<T>(action: () => Promise<T>): Promise<T> {
		return this.serial(async () => {
			if (this.uncertain || await this.read()) throw new ProviderRecoveryRequiredError();
			assertCustomProviderCatalogWritable();
			return action();
		});
	}

	/** Caller holds withMutation; response may be 202 if journal cleanup is uncertain. */
	async delete(id: string, expectedRevision: string): Promise<{ deleted: boolean; recoveryPending: boolean }> {
		const snapshot = await listCustomProvidersSnapshot();
		if (snapshot.revision !== expectedRevision) throw new CustomProviderConflictError();
		const provider = snapshot.providers.find((entry) => entry.id === id);
		if (!provider) return { deleted: false, recoveryPending: false };
		const credential = await this.credentials.snapshotProviderCredential(id);
		const record: Journal = { version: 1, id, expectedRevision, provider, credential, phase: "reserved" };
		await this.write(record);
		try {
			const deleted = await deleteCustomProvider(id, expectedRevision, async () => {
				await this.write({ ...record, phase: "removing-key" });
				await this.credentials.removeProviderKey(id);
			});
			if (!deleted) throw new CustomProviderConflictError();
			await this.afterCatalogCommit?.();
		} catch (error) {
			if (error instanceof CustomProviderDurabilityError) {
				this.uncertain = true;
				throw new ProviderRecoveryRequiredError("Provider 目录提交持久性未确认，已封锁写入；请重启恢复");
			}
			try {
				const outcome = await this.recover();
				if (outcome === "deleted") return { deleted: true, recoveryPending: false };
			} catch (recoveryError) {
				this.uncertain = true;
				throw new ProviderRecoveryRequiredError(`Provider 删除失败且恢复未完成：${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
			}
			throw error;
		}
		try { await this.clear(); }
		catch { this.uncertain = true; return { deleted: true, recoveryPending: true }; }
		return { deleted: true, recoveryPending: false };
	}
}
