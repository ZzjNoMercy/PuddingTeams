import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeSelection } from "./contracts.js";
import type { KnowledgeBindingRegistry } from "./bindings.js";

interface SelectionFile { version: 1; selections: Record<string, KnowledgeSelection> }

export class KnowledgeSelectionError extends Error {
	constructor(readonly code: "invalid_selection" | "revision_conflict", message: string) { super(message); }
}

/** Per-owner, per-context source choice. Selection never changes directory trust. */
export class KnowledgeSelectionStore {
	private readonly file: string;
	private pending: Promise<void> = Promise.resolve();
	constructor(private readonly stateDir: string, private readonly bindings: KnowledgeBindingRegistry,
		private readonly defaultBindingIds: (ownerId: string) => Promise<string[]> = async ownerId => (await bindings.list(ownerId)).map(binding => binding.id)) {
		this.file = path.join(stateDir, "selections.json");
	}

	private key(ownerId: string, contextKey: string): string { return JSON.stringify([ownerId, contextKey]); }
	private async load(): Promise<SelectionFile> {
		const raw = await readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (raw === null) return { version: 1, selections: {} };
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || (value as SelectionFile).version !== 1 ||
			!(value as SelectionFile).selections || typeof (value as SelectionFile).selections !== "object") throw new Error("invalid knowledge selections store");
		return value as SelectionFile;
	}
	private async save(value: SelectionFile): Promise<void> {
		await mkdir(this.stateDir, { recursive: true });
		const temp = `${this.file}.${randomUUID()}.tmp`;
		await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		await rename(temp, this.file);
	}
	private serial<T>(action: () => Promise<T>): Promise<T> {
		const result = this.pending.then(action);
		this.pending = result.then(() => undefined, () => undefined);
		return result;
	}
	async get(ownerId: string, contextKey: string): Promise<KnowledgeSelection> {
		const stored = (await this.load()).selections[this.key(ownerId, contextKey)];
		return stored ?? { ownerId, contextKey, selectedBindingIds: [], revision: 0 };
	}
	/** Copy choices, not resolved availability: a temporarily offline default must not become an opt-out. */
	async inherit(ownerId: string, contextKey: string, fromContextKey: string): Promise<void> {
		await this.serial(async () => {
			const data = await this.load(), key = this.key(ownerId, contextKey);
			if (data.selections[key]) return;
			const source = data.selections[this.key(ownerId, fromContextKey)];
			data.selections[key] = { ownerId, contextKey, revision: 1,
				selectedBindingIds: [...(source?.selectedBindingIds ?? [])],
				excludedDefaultBindingIds: [...(source?.excludedDefaultBindingIds ?? [])] };
			await this.save(data);
		});
	}
	async set(ownerId: string, contextKey: string, expectedRevision: number, selectedBindingIds: string[]): Promise<KnowledgeSelection> {
		if (!ownerId.trim() || !contextKey.trim() || !Array.isArray(selectedBindingIds) ||
			selectedBindingIds.some((id) => typeof id !== "string" || !id) ||
			new Set(selectedBindingIds).size !== selectedBindingIds.length) {
			throw new KnowledgeSelectionError("invalid_selection", "invalid knowledge source selection");
		}
		return this.serial(async () => {
			const data = await this.load();
			const key = this.key(ownerId, contextKey);
			const current = data.selections[key];
			if ((current?.revision ?? 0) !== expectedRevision) throw new KnowledgeSelectionError("revision_conflict", "knowledge source selection changed");
			for (const id of selectedBindingIds) await this.bindings.requireUsable(ownerId, id);
			// An offline default is absent from the effective UI selection, not an intentional opt-out.
			const defaults: string[] = [];
			for (const id of await this.defaultBindingIds(ownerId)) {
				if (await this.bindings.requireUsable(ownerId, id).then(() => true, () => false)) defaults.push(id);
			}
			const excludedDefaultBindingIds = [...new Set([...(current?.excludedDefaultBindingIds ?? []), ...defaults])]
				.filter((id) => !selectedBindingIds.includes(id));
			const next = { ownerId, contextKey, selectedBindingIds: [...selectedBindingIds], excludedDefaultBindingIds, revision: expectedRevision + 1 };
			data.selections[key] = next;
			await this.save(data);
			return next;
		});
	}
	/** Re-check every root before context assembly. An old selection cannot re-grant revoked access. */
	async effective(ownerId: string, contextKey: string): Promise<KnowledgeSelection> {
		const stored = await this.get(ownerId, contextKey);
		const available: string[] = [];
		const defaults = (await this.defaultBindingIds(ownerId)).filter((id) => !stored.excludedDefaultBindingIds?.includes(id));
		for (const id of new Set([...stored.selectedBindingIds, ...defaults])) {
			if (await this.bindings.requireUsable(ownerId, id).then(() => true, () => false)) available.push(id);
		}
		return { ...stored, selectedBindingIds: available };
	}
}
