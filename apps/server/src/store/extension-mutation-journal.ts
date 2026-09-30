import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

interface PendingMutation {
	version: 1;
	agentIds: string[];
}

/**
 * Extension 目录与 agents.json 分属两个文件。变更前持久记录可能受影响的
 * Agent；重启时保守递增其执行修订号，避免目录已变而旧快照仍被接受。
 * 重复恢复允许多递增一次修订号，但绝不重用旧执行身份。
 */
export class ExtensionMutationJournal {
	constructor(private readonly file: string, private readonly label = "Extension") {}

	private async syncDirectory(): Promise<void> {
		const directory = await open(path.dirname(this.file), "r");
		try { await directory.sync(); }
		finally { await directory.close(); }
	}

	async begin(agentIds: Iterable<string>): Promise<string[]> {
		if (await this.read()) throw new Error(`${this.label} 变更仍待对账，须先恢复`);
		const ids = [...new Set(agentIds)].sort();
		const pending: PendingMutation = { version: 1, agentIds: ids };
		await mkdir(path.dirname(this.file), { recursive: true });
		const temp = `${this.file}.${randomUUID()}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temp, "wx", 0o600);
			await handle.writeFile(JSON.stringify(pending) + "\n");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temp, this.file);
			await this.syncDirectory();
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await unlink(temp).catch(() => undefined);
			// rename 后目录同步失败时，目标可能已存在；拒绝执行包变更。
			throw error;
		}
		return ids;
	}

	async complete(): Promise<void> {
		try { await unlink(this.file); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		await this.syncDirectory();
	}

	async recover(revise: (agentId: string) => Promise<void>, sync: () => Promise<void>): Promise<string[]> {
		const pending = await this.read();
		if (!pending) return [];
		for (const id of pending.agentIds) await revise(id);
		await sync();
		await this.complete();
		return pending.agentIds;
	}

	private async read(): Promise<PendingMutation | undefined> {
		let raw: string;
		try { raw = await readFile(this.file, "utf-8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || (value as PendingMutation).version !== 1 ||
			!Array.isArray((value as PendingMutation).agentIds) ||
			(value as PendingMutation).agentIds.some((id) => typeof id !== "string" || !id)) {
			throw new Error(`${this.label} 变更对账记录损坏，拒绝继续启动或变更`);
		}
		return value as PendingMutation;
	}
}
