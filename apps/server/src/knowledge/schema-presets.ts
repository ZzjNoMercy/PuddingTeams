import { createHash } from "node:crypto";

export type SchemaFieldType = "text" | "date" | "datetime" | "text_list" | "source_refs" | "note_refs" | "enum";
export interface SchemaField {
	name: string;
	type: SchemaFieldType;
	required: boolean;
	values?: string[];
	/** If this field is present in a note, that source_refs field must also be present. */
	requiresSourceField?: string;
}
export interface SchemaEntity {
	type: string;
	directory: string;
	fields: SchemaField[];
}
export interface SchemaRelation {
	type: string;
	/** Simple relation: one source/target type. */
	from?: string;
	to?: string;
	/** One relation name may have several exact source/target type pairs. */
	endpoints?: Array<{ from: string; to: string }>;
	inverseName?: string;
	requiresEvidence: boolean;
}
export interface TeamsSchemaPreset {
	formatVersion: 1;
	schemaId: string;
	revision: number;
	name: string;
	/** 一句话说明用途，供创建向导的结构选择卡片展示。 */
	description: string;
	entities: SchemaEntity[];
	relations: SchemaRelation[];
}

const common: SchemaField[] = [
	{ name: "id", type: "text", required: true },
	{ name: "type", type: "text", required: true },
	{ name: "title", type: "text", required: true },
	{ name: "created", type: "datetime", required: false },
	{ name: "updated", type: "datetime", required: false },
	{ name: "tags", type: "text_list", required: false },
	{ name: "sources", type: "source_refs", required: false },
];
/**
 * 证据型 Wiki 的字段基线：不写 id（Markdown 路径本身就是身份），`sources` 必填且
 * 是库内相对路径字符串。这类页面是手写并被审阅的，frontmatter 解析器只认标量与
 * 字符串列表，表达不了 source_refs 对象，声明成对象只会逼出无法兑现的引用。
 */
const wikiCommon: SchemaField[] = [
	{ name: "type", type: "text", required: true },
	{ name: "title", type: "text", required: true },
	{ name: "created", type: "datetime", required: false },
	{ name: "updated", type: "datetime", required: false },
	{ name: "sources", type: "text_list", required: true },
];
const field = (name: string, type: SchemaFieldType, required = false, values?: string[]): SchemaField => ({ name, type, required, ...(values ? { values } : {}) });
/** extra 中与基线同名的字段覆盖基线（用于换类型或改必填性），否则追加。 */
const entity = (type: string, directory: string, extra: SchemaField[] = [], base: readonly SchemaField[] = common): SchemaEntity => {
	const fields = base.map((item) => ({ ...item }));
	for (const item of extra) {
		const index = fields.findIndex((existing) => existing.name === item.name);
		if (index >= 0) fields[index] = { ...fields[index]!, ...item };
		else fields.push({ ...item });
	}
	return { type, directory, fields };
};
const relation = (type: string, from: string, to: string, requiresEvidence = true, inverseName?: string): SchemaRelation =>
	({ type, from, to, requiresEvidence, ...(inverseName ? { inverseName } : {}) });
/** 一个关系名跨多组精确端点，避免 type×type 的笛卡尔积被误当成合法端点。 */
const related = (type: string, ...endpoints: Array<[string, string]>): SchemaRelation =>
	({ type, requiresEvidence: true, endpoints: endpoints.map(([from, to]) => ({ from, to })) });

/** 明文 Memory Wiki：字段仅表达内容语义，增删改仍由 Wiki 管理与审批执行。 */
const memoryCommon: SchemaField[] = [
	...wikiCommon,
	field("scope", "text", true),
	field("status", "enum", true, ["active", "disputed", "superseded", "expired"]),
	field("basis", "enum", true, ["stated", "observed", "inferred"]),
	field("observedAt", "datetime"), field("validFrom", "date"), field("validUntil", "date"),
	field("reviewAfter", "date"), field("tags", "text_list"),
];

/** Built-in schemas are reference templates. Per-vault edits always use a deep copy. */
export const TEAMS_SCHEMA_PRESETS: Readonly<Record<string, TeamsSchemaPreset>> = deepFreeze({
	"personal-assistant": {
		formatVersion: 1, schemaId: "personal-assistant", revision: 1, name: "个人助理",
		description: "让计划、日记和长期偏好相互连接。",
		entities: [
			entity("daily", "Daily", [field("date", "date", true)]),
			entity("task", "Tasks", [field("status", "enum", false, ["todo", "doing", "done", "cancelled"]), field("due", "date")]),
			entity("project", "Projects"),
			entity("preference", "Profile", [field("scope", "text"), field("source", "source_refs")]),
			entity("person", "People", [field("name", "text")]),
			entity("meeting", "Meetings", [field("occurredAt", "datetime"), field("participants", "note_refs")]),
		],
		relations: [relation("belongs_to", "task", "project"), relation("has_participant", "meeting", "person"), relation("mentions", "daily", "person")],
	},
	/**
	 * 研究：证据驱动的编译式 Wiki 结构——概念、系统、框架、工程实践、论文、媒体、
	 * 渠道、公司与跨来源分析九类，关系全部要求来源支持。目录用小写复数，与页面
	 * slug 同构，因此 wikilink 的目录前缀就是类型名。
	 */
	research: {
		formatVersion: 1, schemaId: "research", revision: 1, name: "研究",
		description: "证据驱动的概念、框架、论文与实践 Wiki；每条结论都指回来源。",
		entities: [
			entity("concept", "concepts", [], wikiCommon),
			entity("system", "systems", [], wikiCommon),
			entity("software_framework", "frameworks", [], wikiCommon),
			entity("engineering_practice", "practices", [], wikiCommon),
			entity("research_paper", "papers", [], wikiCommon),
			entity("media", "media", [], wikiCommon),
			entity("source", "sources", [], wikiCommon),
			entity("company", "companies", [], wikiCommon),
			entity("analysis", "analysis", [], wikiCommon),
		],
		relations: [
			related("relates_to",
				["concept", "concept"], ["concept", "engineering_practice"], ["concept", "media"], ["concept", "software_framework"], ["concept", "system"],
				["engineering_practice", "concept"], ["engineering_practice", "engineering_practice"],
				["media", "concept"],
				["research_paper", "concept"], ["research_paper", "engineering_practice"],
				["software_framework", "concept"], ["software_framework", "engineering_practice"],
				["system", "concept"], ["system", "system"]),
			related("discusses", ["media", "concept"], ["media", "engineering_practice"]),
			related("applies_to",
				["concept", "concept"],
				["engineering_practice", "concept"], ["engineering_practice", "software_framework"], ["engineering_practice", "system"],
				["software_framework", "concept"], ["software_framework", "system"]),
			related("implements", ["software_framework", "concept"], ["software_framework", "engineering_practice"], ["system", "engineering_practice"]),
			related("uses",
				["engineering_practice", "software_framework"],
				["research_paper", "software_framework"],
				["software_framework", "software_framework"],
				["system", "concept"], ["system", "software_framework"]),
			related("derived_from",
				["concept", "media"],
				["engineering_practice", "media"], ["engineering_practice", "research_paper"],
				["software_framework", "media"]),
			relation("sourced_from", "media", "source"),
			related("introduces", ["media", "engineering_practice"], ["media", "system"]),
			related("implemented_by", ["concept", "software_framework"], ["engineering_practice", "system"]),
			related("supports", ["company", "concept"], ["engineering_practice", "engineering_practice"]),
			relation("depends_on", "engineering_practice", "engineering_practice"),
			relation("introduced_by", "system", "media"),
			relation("mentions", "media", "software_framework"),
		],
	},
	project: {
		formatVersion: 1, schemaId: "project", revision: 1, name: "项目",
		description: "将需求、决策与交付证据放在同一处。",
		entities: [
			entity("spec", "Specs", [field("status", "text")]),
			entity("decision", "Decisions", [field("status", "text"), field("rationale", "text")]),
			entity("task", "Tasks", [field("status", "text"), field("due", "date")]),
			entity("deliverable", "Deliverables", [field("artifactRef", "text"), field("evidenceRefs", "source_refs")]),
		],
		relations: [relation("implements", "task", "spec"), relation("concerns", "decision", "spec"), relation("depends_on", "task", "task"), relation("evidences_decision", "deliverable", "decision"), relation("evidences_task", "deliverable", "task")],
	},
	/**
	 * 人脉：往来（interaction）与外部素材（record）拆成两类，避免把「我参与过的见面」
	 * 和「我没参与的动态」记进同一张表；最近一次往来不落库（由 Interactions 推导），
	 * 只保存无法推导的判断与承诺（importance / intimacy / nextContactAt）。
	 * 关联一律用关系 wikilink 表达，不再另设 participants 之类的 note_refs 字段，
	 * 避免同一事实两处登记后互相漂移。
	 */
	people: {
		formatVersion: 1, schemaId: "people", revision: 2, name: "人脉",
		description: "以人物和公司为独立实体，通过有据可查的任职、往来、圈层、项目与话题维护关系网。",
		entities: [
			entity("person", "People", [
				field("aliases", "text_list"),
				field("phone", "text"), field("email", "text"),
				field("location", "text"), field("birthday", "text"),
				field("importance", "enum", false, ["1", "2", "3", "4", "5"]),
				field("intimacy", "enum", false, ["1", "2", "3", "4", "5"]),
				field("nextContactAt", "datetime"),
			]),
			entity("org", "Orgs", [field("aliases", "text_list"), field("location", "text"), field("industry", "text"), field("website", "text")]),
			entity("affiliation", "Affiliations", [field("role", "text"), field("status", "enum", false, ["current", "former"]), field("startDate", "date"), field("endDate", "date")]),
			entity("group", "Groups", [field("kind", "enum", false, ["family", "work", "client", "investor", "industry", "community", "other"])]),
			entity("project", "Projects", [field("status", "enum", false, ["active", "paused", "done", "dropped"]), field("myRole", "text")]),
			entity("interaction", "Interactions", [
				field("kind", "enum", false, ["in_person", "call", "message", "email", "meal", "event", "other"]),
				field("status", "enum", false, ["planned", "done", "cancelled"]),
				field("occurredAt", "datetime", true),
			]),
			entity("record", "Records", [field("kind", "enum", false, ["moment", "card", "screenshot", "observation", "hearsay"]), field("capturedAt", "date")]),
			entity("topic", "Topics", [field("angle", "text", true)]),
		],
		relations: [
			relation("held_by", "affiliation", "person"),
			relation("at_org", "affiliation", "org"),
			relation("introduced_by", "person", "person"),
			relation("belongs_to", "person", "group"),
			relation("participates_in", "person", "project"),
			relation("involves", "interaction", "person"),
			relation("mentions", "record", "person"),
			relation("shares", "person", "topic"),
			relation("advances", "interaction", "project"),
			{ type: "discusses", requiresEvidence: true, endpoints: [{ from: "interaction", to: "topic" }, { from: "record", to: "topic" }] },
		],
	},
	memory: {
		formatVersion: 1, schemaId: "memory", revision: 1, name: "长期记忆",
		description: "保存有来源的事实、偏好、上下文、决策、经历与方法，由 Wiki 管理员整理并经审核更新。",
		entities: [
			entity("fact", "facts", [field("key", "text", true)], memoryCommon),
			entity("preference", "preferences", [field("key", "text", true)], memoryCommon),
			entity("context", "contexts", [field("key", "text", true)], memoryCommon),
			entity("decision", "decisions", [field("key", "text", true), field("decidedOn", "date")], memoryCommon),
			entity("episode", "episodes", [field("occurredOn", "date", true)], memoryCommon),
			entity("procedure", "procedures", [field("key", "text", true), field("trigger", "text", true), field("lastVerifiedOn", "date")], memoryCommon),
		],
		relations: [
			related("supersedes", ["fact", "fact"], ["preference", "preference"], ["context", "context"], ["decision", "decision"], ["procedure", "procedure"]),
			related("derived_from", ["fact", "episode"], ["preference", "episode"], ["context", "episode"], ["decision", "episode"], ["procedure", "episode"]),
			related("applies_to", ["fact", "context"], ["preference", "context"], ["decision", "context"], ["procedure", "context"]),
		],
	},
});

export function copySchemaPreset(id: string): TeamsSchemaPreset {
	const preset = TEAMS_SCHEMA_PRESETS[id];
	if (!preset) throw new Error(`unknown Teams schema preset: ${id}`);
	return structuredClone(preset);
}

/** 结构哈希：键排序后的稳定 JSON 序列化取 sha256，用于 preset/schemaRef 的防篡改指纹。 */
const schemaHashCache = new Map<string, string>();
export function hashTeamsSchema(schema: TeamsSchemaPreset): string {
	const key = stableStringify(schema);
	let hash = schemaHashCache.get(key);
	if (hash === undefined) {
		hash = createHash("sha256").update(key).digest("hex");
		schemaHashCache.set(key, hash);
	}
	return hash;
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function validateTeamsSchema(schema: TeamsSchemaPreset): string[] {
	const errors: string[] = [];
	if (schema.formatVersion !== 1 || !schema.schemaId || !Number.isSafeInteger(schema.revision) || schema.revision < 1) errors.push("invalid_header");
	const types = new Set<string>();
	const directories = new Set<string>();
	for (const item of schema.entities) {
		if (!item.type || types.has(item.type)) errors.push(`duplicate_or_empty_entity:${item.type}`);
		types.add(item.type);
		if (!item.directory || item.directory === "." || item.directory === ".." || item.directory.includes("/") || item.directory.includes("\\") || directories.has(item.directory)) errors.push(`invalid_directory:${item.directory}`);
		directories.add(item.directory);
		const fieldNames = new Set<string>();
		for (const value of item.fields) {
			if (!value.name || fieldNames.has(value.name)) errors.push(`duplicate_or_empty_field:${item.type}:${value.name}`);
			fieldNames.add(value.name);
			if (value.type === "enum" && (!value.values?.length || new Set(value.values).size !== value.values.length)) errors.push(`invalid_enum:${item.type}:${value.name}`);
			if (value.requiresSourceField && !item.fields.some((source) => source.name === value.requiresSourceField && source.type === "source_refs")) errors.push(`invalid_source_requirement:${item.type}:${value.name}`);
		}
		// Markdown 路径本身即可作为页面身份；不强迫每篇 Wiki 重复填写 id。
		for (const required of ["type", "title"]) if (!item.fields.some((value) => value.name === required && value.required)) errors.push(`missing_common_field:${item.type}:${required}`);
	}
	const relationNames = new Set<string>();
	for (const item of schema.relations) {
		if (!item.type || relationNames.has(item.type)) errors.push(`duplicate_or_empty_relation:${item.type}`);
		relationNames.add(item.type);
		const hasPair = item.from !== undefined || item.to !== undefined;
		const hasEndpoints = item.endpoints !== undefined;
		if (hasPair === hasEndpoints || (hasPair && (!item.from || !item.to)) || (hasEndpoints && (!Array.isArray(item.endpoints) || !item.endpoints.length))) {
			errors.push(`invalid_relation_endpoints:${item.type}`);
			continue;
		}
		const endpoints = item.endpoints ?? [{ from: item.from!, to: item.to! }];
		const seen = new Set<string>();
		for (const endpoint of endpoints) {
			if (!endpoint || typeof endpoint.from !== "string" || typeof endpoint.to !== "string") {
				errors.push(`invalid_relation_endpoints:${item.type}`);
				continue;
			}
			if (!types.has(endpoint.from) || !types.has(endpoint.to)) errors.push(`unknown_endpoint:${item.type}`);
			const key = `${endpoint.from}\0${endpoint.to}`;
			if (seen.has(key)) errors.push(`duplicate_endpoint:${item.type}`);
			seen.add(key);
		}
	}
	return errors;
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}
