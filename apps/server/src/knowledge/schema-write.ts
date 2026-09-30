import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeBinding } from "./contracts.js";
import { resolveEffectiveSchema } from "./schema-impact.js";
import { validateTeamsSchema, type TeamsSchemaPreset } from "./schema-presets.js";

const MAX_SCHEMA_BYTES = 1024 * 1024;
const pendingByRoot = new Map<string, Promise<void>>();

export class SchemaWriteError extends Error {
	constructor(readonly code: "schema_invalid" | "baseline_conflict" | "capability_unavailable", message: string, readonly details?: string[]) {
		super(message);
	}
}

/** Replace only the registered root schema; never write wiki/ or raw/. */
export async function writeTeamsSchema(binding: KnowledgeBinding, input: TeamsSchemaPreset, expectedHash: string): Promise<TeamsSchemaPreset> {
	const root = binding.canonicalBindingRoot;
	const previous = pendingByRoot.get(root) ?? Promise.resolve();
	const action = previous.then(async () => {
		const current = await resolveEffectiveSchema(binding);
		if (!current.schema || !current.schemaRef) throw new SchemaWriteError("capability_unavailable", "当前知识库没有可编辑的结构声明");
		if (current.schemaRef.hash !== expectedHash) throw new SchemaWriteError("baseline_conflict", "结构声明已被其他操作修改，请刷新后重试");
		if (!input || typeof input !== "object" || !Array.isArray(input.entities) || !Array.isArray(input.relations)) {
			throw new SchemaWriteError("schema_invalid", "结构定义不完整");
		}
		const next = structuredClone(input);
		next.revision = current.schema.revision + 1;
		if (next.schemaId !== current.schema.schemaId || next.formatVersion !== current.schema.formatVersion) {
			throw new SchemaWriteError("schema_invalid", "不能修改结构标识或格式版本");
		}
		const errors = validateTeamsSchema(next);
		if (errors.length) throw new SchemaWriteError("schema_invalid", "结构定义未通过校验", errors);
		const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
		if (bytes.length > MAX_SCHEMA_BYTES) throw new SchemaWriteError("schema_invalid", "结构声明超过 1 MiB");

		const target = path.join(root, "wiki.schema.json");
		const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => null);
		if (!handle) throw new SchemaWriteError("baseline_conflict", "结构文件已变化，请刷新后重试");
		let originalMode = 0o600;
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.nlink !== 1) throw new SchemaWriteError("baseline_conflict", "结构文件已变化，请刷新后重试");
			originalMode = stat.mode & 0o777;
		} finally {
			await handle.close();
		}

		const temporary = path.join(root, `.wiki.schema.${randomUUID()}.tmp`);
		try {
			const output = await open(temporary, "wx", originalMode);
			try {
				await output.writeFile(bytes);
				await output.chmod(originalMode);
				await output.sync();
			} finally {
				await output.close();
			}
			// Recheck the semantic baseline immediately before atomic replacement.
			const latest = await resolveEffectiveSchema(binding);
			if (latest.schemaRef?.hash !== expectedHash) throw new SchemaWriteError("baseline_conflict", "结构声明已被其他操作修改，请刷新后重试");
			await rename(temporary, target);
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
		return next;
	});
	const settled = action.then(() => undefined, () => undefined);
	pendingByRoot.set(root, settled);
	void settled.then(() => { if (pendingByRoot.get(root) === settled) pendingByRoot.delete(root); });
	return action;
}
