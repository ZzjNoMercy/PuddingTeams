import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeBinding } from "./contracts.js";
import { probeKnowledgeRoot } from "./probe.js";
import { resolveEffectiveSchema } from "./schema-impact.js";

interface BindingFile {
	version: 1;
	bindings: Record<string, KnowledgeBinding>;
}

export class KnowledgeBindingError extends Error {
	constructor(readonly code: "invalid_input" | "overlapping_root" | "revision_conflict" | "not_found" | "root_changed", message: string) {
		super(message);
	}
}

/** apply 阶段已完成的探测/计划结果；传入时登记不再重新决定四根，仅复核根身份未漂移。 */
export interface PreparedBindingRoot {
	canonicalRoot: string;
	rootIdentity: string;
	contentRoot: string;
	linkRoot: string;
	obsidianRoot?: string;
	schemaRef?: KnowledgeBinding["schemaRef"];
}

/** Platform-owned registry. Registering a directory never writes into that directory. */
export class KnowledgeBindingRegistry {
	private readonly file: string;
	private pending: Promise<void> = Promise.resolve();

	constructor(private readonly stateDir: string) {
		this.file = path.join(stateDir, "bindings.json");
	}

	private async load(): Promise<BindingFile> {
		const raw = await readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (raw === null) return { version: 1, bindings: {} };
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || (parsed as BindingFile).version !== 1 ||
			!(parsed as BindingFile).bindings || typeof (parsed as BindingFile).bindings !== "object") {
			throw new Error("invalid knowledge binding registry");
		}
		return parsed as BindingFile;
	}

	private async save(data: BindingFile): Promise<void> {
		await mkdir(this.stateDir, { recursive: true });
		const temp = `${this.file}.${randomUUID()}.tmp`;
		await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		await rename(temp, this.file);
	}

	private serial<T>(action: () => Promise<T>): Promise<T> {
		const result = this.pending.then(action);
		this.pending = result.then(() => undefined, () => undefined);
		return result;
	}

	async create(input: { ownerId: string; name: string; description: string; rootPath: string; prepared?: PreparedBindingRoot }): Promise<KnowledgeBinding> {
		const ownerId = input.ownerId.trim();
		const name = input.name.trim();
		const description = input.description.trim();
		if (!ownerId || !name || name.length > 120 || !description || description.length > 500 || !path.isAbsolute(input.rootPath)) {
			throw new KnowledgeBindingError("invalid_input", "owner, name, description and absolute server root are required");
		}
		return this.serial(async () => {
			let canonicalRoot: string;
			let rootIdentity: string;
			let contentRoot: string;
			let linkRoot: string;
			let obsidianRoot: string | undefined;
			let schemaRef: KnowledgeBinding["schemaRef"];
			if (input.prepared) {
				const check = await probeKnowledgeRoot(input.prepared.canonicalRoot).catch(() => null);
				if (!check?.readable || check.canonicalRoot !== input.prepared.canonicalRoot || check.rootIdentity !== input.prepared.rootIdentity) {
					throw new KnowledgeBindingError("root_changed", "knowledge root is offline or changed identity since the plan was made");
				}
				({ canonicalRoot, rootIdentity, contentRoot, linkRoot, obsidianRoot, schemaRef } = input.prepared);
			} else {
				const probe = await probeKnowledgeRoot(input.rootPath);
				if (!probe.readable) throw new KnowledgeBindingError("invalid_input", "knowledge root is not readable");
				canonicalRoot = probe.canonicalRoot;
				rootIdentity = probe.rootIdentity;
				contentRoot = probe.contentRoot;
				linkRoot = probe.contentRoot;
			}
			const data = await this.load();
			for (const existing of Object.values(data.bindings)) {
				// 与 findOverlap 对齐：已撤销绑定不占重叠名额，同根重新接入是合法的。
				if (existing.availability !== "revoked" && rootsOverlap(canonicalRoot, existing.canonicalBindingRoot)) {
					throw new KnowledgeBindingError("overlapping_root", "knowledge roots cannot overlap");
				}
			}
			const record: KnowledgeBinding = {
				id: randomUUID(), ownerId, name, description, metadataMode: "registry",
				canonicalBindingRoot: canonicalRoot, rootIdentity,
				contentRoot, linkRoot,
				...(obsidianRoot ? { obsidianRoot } : {}),
				...(schemaRef ? { schemaRef } : {}),
				readPolicy: "private", bindingRevision: 1, trustRevision: 1, availability: "available",
			};
			data.bindings[record.id] = record;
			await this.save(data);
			return record;
		});
	}

	/** 计划阶段的轻量重叠检查；登记时 create 仍会串行复核。 */
	async findOverlap(canonicalRoot: string): Promise<KnowledgeBinding | undefined> {
		const data = await this.load();
		return Object.values(data.bindings).find((existing) =>
			existing.availability !== "revoked" && rootsOverlap(canonicalRoot, existing.canonicalBindingRoot));
	}

	async list(ownerId: string): Promise<KnowledgeBinding[]> {
		const data = await this.load();
		const owned = Object.values(data.bindings).filter((record) => record.ownerId === ownerId && record.availability !== "revoked");
		return Promise.all(owned.map(async (record) => {
			const available = await sameRoot(record);
			const effective = available ? await resolveEffectiveSchema(record) : undefined;
			return { ...record, availability: available ? "available" as const : "offline" as const,
				...(effective ? { schemaRef: effective.schemaRef } : {}) };
		}));
	}

	async requireUsable(ownerId: string, id: string): Promise<KnowledgeBinding> {
		const record = (await this.load()).bindings[id];
		if (!record || record.ownerId !== ownerId || record.availability === "revoked") {
			throw new KnowledgeBindingError("not_found", "knowledge binding not found");
		}
		if (!await sameRoot(record)) throw new KnowledgeBindingError("root_changed", "knowledge root is offline or changed identity");
		return { ...record, schemaRef: (await resolveEffectiveSchema(record)).schemaRef };
	}
	/** No await: fence a host-side commit against a completed registry revocation. */
	assertCurrentRevision(ownerId: string, id: string, expected: { bindingRevision: number; trustRevision: number; rootIdentity: string }): void {
		const record = (JSON.parse(readFileSync(this.file, "utf8")) as BindingFile).bindings[id];
		if (!record || record.ownerId !== ownerId || record.availability === "revoked" || record.bindingRevision !== expected.bindingRevision ||
			record.trustRevision !== expected.trustRevision || record.rootIdentity !== expected.rootIdentity) throw new KnowledgeBindingError("revision_conflict", "knowledge binding authorization changed");
	}

	async updateDescription(ownerId: string, id: string, expectedRevision: number, description: string): Promise<KnowledgeBinding> {
		const value = description.trim();
		if (!value || value.length > 500) throw new KnowledgeBindingError("invalid_input", "description must have 1-500 characters");
		return this.serial(async () => {
			const data = await this.load();
			const record = data.bindings[id];
			if (!record || record.ownerId !== ownerId || record.availability === "revoked") throw new KnowledgeBindingError("not_found", "knowledge binding not found");
			if (record.bindingRevision !== expectedRevision) throw new KnowledgeBindingError("revision_conflict", "knowledge binding revision changed");
			if (!await sameRoot(record)) throw new KnowledgeBindingError("root_changed", "knowledge root is offline or changed identity");
			record.description = value;
			record.bindingRevision++;
			await this.save(data);
			return record;
		});
	}

	async revoke(ownerId: string, id: string, expectedRevision: number): Promise<KnowledgeBinding> {
		return this.serial(async () => {
			const data = await this.load();
			const record = data.bindings[id];
			if (!record || record.ownerId !== ownerId || record.availability === "revoked") throw new KnowledgeBindingError("not_found", "knowledge binding not found");
			if (record.bindingRevision !== expectedRevision) throw new KnowledgeBindingError("revision_conflict", "knowledge binding revision changed");
			record.availability = "revoked";
			record.bindingRevision++;
			record.trustRevision++;
			await this.save(data);
			return record;
		});
	}
}

function rootsOverlap(a: string, b: string): boolean {
	const relative = path.relative(a, b);
	const reverse = path.relative(b, a);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) ||
		(!reverse.startsWith(`..${path.sep}`) && reverse !== ".." && !path.isAbsolute(reverse));
}

async function sameRoot(record: KnowledgeBinding): Promise<boolean> {
	const probe = await probeKnowledgeRoot(record.canonicalBindingRoot).catch(() => null);
	return Boolean(probe?.readable && probe.canonicalRoot === record.canonicalBindingRoot && probe.rootIdentity === record.rootIdentity);
}
