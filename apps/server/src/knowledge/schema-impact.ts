import { schemaEntityDirectory } from "./schema-layout.js";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeBinding } from "./contracts.js";
import { validateTeamsNote } from "./note-validation.js";
import { hashTeamsSchema, validateTeamsSchema, type SchemaEntity, type SchemaField, type SchemaRelation, type TeamsSchemaPreset } from "./schema-presets.js";

const MAX_SCHEMA_BYTES = 1024 * 1024;

export interface EffectiveSchema {
	origin: "vault_declaration" | "none";
	schema?: TeamsSchemaPreset;
	schemaRef?: NonNullable<KnowledgeBinding["schemaRef"]>;
	warnings: string[];
}

/**
 * 根目录 wiki.schema.json 是唯一的结构声明；绑定内的预置信息只是来源
 * 元数据，不能在文件缺失或损坏时成为另一份生效结构。
 */
export async function resolveEffectiveSchema(binding: KnowledgeBinding): Promise<EffectiveSchema> {
	const warnings: string[] = [];
	const schemaFile = path.join(binding.canonicalBindingRoot, "wiki.schema.json");
	const handle = await open(schemaFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		return error;
	});
	if (handle instanceof Error) return { origin: "none", warnings: [`wiki.schema.json 无法安全读取（${handle.code ?? "unknown"}）`] };
	if (handle) {
		let raw: string;
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.nlink !== 1 || info.size > MAX_SCHEMA_BYTES) {
				return { origin: "none", warnings: ["wiki.schema.json 必须是小于 1 MiB 的普通文件"] };
			}
			raw = await handle.readFile("utf8");
		} catch {
			return { origin: "none", warnings: ["wiki.schema.json 无法读取"] };
		} finally {
			await handle.close();
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return { origin: "none", warnings: ["wiki.schema.json 不是合法 JSON"] };
		}
		const candidate = parsed as TeamsSchemaPreset;
		if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.entities) || !Array.isArray(candidate.relations)) {
			return { origin: "none", warnings: ["wiki.schema.json 结构不完整"] };
		}
		let errors: string[];
		try {
			errors = validateTeamsSchema(candidate);
		} catch {
			return { origin: "none", warnings: ["wiki.schema.json 结构不完整"] };
		}
		if (errors.length > 0) return { origin: "none", warnings: [`wiki.schema.json 未通过校验（${errors.join("、")}）`] };
		return {
			origin: "vault_declaration",
			schema: candidate,
			schemaRef: { format: "teams-schema", id: candidate.schemaId, revision: candidate.revision, hash: hashTeamsSchema(candidate) },
			warnings,
		};
	}
	warnings.push("未检测到根目录 wiki.schema.json，结构化能力降级，普通 Markdown 阅读不受影响");
	return { origin: "none", warnings };
}

export async function effectiveSchemaHash(binding: KnowledgeBinding): Promise<string | undefined> {
	return (await resolveEffectiveSchema(binding)).schemaRef?.hash;
}

export interface SchemaChange {
	kind: "entity_added" | "entity_removed" | "entity_directory_changed" | "field_added" | "field_removed" | "field_changed" | "relation_added" | "relation_removed" | "relation_changed";
	entity?: string;
	field?: string;
	relation?: string;
	from?: unknown;
	to?: unknown;
}

function fieldShape(field: SchemaField): Record<string, unknown> {
	return {
		type: field.type,
		required: field.required,
		...(field.values ? { values: field.values } : {}),
		...(field.requiresSourceField ? { requiresSourceField: field.requiresSourceField } : {}),
	};
}

function relationShape(relation: SchemaRelation): Record<string, unknown> {
	return {
		...(relation.endpoints ? { endpoints: relation.endpoints } : { from: relation.from, to: relation.to }),
		requiresEvidence: relation.requiresEvidence,
		...(relation.inverseName ? { inverseName: relation.inverseName } : {}),
	};
}

/** 旧结构（可为 null，表示当前无生效结构）与新结构的增删改清单。 */
export function diffTeamsSchemas(oldSchema: TeamsSchemaPreset | null, next: TeamsSchemaPreset): SchemaChange[] {
	const changes: SchemaChange[] = [];
	const oldEntities = new Map<string, SchemaEntity>((oldSchema?.entities ?? []).map((entity) => [entity.type, entity]));
	const newEntities = new Map<string, SchemaEntity>(next.entities.map((entity) => [entity.type, entity]));
	for (const entity of next.entities) {
		const previous = oldEntities.get(entity.type);
		if (!previous) {
			changes.push({ kind: "entity_added", entity: entity.type, to: { directory: entity.directory } });
			continue;
		}
		if (previous.directory !== entity.directory) {
			changes.push({ kind: "entity_directory_changed", entity: entity.type, from: previous.directory, to: entity.directory });
		}
		const oldFields = new Map<string, SchemaField>(previous.fields.map((field) => [field.name, field]));
		const newFields = new Map<string, SchemaField>(entity.fields.map((field) => [field.name, field]));
		for (const field of entity.fields) {
			const before = oldFields.get(field.name);
			if (!before) {
				changes.push({ kind: "field_added", entity: entity.type, field: field.name, to: fieldShape(field) });
			} else if (JSON.stringify(fieldShape(before)) !== JSON.stringify(fieldShape(field))) {
				changes.push({ kind: "field_changed", entity: entity.type, field: field.name, from: fieldShape(before), to: fieldShape(field) });
			}
		}
		for (const field of previous.fields) {
			if (!newFields.has(field.name)) changes.push({ kind: "field_removed", entity: entity.type, field: field.name, from: fieldShape(field) });
		}
	}
	for (const entity of oldSchema?.entities ?? []) {
		if (!newEntities.has(entity.type)) changes.push({ kind: "entity_removed", entity: entity.type, from: { directory: entity.directory } });
	}
	const oldRelations = new Map<string, SchemaRelation>((oldSchema?.relations ?? []).map((relation) => [relation.type, relation]));
	const newRelations = new Map<string, SchemaRelation>(next.relations.map((relation) => [relation.type, relation]));
	for (const relation of next.relations) {
		const previous = oldRelations.get(relation.type);
		if (!previous) {
			changes.push({ kind: "relation_added", relation: relation.type, to: relationShape(relation) });
		} else if (JSON.stringify(relationShape(previous)) !== JSON.stringify(relationShape(relation))) {
			changes.push({ kind: "relation_changed", relation: relation.type, from: relationShape(previous), to: relationShape(relation) });
		}
	}
	for (const relation of oldSchema?.relations ?? []) {
		if (!newRelations.has(relation.type)) changes.push({ kind: "relation_removed", relation: relation.type, from: relationShape(relation) });
	}
	return changes;
}

export interface AffectedFile {
	path: string;
	entity: string;
	reasons: string[];
}

/**
 * 单条已采纳笔记对新结构的影响评估（纯函数，不读写磁盘/账本）：
 * 实体被移除、新增必填字段缺失、枚举值不再合法、目录映射变化导致归属变化。
 */
export function assessAcceptedNote(
	relativePath: string,
	noteFields: Record<string, unknown>,
	oldSchema: TeamsSchemaPreset | null,
	next: TeamsSchemaPreset,
	contentPrefix = "",
): AffectedFile | undefined {
	const type = typeof noteFields.type === "string" ? noteFields.type : undefined;
	if (!type) return undefined;
	const reasons: string[] = [];
	const nextEntity = next.entities.find((entity) => entity.type === type);
	if (!nextEntity) {
		reasons.push("entity_removed");
	} else {
		for (const error of validateTeamsNote(next, noteFields)) {
			if (error.startsWith("missing:")) {
				reasons.push(`missing_required:${error.slice("missing:".length)}`);
			} else if (error.startsWith("invalid:")) {
				const fieldName = error.slice("invalid:".length);
				const field = nextEntity.fields.find((candidate) => candidate.name === fieldName);
				reasons.push(field?.type === "enum" ? `enum_narrowed:${fieldName}` : `invalid:${fieldName}`);
			} else if (error === "unknown_type") {
				reasons.push("entity_removed");
			} else {
				reasons.push(error);
			}
		}
		const previousEntity = oldSchema?.entities.find((entity) => entity.type === type);
		if (previousEntity && previousEntity.directory !== nextEntity.directory &&
			(relativePath === schemaEntityDirectory(contentPrefix, previousEntity.directory) || relativePath.startsWith(`${schemaEntityDirectory(contentPrefix, previousEntity.directory)}/`))) {
			reasons.push(`directory_changed:${previousEntity.directory}->${nextEntity.directory}`);
		}
	}
	if (reasons.length === 0) return undefined;
	return { path: relativePath, entity: type, reasons: [...new Set(reasons)] };
}
