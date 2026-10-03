import type {
	ExtensionAuthorizationSession,
	AgentCapabilityBinding,
	AgentConfig,
	AgentConnectorBinding,
	AgentProbeResult,
	BindingProbeResult,
	CatalogEntry,
	ConflictRun,
	CustomProviderInput,
	CustomProviderRecord,
	ManagerWorkIndexItem,
	ModelSummary,
	McpCatalogResponse,
	McpServerDefinition,
	McpServerRecord,
	MutationResponse,
	PiManagerSettingsPatch,
	PiResourceConfig,
	PiResourcePreview,
	ProviderSummary,
	PuddingTeamsExtensionManifest,
	ResourceDiagnostic,
	RoomSession,
	RoomSummary,
	SessionWorkState,
	DecisionRequest,
	DelegationTrace,
	DelegationTimelineEvent,
	DriverConfigOption,
	ExtensionConnectionStatus,
	SessionSummary,
	SessionGoalSummary,
	SkillDocument,
	SkillEntry,
	SkillsZipImportResult,
	TemplateDocument,
	TemplateEntry,
	ToolActivation,
	WorkspaceRecord,
	WorkspaceDirectoryListing,
	WorkspaceResourceKind,
	WorkspaceTrustState,
	ViewerIdentity,
} from "./types";
import { getDesktopBridge } from "./desktop";

// 发行态 web 静态产物由 server 同源托管，生产构建直接走 location.origin（端口由
// 安装时的 server 决定，构建期不可知）；dev（next dev :8934 跨端口）回退到 8933。
// NEXT_PUBLIC_SERVER_URL 可显式覆盖两者。
export const SERVER_URL =
	process.env.NEXT_PUBLIC_SERVER_URL ??
	(process.env.NODE_ENV === "production" && typeof window !== "undefined"
		? window.location.origin
		: "http://127.0.0.1:8933");

export type CalendarEventInput = {
	title: string; description: string; location: string; kind: "event" | "focus"; timeZone: string; busy: boolean;
} & ({ allDay: true; startDate: string; endDateExclusive: string } | { allDay: false; start: string; end: string });
export type CalendarEventRecord = CalendarEventInput & { id: string; sourceId: "platform"; revision: number; operationId: string; status: "confirmed" | "cancelled" };
export type CalendarDisplayEvent = CalendarEventInput & { id: string; sourceId: string; readonly?: boolean; sourceName?: string; appLink?: string; providerId?: string; providerName?: string; color?: string };
export interface CalendarProviderDescriptor { id: string; name: string; description: string; color: string; readOnly: boolean; setupUrl?: string; authorization?: { description: string } }
export interface ExternalCalendarSource { id: string; name: string; type: string; writable: boolean }
export class CalendarProviderApiError extends Error {
	constructor(readonly code: string, message: string) { super(message); }
}
async function calendarProviderRequest<T>(path: string): Promise<T> {
	try {
		const response = await fetch(`${SERVER_URL}/api/calendar/providers${path}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
		const data = await response.json() as T & { error?: string; code?: string };
		if (!response.ok) throw new CalendarProviderApiError(data.code ?? "unavailable", data.error ?? "日历加载失败，请重试");
		return data;
	} catch (error) {
		if (error instanceof CalendarProviderApiError) throw error;
		throw new CalendarProviderApiError("unavailable", "日历请求超时或网络不可用，请重试");
	}
}
export const listCalendarProviders = async () => (await calendarProviderRequest<{ providers: CalendarProviderDescriptor[] }>("")).providers;
export const listProviderCalendars = async (providerId: string) => (await calendarProviderRequest<{ calendars: ExternalCalendarSource[] }>(`/${encodeURIComponent(providerId)}/calendars`)).calendars;
export const listProviderCalendarEvents = async (providerId: string, calendarId: string, start: string, end: string) => (await calendarProviderRequest<{ events: CalendarDisplayEvent[] }>(`/${encodeURIComponent(providerId)}/events?${new URLSearchParams({ calendarId, start, end })}`)).events;
export async function listCalendarEvents(): Promise<CalendarEventRecord[]> {
	return (await knowledgeResponse<{ events: CalendarEventRecord[] }>(await fetch(`${SERVER_URL}/api/calendar/events`))).events;
}
export async function getCalendarEvent(id: string): Promise<CalendarEventRecord> {
	return (await knowledgeResponse<{ event: CalendarEventRecord }>(await fetch(`${SERVER_URL}/api/calendar/events/${encodeURIComponent(id)}`))).event;
}
export async function mutateCalendarEvent(action: "create" | "update" | "cancel", id: string | undefined, operation: { operationId: string; expectedRevision: number; event?: CalendarEventInput }): Promise<CalendarEventRecord> {
	return (await knowledgeResponse<{ event: CalendarEventRecord }>(await fetch(`${SERVER_URL}/api/calendar/events${id ? `/${encodeURIComponent(id)}` : ""}`, {
		method: action === "create" ? "POST" : action === "update" ? "PUT" : "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(operation),
	}))).event;
}

// ---- 知识库（M2）：绑定 / 目录树 / 笔记快照 / 自动同步 / 搜索 / 链接解析 / 接入与结构 ----
// 错误体统一 { error, code?, details? }；409 需要 code/details 时抛 KnowledgeApiError。

export interface KnowledgeBindingSummary {
	id: string;
	name: string;
	description: string;
	canonicalBindingRoot: string;
	contentRoot: string;
	bindingRevision: number;
	metadataMode: "registry" | "file";
	/** 服务端随绑定一并返回；无结构声明的纯 Markdown 库缺席该字段。 */
	schemaRef?: { format: string; id: string; revision: number; hash: string; originPresetId?: string };
	availability: "available" | "offline" | "revoked";
}

export type KnowledgeNoteStatus = "current" | "publishing" | "unreadable" | "missing";

export interface KnowledgeTreeNode {
	path: string;
	name: string;
	type: "directory" | "note";
	/** 当前文件的同步/读取状态；缺失文件不进入目录树。 */
	status?: KnowledgeNoteStatus;
	children?: KnowledgeTreeNode[];
}

export class KnowledgeApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "KnowledgeApiError";
	}
}

async function knowledgeResponse<T>(response: Response): Promise<T> {
	const body = await response.json().catch(() => ({})) as T & { error?: string; code?: string; details?: unknown };
	if (!response.ok) {
		throw new KnowledgeApiError(body.error ?? `知识库请求失败：${response.status}`, response.status, body.code, body.details);
	}
	return body;
}

export async function listKnowledgeBindings(): Promise<KnowledgeBindingSummary[]> {
	return (await knowledgeResponse<{ bindings: KnowledgeBindingSummary[] }>(await fetch(`${SERVER_URL}/api/knowledge`))).bindings;
}

export type MemorySetupStatus = { status: "pending" | "deferred" } | { status: "configured"; binding: KnowledgeBindingSummary };
export async function getMemorySetup(): Promise<MemorySetupStatus> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/knowledge/memory-setup`));
}
export async function deferMemorySetup(): Promise<MemorySetupStatus> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/knowledge/memory-setup/defer`, { method: "POST" }));
}
export async function planMemorySetup(path: string): Promise<KnowledgePlan> {
	return (await knowledgeResponse<{ plan: KnowledgePlan }>(await fetch(`${SERVER_URL}/api/knowledge/memory-setup/plan`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }),
	}))).plan;
}
export async function applyMemorySetup(planId: string): Promise<MemorySetupStatus> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/knowledge/memory-setup/apply`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId }),
	}));
}

export interface KnowledgeSelectionSummary {
	contextKey: string;
	selectedBindingIds: string[];
	revision: number;
}

export async function getKnowledgeSelection(contextKey: string): Promise<KnowledgeSelectionSummary> {
	const url = `${SERVER_URL}/api/knowledge-selection?contextKey=${encodeURIComponent(contextKey)}`;
	return (await knowledgeResponse<{ selection: KnowledgeSelectionSummary }>(await fetch(url))).selection;
}

export async function updateKnowledgeSelection(selection: KnowledgeSelectionSummary, selectedBindingIds: string[]): Promise<KnowledgeSelectionSummary> {
	return (await knowledgeResponse<{ selection: KnowledgeSelectionSummary }>(await fetch(`${SERVER_URL}/api/knowledge-selection`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ contextKey: selection.contextKey, expectedRevision: selection.revision, selectedBindingIds }),
	}))).selection;
}

export async function updateKnowledgeDescription(binding: KnowledgeBindingSummary, description: string): Promise<KnowledgeBindingSummary> {
	return (await knowledgeResponse<{ binding: KnowledgeBindingSummary }>(await fetch(`${SERVER_URL}/api/knowledge/${encodeURIComponent(binding.id)}`, {
		method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ description, expectedRevision: binding.bindingRevision }),
	}))).binding;
}

export async function revokeKnowledgeBinding(binding: KnowledgeBindingSummary): Promise<void> {
	await knowledgeResponse(await fetch(`${SERVER_URL}/api/knowledge/${encodeURIComponent(binding.id)}`, {
		method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: binding.bindingRevision }),
	}));
}

export async function listKnowledgeTree(id: string): Promise<KnowledgeTreeNode[]> {
	return (await knowledgeResponse<{ tree: KnowledgeTreeNode[] }>(await fetch(`${SERVER_URL}/api/knowledge/${encodeURIComponent(id)}/tree`))).tree;
}

export type KnowledgeNoteVersion = "observed" | "accepted";

export interface KnowledgeNote {
	path: string;
	content: string;
	size: number;
	version: KnowledgeNoteVersion;
	contentHash: string;
	status: KnowledgeNoteStatus;
	acceptedAt?: string;
}

export async function readKnowledgeNote(id: string, notePath: string, version: KnowledgeNoteVersion = "observed"): Promise<KnowledgeNote> {
	const url = `${SERVER_URL}/api/knowledge/${encodeURIComponent(id)}/note?path=${encodeURIComponent(notePath)}&version=${version}`;
	return (await knowledgeResponse<{ note: KnowledgeNote }>(await fetch(url))).note;
}

export async function saveKnowledgeNote(id: string, input: { path: string; content: string; expectedHash: string }): Promise<{ note: KnowledgeNote; syncWarning?: string }> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/knowledge/${encodeURIComponent(id)}/note`, {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
	}));
}

export interface KnowledgeObservedFile {
	path: string;
	hash: string;
	size: number;
	state: KnowledgeNoteStatus;
	declaredId?: string;
	title?: string;
	/** 平台自动同步的内部快照标识，用于固定编译来源。 */
	acceptanceId?: string;
	/** 库根的契约 / 首页 / 日志：在文件树里可见，但不计入笔记数。 */
	control?: boolean;
}

export interface KnowledgeObservations {
	scannedAt: string;
	acceptanceRevision: number;
	files: KnowledgeObservedFile[];
	duplicates: Array<{ declaredId: string; paths: string[] }>;
}

/** 只读取观察快照；服务端在从未扫描时会顺带完成首次扫描。 */
export async function getKnowledgeObservations(id: string): Promise<KnowledgeObservations> {
	return knowledgeResponse<KnowledgeObservations>(await fetch(`${SERVER_URL}/api/knowledge/${encodeURIComponent(id)}/observations`));
}

export interface KnowledgeScanResult {
	scannedAt: string;
	acceptanceRevision: number;
	counts: Record<string, number>;
	duplicates: Array<{ declaredId: string; paths: string[] }>;
}

/** 强制重扫磁盘并返回计数。 */
export async function scanKnowledgeBinding(id: string): Promise<KnowledgeScanResult> {
	return knowledgeResponse<KnowledgeScanResult>(await fetch(`${SERVER_URL}/api/knowledge/${encodeURIComponent(id)}/scan`, { method: "POST" }));
}

export interface KnowledgeDiffLine {
	kind: "same" | "add" | "del";
	text: string;
}

export interface KnowledgeDiffHunk {
	aStart: number;
	aLines: number;
	bStart: number;
	bLines: number;
	lines: KnowledgeDiffLine[];
}

/** 内部固定快照 vs 当前磁盘的行级 diff。 */
export async function getKnowledgeNoteDiff(id: string, notePath: string): Promise<{ path: string; hunks: KnowledgeDiffHunk[]; truncated: boolean }> {
	const url = `${SERVER_URL}/api/knowledge/${encodeURIComponent(id)}/note-diff?path=${encodeURIComponent(notePath)}`;
	return knowledgeResponse(await fetch(url));
}

export interface KnowledgeSearchHit {
	path: string;
	title: string;
	snippet: string;
	score: number;
}

/** 检索当前同步内容。 */
export async function searchKnowledge(id: string, query: string, limit = 20): Promise<{ results: KnowledgeSearchHit[]; truncated: boolean }> {
	const url = `${SERVER_URL}/api/knowledge/${encodeURIComponent(id)}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
	return knowledgeResponse(await fetch(url));
}

export type KnowledgeLinkResolution =
	| { status: "ok"; note: { path: string; title: string }; anchor?: string }
	| { status: "ambiguous"; candidates: Array<{ path: string; title: string }> }
	| { status: "broken" }
	| { status: "out_of_scope" };

export async function resolveKnowledgeLink(id: string, from: string, link: string, kind: "wiki" | "md"): Promise<KnowledgeLinkResolution> {
	const url = `${SERVER_URL}/api/knowledge/${encodeURIComponent(id)}/resolve?from=${encodeURIComponent(from)}&link=${encodeURIComponent(link)}&kind=${kind}`;
	return knowledgeResponse<KnowledgeLinkResolution>(await fetch(url));
}

export interface KnowledgeBacklink {
	sourcePath: string;
	sourceTitle: string;
	kind: "wiki" | "md";
	snippet: string;
}

export async function getKnowledgeBacklinks(id: string, notePath: string): Promise<KnowledgeBacklink[]> {
	const url = `${SERVER_URL}/api/knowledge/${encodeURIComponent(id)}/backlinks?path=${encodeURIComponent(notePath)}`;
	return (await knowledgeResponse<{ backlinks: KnowledgeBacklink[] }>(await fetch(url))).backlinks;
}

/** 库内图片等二进制资源；直接作为 <img src> 使用。 */
export function knowledgeAssetUrl(id: string, assetPath: string): string {
	return `${SERVER_URL}/api/knowledge/${encodeURIComponent(id)}/asset?path=${encodeURIComponent(assetPath)}`;
}

/** 服务端校验后生成 obsidian:// URI；打开动作由桌面宿主复核执行。 */
export async function createKnowledgeObsidianUri(id: string, notePath: string): Promise<string> {
	return (await knowledgeResponse<{ uri: string }>(await fetch(`${SERVER_URL}/api/knowledge/${encodeURIComponent(id)}/obsidian-uri`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: notePath }),
	}))).uri;
}

// ---- T20 接入管理：探测（10 分钟 TTL）→ 计划 → 应用；UI 在 connect 切片使用 ----

export interface KnowledgeProbeRecord {
	probeId: string;
	ownerId: string;
	canonicalBindingRoot: string;
	/** 目录尚不存在（targetExists:false）时为 null。 */
	rootIdentity: string | null;
	/** false 表示目录尚不存在，将在应用计划时创建（需 intent=create 探测）。 */
	targetExists: boolean;
	profile: "markdown" | "managed-wiki";
	contentRoot: string;
	linkRoot: string;
	obsidianRoot?: string;
	obsidianRootCandidates?: string[];
	markers: {
		hasWiki: boolean;
		hasRaw: boolean;
		hasManifest: boolean;
		hasSchema: boolean;
		hasObsidianRoot: boolean;
		hasObsidianWiki: boolean;
	};
	capabilities: { read: boolean; layoutReady: boolean; structuredPrepare: boolean; publish: boolean };
	warnings: string[];
	createdAt: string;
}

export async function createKnowledgeProbe(path: string, intent?: "bind" | "create"): Promise<{ probeId: string; probe: KnowledgeProbeRecord }> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/knowledge/probes`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(intent ? { path, intent } : { path }),
	}));
}

export interface KnowledgePlanFileItem {
	relativePath: string;
	content: string;
	contentHash: string;
	bytes: number;
}

export interface KnowledgePlan {
	version: 1;
	planId: string;
	ownerId: string;
	probeId: string;
	mode: "bind" | "create";
	name: string;
	description: string;
	canonicalBindingRoot: string;
	/** createRootDir 计划（probe 时目录不存在）为 null，apply 创建目录后重算。 */
	rootIdentity: string | null;
	/** true 表示根目录本身也由本计划创建。 */
	createRootDir?: boolean;
	contentRoot: string;
	linkRoot: string;
	obsidianRoot?: string;
	schemaPresetId?: string;
	filesToCreate: KnowledgePlanFileItem[];
	filesToSkip: Array<{ relativePath: string; reason: string }>;
	warnings: string[];
	createdAt: string;
	planRevision: 1;
}

export async function createKnowledgePlan(input: {
	probeId: string;
	name: string;
	description: string;
	mode?: "bind" | "create";
	obsidianRoot?: string;
	schemaPresetId?: string;
}): Promise<KnowledgePlan> {
	return (await knowledgeResponse<{ plan: KnowledgePlan }>(await fetch(`${SERVER_URL}/api/knowledge/plans`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
	}))).plan;
}

export async function getKnowledgePlan(planId: string): Promise<KnowledgePlan> {
	return (await knowledgeResponse<{ plan: KnowledgePlan }>(await fetch(`${SERVER_URL}/api/knowledge/plans/${encodeURIComponent(planId)}`))).plan;
}

export interface KnowledgeApplyReceipt {
	relativePath: string;
	status: "created" | "skipped_exists" | "failed";
	error?: string;
}

export async function applyKnowledgePlan(planId: string): Promise<{ binding: KnowledgeBindingSummary; receipts: KnowledgeApplyReceipt[] }> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/knowledge/plans/${encodeURIComponent(planId)}/apply`, { method: "POST" }));
}

// ---- T21/K05 结构：预置清单、生效结构、影响预览与库内结构保存 ----

export type KnowledgeSchemaFieldType = "text" | "date" | "datetime" | "text_list" | "source_refs" | "note_refs" | "enum";

export interface KnowledgeSchemaField {
	name: string;
	type: KnowledgeSchemaFieldType;
	required: boolean;
	values?: string[];
	requiresSourceField?: string;
}

export interface KnowledgeSchemaEntity {
	type: string;
	directory: string;
	fields: KnowledgeSchemaField[];
}

export interface KnowledgeSchemaRelation {
	type: string;
	from?: string;
	to?: string;
	endpoints?: Array<{ from: string; to: string }>;
	inverseName?: string;
	requiresEvidence: boolean;
}

export interface KnowledgeSchemaPreset {
	formatVersion: 1;
	schemaId: string;
	revision: number;
	name: string;
	/** 一句话说明用途（创建向导的结构选择卡片展示）。 */
	description: string;
	entities: KnowledgeSchemaEntity[];
	relations: KnowledgeSchemaRelation[];
}

export interface KnowledgeSchemaPresetSummary extends KnowledgeSchemaPreset {
	hash: string;
}

export async function listKnowledgePresets(): Promise<KnowledgeSchemaPresetSummary[]> {
	return (await knowledgeResponse<{ presets: KnowledgeSchemaPresetSummary[] }>(await fetch(`${SERVER_URL}/api/knowledge/presets`))).presets;
}

export interface KnowledgeEffectiveSchema {
	origin: "vault_declaration" | "none";
	schema?: KnowledgeSchemaPreset;
	schemaRef?: { format: string; id: string; revision: number; hash: string; originPresetId?: string };
	capabilities: { read: boolean; structured: boolean; structuredPrepare: boolean; publish: boolean };
	warnings: string[];
}

export async function getKnowledgeSchema(id: string): Promise<KnowledgeEffectiveSchema> {
	return knowledgeResponse<KnowledgeEffectiveSchema>(await fetch(`${SERVER_URL}/api/knowledge/${encodeURIComponent(id)}/schema`));
}

export interface KnowledgeSchemaChange {
	kind: "entity_added" | "entity_removed" | "entity_directory_changed" | "field_added" | "field_removed" | "field_changed"
		| "relation_added" | "relation_removed" | "relation_changed";
	entity?: string;
	field?: string;
	relation?: string;
	from?: unknown;
	to?: unknown;
}

export interface KnowledgeSchemaImpact {
	changes: KnowledgeSchemaChange[];
	affectedFiles: Array<{ path: string; entity: string; reasons: string[] }>;
	unknownFieldsPreserved: boolean;
	note: string;
}

export async function planKnowledgeSchema(id: string, schema: KnowledgeSchemaPreset): Promise<KnowledgeSchemaImpact> {
	return (await knowledgeResponse<{ impact: KnowledgeSchemaImpact }>(await fetch(`${SERVER_URL}/api/knowledge/${encodeURIComponent(id)}/schema-plans`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ schema }),
	}))).impact;
}

export async function saveKnowledgeSchema(id: string, schema: KnowledgeSchemaPreset, expectedHash: string, expectedAffectedFiles: KnowledgeSchemaImpact["affectedFiles"], acknowledgeAffected: boolean): Promise<KnowledgeSchemaPreset> {
	return (await knowledgeResponse<{ schema: KnowledgeSchemaPreset }>(await fetch(`${SERVER_URL}/api/knowledge/${encodeURIComponent(id)}/schema`, {
		method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ schema, expectedHash, expectedAffectedFiles, acknowledgeAffected }),
	}))).schema;
}

// ---- Wiki 编译 / 审核 / 发布（M3/M4：T30/T31/T33/T40/T42/T44）----
// 错误体沿用 { error, code }；409 的 code 区分 expired / state_conflict / conflict 等。

export type WikiCompileJobStatus = "queued" | "running" | "candidate_ready" | "failed" | "cancelled";

export interface WikiCompileJob {
	id: string;
	operationId: string;
	targetBindingId: string;
	agentId: string;
	task: string;
	status: WikiCompileJobStatus;
	candidateBatchId?: string;
	failureCode?: string;
	createdAt: string;
	updatedAt: string;
}

export type WikiBatchStatus = "candidate" | "pending_review" | "approved" | "publishing" | "published" | "partial" | "conflict" | "rejected" | "returned";

export interface WikiCuratorJob {
	id: string;
	executionMode: "worker" | "background";
	canRetryRegistration?: boolean;
	origin?: { windowId: string; sessionId: string; toolCallId?: string; channel?: "user_input" | "agent_task" };
	operationId: string;
	targetBindingId: string;
	agentId: string;
	task: string;
	status: "queued" | "running" | "submitting" | "pending_review" | "no_changes" | "needs_attention" | "failed" | "cancelled";
	candidateBatchId?: string;
	failureCode?: string;
	diagnostics?: { modelProvider?: string; modelId?: string; modelTurns: number; submitAttempts: number; submitErrors: number; stopReason?: string; errorCategory?: "timeout" | "provider_error" | "aborted" | "output_limit" | "no_submission" };
	jobUrl?: string;
	reviewUrl?: string;
	createdAt: string;
	updatedAt: string;
	title: string;
	bindingName: string;
	displayStatus: "queued" | "running" | "submitting" | "pending" | "approved" | "publishing" | "published" | "rejected" | "returned" | "conflict" | "partial" | "closed" | "nochanges" | "failed" | "cancelled" | "unavailable";
	activityAt: string;
	material?: string;
	materialUnavailable?: boolean;
	materialIsRequest?: boolean;
	publication?: { id: string; state: string; finishedAt?: string; applied: number; total: number };
	retryOf?: string;
	parentBatchId?: string;
	sources?: Array<{ id: string; kind: string; title: string; byteSize: number }>;
	result?: { added: number; updated: number; deleted: number; directories: number; attachments: number };
	review?: { status: WikiBatchStatus; updatedAt: string; enteredReviewAt: string; decidedAt?: string; conflictReason?: string; feedback?: string; revisionJobId?: string; newBatchId?: string; files: Array<{ path: string; title: string; operation: string; kind: "image" | "markdown"; category: string; publicationStatus?: string }> };

}

export async function createWikiCuratorJob(input: {
	operationId: string; bindingId: string; agentId: string; task: string; material?: string; uploads?: MessageAttachmentInput[];
}): Promise<{ job: WikiCuratorJob; replayed?: boolean }> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/wiki/curator-jobs`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
	}));
}

export async function listWikiCuratorJobs(bindingId?: string): Promise<WikiCuratorJob[]> {
	return (await knowledgeResponse<{ jobs: WikiCuratorJob[] }>(await fetch(`${SERVER_URL}/api/wiki/curator-jobs${bindingId ? `?bindingId=${encodeURIComponent(bindingId)}` : ""}`))).jobs;
}

export interface WikiCuratorTaskPage {
	jobs: WikiCuratorJob[]; total: number; offset: number; limit: number;
	counts: Record<"all" | "active" | "pending" | "ended" | "failed", number>;
}
export async function listWikiCuratorTaskPage(input: { bindingId?: string; q?: string; group?: string; since?: string; limit?: number; offset?: number }): Promise<WikiCuratorTaskPage> {
	const query = new URLSearchParams();
	for (const [key,value] of Object.entries(input)) if (value !== undefined && value !== "") query.set(key,String(value));
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/wiki/curator-jobs?${query}`));
}

export async function getWikiCuratorJob(id: string): Promise<{ job: WikiCuratorJob }> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/wiki/curator-jobs/${encodeURIComponent(id)}`));
}

export async function cancelWikiCuratorJob(id: string): Promise<{ job: WikiCuratorJob }> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/wiki/curator-jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }));
}

export async function retryWikiCuratorJob(id: string, operationId: string): Promise<{ job: WikiCuratorJob; replayed: boolean }> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/wiki/curator-jobs/${encodeURIComponent(id)}/retry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId }) }));
}

export interface WikiBatchFile {
	kind?: "markdown" | "image";
	mediaType?: string;
	sourceIds?: string[];
	operation: "create" | "update" | "delete";
	targetPath: string;
	expectedHashOrAbsent: string | null;
	candidateHash: string | null;
	blobRef: string | null;
}

export interface WikiPublicationBatch {
	id: string;
	revision: number;
	bindingId: string;
	manifestHash: string;
	rootIdentity: string;
	files: WikiBatchFile[];
	sourceSnapshots: string[];
	schemaHash?: string;
	bindingRevision: number;
	trustRevision: number;
	dependencyGroups: string[][];
	validationReceipt: string;
	compilerVersion: string;
	parentBatchId?: string;
	status: WikiBatchStatus;
}

export interface WikiBatchSummary {
	conflictClosure?: { operationId: string; actorId: string; closedAt: string };
	id: string;
	bindingId: string;
	bindingName?: string;
	bindingAvailability?: KnowledgeBindingSummary["availability"];
	title?: string;
	status: WikiBatchStatus;
	/** 账本代际：批次内容每次变化 +1；审核时作为 expectedBatchRevision 栅栏。 */
	revision: number;
	manifestHash: string;
	fileCount: number;
	enteredReviewAt: string;
	reviewDeadline: string;
	decidedAt?: string;
	decisionId?: string;
	publishRequestedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface WikiBatchDetail extends WikiBatchSummary {
	conflictBlockedReason?: string;
	batch: WikiPublicationBatch;
	returnRequest?: { feedback: string; jobId?: string; newBatchId?: string; operationId: string; actorId: string; reviewedFiles: string[]; createdAt: string };
	parentBatchId?: string;
}

export interface WikiBatchMarkdownView {
	kind?: "markdown";
	path: string;
	operation: "create" | "update" | "delete";
	candidate: { content: string; hash: string };
	baseline: { content: string; hash: string } | null;
	hunks: KnowledgeDiffHunk[];
	truncated: boolean;
}

export interface WikiBatchImageView {
	kind: "image";
	path: string;
	operation: "create" | "update";
	candidate: { hash: string; mediaType: string; base64: string };
	baseline: { hash: string } | null;
	sourceIds?: string[];
}

export type WikiBatchFileView = WikiBatchMarkdownView | WikiBatchImageView;

export function wikiBatchAssetUrl(batchId: string, path: string): string {
	return `${SERVER_URL}/api/wiki/batches/${encodeURIComponent(batchId)}/assets?path=${encodeURIComponent(path)}`;
}

export function knowledgeHistoryAssetUrl(bindingId: string, versionId: string, path: string): string {
	return `${SERVER_URL}/api/knowledge/${encodeURIComponent(bindingId)}/history/${encodeURIComponent(versionId)}/assets?path=${encodeURIComponent(path)}`;
}

export interface WikiReviewDecision {
	id: string;
	batchId: string;
	revision: number;
	manifestHash: string;
	actorId: string;
	decidedAt: string;
	decision: "approve" | "reject";
	reviewedFiles: string[];
	expectedTargets: string[];
	policyRevision: number;
}

export interface WikiReviewResponse extends WikiBatchDetail {
	decision: WikiReviewDecision;
	replayed: boolean;
	publish?: { accepted: boolean; note?: string };
}

export type WikiPublicationState = "queued" | "running" | "published" | "partial" | "conflict" | "unknown";

export interface WikiPublicationSummary {
	id: string;
	batchId: string;
	bindingId: string;
	state: WikiPublicationState;
	journalRef: string;
	fileCount: number;
	committedGroups: number;
	createdAt: string;
	updatedAt: string;
	finishedAt?: string;
}

export type WikiPublishFileStatus = "pending" | "applied" | "failed" | "conflict" | "uncertain" | "rejected" | "rolled_back";

export interface WikiPublishReceipt {
	step: "preflight" | "before_image" | "write" | "verify" | "rollback" | "reconcile";
	at: string;
	detail?: string;
}

export interface WikiPublishFileRecord {
	targetPath: string;
	operation: "create" | "update" | "delete";
	candidateHash: string | null;
	baselineHash: string | null;
	beforeImageRef: string | null;
	status: WikiPublishFileStatus;
	receipts: WikiPublishReceipt[];
	error?: string;
}

export interface WikiPublicationDetail extends Omit<WikiPublicationSummary, "committedGroups"> {
	stopReason?: string;
	conflictReason?: "review_window_expired" | "publish_rejected" | "publish_preflight" | "publish_interrupted" | "publish_external" | "publish_uncertain";
	/** Current comparison, not a reconstruction of the historic failure. */
	currentContextChanges?: string[];
	reviewId: string;
	idempotencyKey: string;
	files: WikiPublishFileRecord[];
	committedGroups: string[][];
	results: Array<{ path: string; beforeHash: string | null; afterHash: string | null; status: string; receiptRef?: string }>;
}

export async function createWikiCompileJob(input: {
	operationId: string; bindingId: string; agentId: string; task: string; sourceAcceptanceIds: string[];
}): Promise<{ job: WikiCompileJob; replayed: boolean }> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/wiki/compile-jobs`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
	}));
}

export async function listWikiCompileJobs(bindingId?: string): Promise<WikiCompileJob[]> {
	const query = bindingId ? `?bindingId=${encodeURIComponent(bindingId)}` : "";
	return (await knowledgeResponse<{ jobs: WikiCompileJob[] }>(await fetch(`${SERVER_URL}/api/wiki/compile-jobs${query}`))).jobs;
}

export async function getWikiCompileJob(id: string): Promise<{ job: WikiCompileJob; batch?: WikiPublicationBatch }> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/wiki/compile-jobs/${encodeURIComponent(id)}`));
}

export async function cancelWikiCompileJob(id: string): Promise<WikiCompileJob> {
	return (await knowledgeResponse<{ job: WikiCompileJob }>(await fetch(`${SERVER_URL}/api/wiki/compile-jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }))).job;
}

export async function listWikiBatches(bindingId?: string): Promise<WikiBatchSummary[]> {
	const query = bindingId ? `?bindingId=${encodeURIComponent(bindingId)}` : "";
	return (await knowledgeResponse<{ batches: WikiBatchSummary[] }>(await fetch(`${SERVER_URL}/api/wiki/batches${query}`))).batches;
}

export type WikiReviewStatusFilter = "pending" | "needs_action" | "processed" | "all";

export interface WikiBatchPage {
	batches: WikiBatchSummary[];
	filteredTotal: number;
	pendingCount: number;
	needsActionCount: number;
	processedCount: number;
	total: number;
	limit: number;
	offset: number;
}

export async function listWikiBatchPage(input: {
	bindingId?: string; status?: WikiReviewStatusFilter; q?: string; limit?: number; offset?: number;
} = {}): Promise<WikiBatchPage> {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== "") query.set(key, String(value));
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/wiki/batches?${query.toString()}`));
}

export async function getWikiBatch(id: string): Promise<WikiBatchDetail> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/wiki/batches/${encodeURIComponent(id)}`));
}

export async function getWikiBatchFile(batchId: string, targetPath: string): Promise<WikiBatchFileView> {
	const url = `${SERVER_URL}/api/wiki/batches/${encodeURIComponent(batchId)}/file?path=${encodeURIComponent(targetPath)}`;
	return knowledgeResponse(await fetch(url));
}

export interface WikiBatchSources {
	sources: Array<{
		id: string; kind: "text" | "markdown" | "image" | "pdf"; title: string; originalHash: string;
		derivedFrom?: string; textHash?: string; status: string; locations: Array<{ kind: "lines"; startLine: number; endLine: number } | { kind: "image_region"; page?: number; segmentId?: string; startLine?: number; endLine?: number; x?: number; y?: number; width?: number; height?: number }>; warnings: string[]; content?: string; base64?: string; mediaType: string;
		extraction?: { extractorId: string; version: number; modelRef: string; originalHash: string; artifactHash: string; warnings: string[] };
	}>;
	origin: { windowId: string; sessionId: string; sessionAvailable: boolean } | null;
}

export async function getWikiBatchSources(id: string): Promise<WikiBatchSources> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/wiki/batches/${encodeURIComponent(id)}/sources`));
}

export async function requestWikiRevision(batchId: string, input: {
	operationId: string; manifestHash: string; expectedBatchRevision: number; feedback: string; reviewedFiles: string[];
}): Promise<{ job: WikiCuratorJob; replayed: boolean }> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/wiki/batches/${encodeURIComponent(batchId)}/revisions`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
	}));
}

export async function closeWikiConflict(batchId: string, input: { operationId: string; manifestHash: string; expectedBatchRevision: number }): Promise<WikiBatchDetail> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/wiki/batches/${encodeURIComponent(batchId)}/close-conflict`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
	}));
}

export interface KnowledgeHistoryVersion {
	id: string; noteId: string; revision: number; relativePath: string; contentHash: string; actorId: string;
	previousPath?: string;
	channel: "initial" | "agent_publish" | "external_sync" | "manual_edit"; acceptedAt: string; createdAt: string; operationId: string; batchId?: string; summary: string; sourceIds: string[]; current: boolean;
	actorName?: string;
	changeKind?: "create" | "update" | "rename" | "delete";
	deleted?: boolean;
}
export interface KnowledgeHistoryDetail {
	version: KnowledgeHistoryVersion; content: string; previousContent?: string; previousVersionId?: string;
	diff: { hunks: KnowledgeDiffHunk[]; truncated: boolean };
}
export async function listKnowledgeHistory(bindingId: string, path: string): Promise<{ noteId: string | null; currentVersionId: string | null; versions: KnowledgeHistoryVersion[] }> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/knowledge/${encodeURIComponent(bindingId)}/history?path=${encodeURIComponent(path)}`));
}
export async function getKnowledgeHistoryVersion(bindingId: string, versionId: string): Promise<KnowledgeHistoryDetail> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/knowledge/${encodeURIComponent(bindingId)}/history/${encodeURIComponent(versionId)}`));
}

/** 提交审核决定；409 code=expired（超期）/ state_conflict（revision/manifest 变化或已有决定）。 */
export async function submitWikiReview(batchId: string, input: {
	operationId: string; decision: "approve" | "reject"; manifestHash: string; expectedBatchRevision: number; reviewedFiles: string[];
}): Promise<WikiReviewResponse> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/wiki/batches/${encodeURIComponent(batchId)}/reviews`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
	}));
}

export async function listWikiPublications(bindingId?: string): Promise<WikiPublicationSummary[]> {
	const query = bindingId ? `?bindingId=${encodeURIComponent(bindingId)}` : "";
	return (await knowledgeResponse<{ publications: WikiPublicationSummary[] }>(await fetch(`${SERVER_URL}/api/wiki/publications${query}`))).publications;
}

export async function getWikiPublication(id: string): Promise<WikiPublicationDetail> {
	return knowledgeResponse(await fetch(`${SERVER_URL}/api/wiki/publications/${encodeURIComponent(id)}`));
}

export interface HealthInfo {
	ok: boolean;
	service: string;
	/** Bundled pi SDK version; omitted when the server cannot resolve it. */
	piVersion?: string;
}

export async function getHealth(): Promise<HealthInfo> {
	const res = await fetch(`${SERVER_URL}/api/health`);
	if (!res.ok) throw new Error(`health check failed: ${res.status}`);
	return (await res.json()) as HealthInfo;
}

export async function getViewerIdentity(): Promise<ViewerIdentity> {
	const res = await fetch(`${SERVER_URL}/api/identity`);
	if (!res.ok) throw new Error(`get identity failed: ${res.status}`);
	return (await res.json()) as ViewerIdentity;
}

export function viewerAvatarUrl(version: number): string {
	return `${SERVER_URL}/api/identity/avatar?v=${version}`;
}

async function viewerIdentityResponse(response: Response): Promise<ViewerIdentity> {
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `更新个人资料失败 (${response.status})`);
	}
	return (await response.json()) as ViewerIdentity;
}

export async function updateViewerProfile(displayName: string): Promise<ViewerIdentity> {
	return viewerIdentityResponse(await fetch(`${SERVER_URL}/api/identity/profile`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ displayName }),
	}));
}

export async function uploadViewerAvatar(file: File): Promise<ViewerIdentity> {
	if (file.size > 2 * 1024 * 1024) throw new Error("头像不能超过 2 MB");
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = "";
	for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	return viewerIdentityResponse(await fetch(`${SERVER_URL}/api/identity/avatar`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ data: btoa(binary) }),
	}));
}

export async function deleteViewerAvatar(): Promise<ViewerIdentity> {
	return viewerIdentityResponse(await fetch(`${SERVER_URL}/api/identity/avatar`, { method: "DELETE" }));
}

export async function listSessions(): Promise<SessionSummary[]> {
	const res = await fetch(`${SERVER_URL}/api/sessions`);
	if (!res.ok) throw new Error(`list sessions failed: ${res.status}`);
	return ((await res.json()) as { sessions: SessionSummary[] }).sessions;
}

export async function listManagerWorks(): Promise<ManagerWorkIndexItem[]> {
	const res = await fetch(`${SERVER_URL}/api/rooms/solo/work-index`);
	if (!res.ok) throw new Error(`list Manager works failed: ${res.status}`);
	return ((await res.json()) as { works: ManagerWorkIndexItem[] }).works;
}

export async function listModels(): Promise<ModelSummary[]> {
	const res = await fetch(`${SERVER_URL}/api/models`);
	if (!res.ok) throw new Error(`list models failed: ${res.status}`);
	return ((await res.json()) as { models: ModelSummary[] }).models;
}

/** Full catalog models for one provider (no auth needed), matching its modelCount. */
export async function listProviderModels(providerId: string): Promise<ModelSummary[]> {
	const res = await fetch(`${SERVER_URL}/api/providers/${providerId}/models`);
	if (!res.ok) throw new Error(`list provider models failed: ${res.status}`);
	return ((await res.json()) as { models: ModelSummary[] }).models;
}

export async function listProviders(): Promise<ProviderSummary[]> {
	const res = await fetch(`${SERVER_URL}/api/providers`);
	if (!res.ok) throw new Error(`list providers failed: ${res.status}`);
	return ((await res.json()) as { providers: ProviderSummary[] }).providers;
}

export async function setProviderKey(providerId: string, apiKey: string): Promise<number> {
	const res = await fetch(`${SERVER_URL}/api/providers/${providerId}/key`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ apiKey }),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `set api key failed: ${res.status}`);
	}
	return ((await res.json()) as { ok: boolean; availableCount: number }).availableCount;
}

export async function deleteProviderKey(providerId: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/providers/${providerId}/key`, { method: "DELETE" });
	if (!res.ok) throw new Error(`delete api key failed: ${res.status}`);
}

/** Fired on window after provider keys change so the composer picker refetches. */
export const MODELS_CHANGED_EVENT = "puddingteams:models-changed";

// ---- 自定义 Provider（models.json 控制面） ----

export async function listCustomProviders(): Promise<{ providers: CustomProviderRecord[]; revision: string }> {
	const res = await fetch(`${SERVER_URL}/api/providers/custom`);
	await ensureOk(res, "list custom providers failed");
	return (await res.json()) as { providers: CustomProviderRecord[]; revision: string };
}

export async function upsertCustomProvider(id: string, input: CustomProviderInput, expectedRevision: string): Promise<CustomProviderRecord> {
	const res = await fetch(`${SERVER_URL}/api/providers/custom/${encodeURIComponent(id)}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...input, expectedRevision }),
	});
	await ensureOk(res, "save custom provider failed");
	const data = (await res.json()) as { provider?: CustomProviderRecord };
	return data.provider!;
}

export async function deleteCustomProvider(id: string, expectedRevision: string): Promise<{ recoveryPending: boolean }> {
	const res = await fetch(`${SERVER_URL}/api/providers/custom/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "x-expected-revision": expectedRevision } });
	await ensureOk(res, "delete custom provider failed");
	return { recoveryPending: res.status === 202 };
}

export interface ProviderProbeResult {
	ok: boolean;
	status?: number;
	latencyMs?: number;
	error?: string;
}

export async function testProviderConnection(input: {
	baseUrl: string;
	apiKey?: string;
	providerId?: string;
}): Promise<ProviderProbeResult> {
	const res = await fetch(`${SERVER_URL}/api/providers/test`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	return (await res.json()) as ProviderProbeResult;
}

export async function discoverProviderModels(input: {
	baseUrl: string;
	apiKey?: string;
	providerId?: string;
}): Promise<{ ok: boolean; error?: string; models: Array<{ id: string; name?: string }> }> {
	const res = await fetch(`${SERVER_URL}/api/providers/discover`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	return (await res.json()) as { ok: boolean; error?: string; models: Array<{ id: string; name?: string }> };
}

export async function deleteSession(sessionId: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}`, { method: "DELETE" });
	if (!res.ok) throw new Error(`delete session failed: ${res.status}`);
}

export async function setSessionModel(sessionId: string, model: string): Promise<string> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/model`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model }),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(sessionApiError(body?.error, `set model failed: ${res.status}`));
	}
	const body = (await res.json().catch(() => null)) as { model?: { id?: unknown } } | null;
	if (typeof body?.model?.id !== "string" || !body.model.id) throw new Error("模型已提交，但服务端响应未确认当前模型；请刷新会话核对");
	return body.model.id;
}

/** 会话级 thinking level（§10.6）：composer 对该 Session 的选择，服务端按模型能力 clamp 后返回生效档位。 */
export async function setSessionThinkingLevel(sessionId: string, thinkingLevel: string): Promise<string> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/thinking-level`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ thinkingLevel }),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(sessionApiError(body?.error, `set thinking level failed: ${res.status}`));
	}
	const body = (await res.json().catch(() => null)) as { thinkingLevel?: unknown } | null;
	if (typeof body?.thinkingLevel !== "string" || !body.thinkingLevel) throw new Error("思考强度已提交，但服务端响应未确认当前档位；请刷新会话核对");
	return body.thinkingLevel;
}

export interface RecoveredToolResult {
	toolCallId: string;
	toolName: string;
	text: string;
	details?: Record<string, unknown>;
	isError: boolean;
}

export interface AbortSessionResult {
	aborted: boolean;
	reconciledToolResults: number;
}

export class SessionMessagesError extends Error {
	constructor(message: string, readonly status: number, readonly code?: string) {
		super(message);
		this.name = "SessionMessagesError";
	}
}

export async function fetchMessages(sessionId: string): Promise<{ messages: unknown[]; running: boolean; unansweredUserMessage: boolean; unfinishedAssistantTurn: boolean; runningToolCallIds: string[]; recoveredToolResults: RecoveredToolResult[] }> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/messages`);
	const body = (await res.json()) as { messages?: unknown[]; running?: boolean; unansweredUserMessage?: boolean; unfinishedAssistantTurn?: boolean; runningToolCallIds?: string[]; recoveredToolResults?: RecoveredToolResult[]; error?: string };
	if (!res.ok) throw new SessionMessagesError(sessionApiError(body.error, `fetch messages failed: ${res.status}`), res.status, body.error);
	return {
		messages: body.messages ?? [],
		running: body.running === true,
		unansweredUserMessage: body.unansweredUserMessage === true,
		unfinishedAssistantTurn: body.unfinishedAssistantTurn === true,
		runningToolCallIds: body.runningToolCallIds ?? [],
		recoveredToolResults: body.recoveredToolResults ?? [],
	};
}

export interface SessionSlashCommand {
	name: string;
	description: string;
	source: "skill";
}

export async function listSessionCommands(sessionId: string): Promise<SessionSlashCommand[]> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/commands`);
	if (!res.ok) throw new Error(`fetch commands failed: ${res.status}`);
	return ((await res.json()) as { commands?: SessionSlashCommand[] }).commands ?? [];
}

export interface MessageAttachmentInput {
	filename: string;
	mediaType?: string;
	data: string;
}

export class MessageDeliveryUnconfirmedError extends Error {
	constructor(reason: string) {
		super(`发送结果未确认，请先核对会话历史，再决定是否重新发送。${reason}`);
		this.name = "MessageDeliveryUnconfirmedError";
	}
}

export class MessageOperationRejectedError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "MessageOperationRejectedError";
	}
}

function sessionApiError(error: string | undefined, fallback: string): string {
	return error === "session_context_inactive" ? "该会话属于另一个项目，请先切回对应项目" : (error ?? fallback);
}

export async function sendMessage(sessionId: string, content: string, attachments: MessageAttachmentInput[], operationId: string): Promise<void> {
	let res: Response;
	try {
		res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", "idempotency-key": operationId },
			body: JSON.stringify({ content, attachments }),
		});
	} catch (error) {
		throw new MessageDeliveryUnconfirmedError(error instanceof Error ? error.message : String(error));
	}
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
		if (body?.error === "session_context_inactive") throw new Error(sessionApiError(body.error, "session context inactive"));
		if (res.status === 404) throw new Error("会话不存在，请重新打开对话");
		if (body?.code === "message_operation_required") throw new Error("发送请求缺少操作身份，请刷新页面后重试");
		if (body?.code === "message_operation_rejected") throw new MessageOperationRejectedError(body.error ?? "消息未通过发送前检查");
		throw new MessageDeliveryUnconfirmedError(sessionApiError(body?.error, `send message failed: ${res.status}`));
	}
}

export async function abortSession(sessionId: string): Promise<AbortSessionResult> {
	let res: Response;
	try {
		res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/abort`, {
			method: "POST",
			signal: AbortSignal.timeout(15_000),
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === "TimeoutError") throw new Error("停止请求超时，任务状态尚未确认，请刷新后重试");
		throw err;
	}
	const body = (await res.json().catch(() => null)) as (AbortSessionResult & { error?: string }) | null;
	if (!res.ok) throw new Error(sessionApiError(body?.error, `stop session failed: ${res.status}`));
	if (!body?.aborted) throw new Error(body?.error ?? "服务端未确认任务已停止");
	return body;
}

/** Cancel one delegated worker Run without aborting the manager Session. */
export async function cancelDelegation(delegationId: string, expectedGoalId?: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/delegations/${encodeURIComponent(delegationId)}/cancel`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ expectedGoalId }),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `cancel delegation failed: ${res.status}`);
	}
}

export async function reconcileDelegation(delegationId: string, expectedGoalId?: string): Promise<{ executionState: string }> {
	const res = await fetch(`${SERVER_URL}/api/delegations/${encodeURIComponent(delegationId)}/reconcile`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedGoalId }),
	});
	const body = (await res.json().catch(() => null)) as { executionState?: string; error?: string } | null;
	if (!res.ok) throw new Error(body?.error ?? `reconcile delegation failed: ${res.status}`);
	return { executionState: body?.executionState ?? "observation_lost" };
}

export async function takeoverDelegation(delegationId: string, rationale: string, expectedGoalId?: string): Promise<{ executionState: string }> {
	const res = await fetch(`${SERVER_URL}/api/delegations/${encodeURIComponent(delegationId)}/takeover`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ expectedGoalId, confirmation: "upstream_stopped", rationale }),
	});
	const body = (await res.json().catch(() => null)) as { executionState?: string; error?: string } | null;
	if (!res.ok) throw new Error(body?.error ?? `take over delegation failed: ${res.status}`);
	return { executionState: body?.executionState ?? "cancelled" };
}

export function sessionWsUrl(sessionId: string): string {
	return `${SERVER_URL.replace(/^http/, "ws")}/api/sessions/${sessionId}/ws`;
}

// ---- worker 执行过程可视化（pi 会话 / spawn 活动时间线，只读） ----

export interface WorkerProcessInfo {
	delegationId: string;
	managerSessionId: string;
	goalId?: string;
	agentId: string;
	executionState: ExecutionState;
	workerStarted: boolean;
	readOnlyAssessment?: "verified" | "unverified_user_accepted" | "not_required";
	/** 后端根据 Delegation 与 WorkState 生成的权威三轴投影。 */
	trustProjection: CollaborationTrustProjection;
	receipt?: ExecutionReceiptView;
	sessionHandle?: string;
	/** 委托创建时间（ISO）：worker 会话跨任务续接，用它切出本次委托的消息。 */
	createdAt: string;
	live: boolean;
	view: "session" | "timeline";
}

export interface WorkerProcessListItem extends WorkerProcessInfo {
	updatedAt: string;
	task?: string;
	intent?: string;
	expectedOutcome?: string;
}

export interface RuntimeFileItem {
	name: string;
	path: string;
	extension: string;
	size?: number;
	updatedAt?: string;
	state: "available" | "deleted";
	preview: "markdown" | "json" | "csv" | "text" | "external";
}

export interface ArtifactListItem {
	id: string;
	name: string;
	kind?: string;
	size?: number;
	origin: "push" | "observe";
	producer: string;
	delegationId: string;
	windowId: string;
	workspaceId?: string;
	contentHash: string;
	createdAt: string;
}

/** Execution / Verification / Settlement are intentionally independent axes. */
export type ExecutionState =
	| "admitted" | "waiting_admission" | "running" | "waiting_input" | "reported_completed" | "reported_failed"
	| "cancel_requested" | "reconciling" | "cancelled" | "observation_lost";
/** WorkItem UI also has states before any Delegation exists or while its trace is unavailable. */
export type ExecutionProjectionState = ExecutionState | "not_started" | "unknown";
export type VerificationProjection =
	| "not_required" | "unverified" | "pending" | "running" | "waiting_input"
	| "passed" | "failed" | "blocked" | "stale";
export type SettlementState = "not_required" | "pending" | "submitted" | "accepted" | "revision" | "blocked" | "cancelled";
export interface CollaborationTrustProjection {
	execution: ExecutionProjectionState;
	verification: VerificationProjection;
	settlement: SettlementState;
}
export interface ExecutionReceiptView {
	contractHash?: string;
	collectionStatus?: "complete" | "partial" | "failed";
	integrity?: "unknown" | "clean" | "suspect" | "violation";
	issues?: string[];
	sealedAt?: string;
	artifactCapture?: Array<{ artifactId?: string; status?: string; issue?: string }>;
	workerStarted?: boolean;
}

/** Exact trust fields emitted by the server, or locally projected from WorkState. */
export interface CollaborationProjectionSource {
	executionState: ExecutionProjectionState;
	trustProjection?: CollaborationTrustProjection;
	verification?: VerificationProjection;
	settlement?: SettlementState;
	receipt?: ExecutionReceiptView;
}

export function collaborationTrustOf(source: CollaborationProjectionSource): CollaborationTrustProjection {
	return source.trustProjection ?? {
		execution: source.executionState,
		verification: source.verification ?? "unverified",
		settlement: source.settlement ?? "not_required",
	};
}

export function isObservationLost(source: CollaborationProjectionSource): boolean {
	return collaborationTrustOf(source).execution === "observation_lost";
}

export async function fetchRoomDelegationProcesses(
	roomId: string,
	managerSessionId?: string,
): Promise<WorkerProcessListItem[]> {
	const params = new URLSearchParams();
	if (managerSessionId) params.set("managerSessionId", managerSessionId);
	const query = params.size ? `?${params.toString()}` : "";
	const res = await fetch(`${SERVER_URL}/api/rooms/${encodeURIComponent(roomId)}/delegation-processes${query}`);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const body = (await res.json()) as { delegations?: WorkerProcessListItem[] };
	return body.delegations ?? [];
}

export async function fetchDelegationProcess(delegationId: string): Promise<WorkerProcessInfo> {
	const res = await fetch(`${SERVER_URL}/api/delegations/${delegationId}/process`);
	if (!res.ok) throw new Error(`fetch delegation process failed: ${res.status}`);
	return (await res.json()) as WorkerProcessInfo;
}

async function responseError(res: Response, fallback: string): Promise<Error> {
	const body = await res.json().catch(() => undefined) as { error?: string } | undefined;
	return new Error(body?.error ?? `${fallback}: ${res.status}`);
}

export async function fetchDelegationFiles(delegationId: string): Promise<{ files: RuntimeFileItem[]; scopeAvailable: boolean }> {
	const res = await fetch(`${SERVER_URL}/api/delegations/${encodeURIComponent(delegationId)}/files`);
	if (!res.ok) throw await responseError(res, "fetch runtime files failed");
	return (await res.json()) as { files: RuntimeFileItem[]; scopeAvailable: boolean };
}

export async function fetchRuntimeFileContent(delegationId: string, relativePath: string): Promise<string> {
	const params = new URLSearchParams({ path: relativePath });
	const res = await fetch(`${SERVER_URL}/api/delegations/${encodeURIComponent(delegationId)}/files/content?${params.toString()}`);
	if (!res.ok) throw await responseError(res, "fetch runtime file failed");
	return res.text();
}

export async function openRuntimeFile(delegationId: string, relativePath: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/delegations/${encodeURIComponent(delegationId)}/files/open`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path: relativePath }),
	});
	if (!res.ok) throw await responseError(res, "open runtime file failed");
}

export async function fetchDelegationArtifacts(delegationId: string): Promise<ArtifactListItem[]> {
	const params = new URLSearchParams({ delegationId });
	const res = await fetch(`${SERVER_URL}/api/artifacts?${params.toString()}`);
	if (!res.ok) throw await responseError(res, "fetch artifacts failed");
	return ((await res.json()) as { artifacts?: ArtifactListItem[] }).artifacts ?? [];
}

export async function fetchArtifactContent(artifactId: string): Promise<string> {
	const res = await fetch(`${SERVER_URL}/api/artifacts/${encodeURIComponent(artifactId)}/preview`);
	if (!res.ok) throw await responseError(res, "fetch artifact failed");
	return res.text();
}

export function artifactContentUrl(artifactId: string): string {
	return `${SERVER_URL}/api/artifacts/${encodeURIComponent(artifactId)}/content`;
}

export async function openArtifact(artifactId: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/artifacts/${encodeURIComponent(artifactId)}/open`, { method: "POST" });
	if (!res.ok) throw await responseError(res, "open artifact failed");
}

export async function fetchDelegationProcessMessages(
	delegationId: string,
	full = false,
): Promise<{ messages: unknown[]; live: boolean; agentId: string; status: string; createdAt: string; runningToolCallIds: string[] }> {
	const res = await fetch(`${SERVER_URL}/api/delegations/${encodeURIComponent(delegationId)}/process/messages?scope=${full ? "full" : "delegation"}`);
	if (!res.ok) {
		const error = await responseError(res, "fetch worker messages failed");
		if (!full && res.status === 409) throw new WorkerProcessScopeError(error.message);
		throw error;
	}
	const body = (await res.json()) as {
		messages: unknown[];
		live: boolean;
		agentId: string;
		executionState: string;
		createdAt: string;
		runningToolCallIds?: string[];
	};
	return { messages: body.messages, live: body.live, agentId: body.agentId, status: body.executionState, createdAt: body.createdAt, runningToolCallIds: body.runningToolCallIds ?? [] };
}

export class WorkerProcessScopeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerProcessScopeError";
	}
}

export function delegationProcessWsUrl(delegationId: string, full = false): string {
	return `${SERVER_URL.replace(/^http/, "ws")}/api/delegations/${encodeURIComponent(delegationId)}/process/ws?scope=${full ? "full" : "delegation"}`;
}

export async function fetchDelegationTimeline(delegationId: string): Promise<{
	events: DelegationTimelineEvent[];
	live: boolean;
	agentId: string;
	status: string;
	createdAt: string;
}> {
	const res = await fetch(`${SERVER_URL}/api/delegations/${encodeURIComponent(delegationId)}/process/timeline`);
	if (!res.ok) throw new Error(`fetch delegation timeline failed: ${res.status}`);
	const body = (await res.json()) as {
		events: DelegationTimelineEvent[];
		live: boolean;
		agentId: string;
		executionState: string;
		createdAt: string;
	};
	return { events: body.events, live: body.live, agentId: body.agentId, status: body.executionState, createdAt: body.createdAt };
}

export function delegationTimelineWsUrl(delegationId: string, afterSeq = 0): string {
	return `${SERVER_URL.replace(/^http/, "ws")}/api/delegations/${encodeURIComponent(delegationId)}/process/timeline/ws?afterSeq=${afterSeq}`;
}

export async function getSettings(): Promise<{
	defaultProvider?: string;
	defaultModel?: string;
}> {
	const res = await fetch(`${SERVER_URL}/api/settings`);
	if (!res.ok) throw new Error(`get settings failed: ${res.status}`);
	return (await res.json()) as { defaultProvider?: string; defaultModel?: string };
}

export async function setDefaultModel(provider: string, model: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/settings/model`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider, model }),
	});
	if (!res.ok) throw new Error(`set default model failed: ${res.status}`);
}

export interface HarnessSettings {
	codeSearch: { defaultProvider: "builtin" | "fff" };
	workerResults: {
		offloadThresholdTokens: number;
		previewHeadTokens: number;
		previewTailTokens: number;
		readChunkTokens: number;
	};
	goalActivation: {
		solo: "manager_explicit" | "user_explicit" | "disabled";
		group: "manager_explicit" | "user_explicit" | "disabled";
		direct: "user_explicit" | "disabled";
		confirmWhenAmbiguous: boolean;
	};
	goalRecovery: {
		mode: "safe_auto" | "manual";
		directMode: "manual";
		resumeLeaseMs: number;
		operationRetentionDays: number;
		maxOperationsPerSession: number;
	};
	verification: {
		enabled: boolean;
		defaultWorkItemMode: "manager_review" | "independent_evidence_review";
		defaultFinalGoalMode: "manager_review" | "independent_evidence_review" | "environment_verified";
		trigger: "manager_request" | "auto_on_submission";
		reviewers: { evidenceModel: string; cliAgentId: string; requireRoomMember: boolean };
		cliEnvironmentMode: "isolated_copy" | "same_target_guarded";
		isolation: { requireFreshSession: boolean; forbidExecutorContinuation: boolean; requireDifferentAgent: boolean };
		firstReleaseScope: "cli_code_first";
		unavailableAction: "block";
		artifactCaptureFailure: "partial_receipt_block";
		remoteRunUnknown: "observation_lost_effect_unknown";
		cancelUnconfirmed: "cancel_requested_observation_lost";
	};
	workspaceExecution: {
		readOnlyDefault: "read_only_shared";
		gitWriteDefault: "isolated_worktree" | "exclusive_write";
		nonGitWriteDefault: "exclusive_write";
		leaseTimeoutMs: number;
		promotion: { autoApplyAfterAcceptance: boolean; autoCommit: boolean; autoPush: boolean; conflictAction: "block_preserve_changes" };
		managerWritePolicy: "delegation_required";
	};
}
export interface HarnessSettingsSnapshot { harness: HarnessSettings; revision: string }

export class HarnessSettingsConflictError extends Error {
	constructor(readonly currentRevision?: string) {
		super("Harness 设置已被其他客户端修改，请核对最新配置");
		this.name = "HarnessSettingsConflictError";
	}
}

export async function getHarnessSettings(): Promise<HarnessSettingsSnapshot> {
	const res = await fetch(`${SERVER_URL}/api/settings/harness`);
	const body = (await res.json()) as Partial<HarnessSettingsSnapshot> & { error?: string };
	if (!res.ok || !body.harness || !body.revision) throw new Error(body.error ?? "get harness settings failed");
	return { harness: body.harness, revision: body.revision };
}
export async function setHarnessSettings(settings: Partial<HarnessSettings>, expectedRevision: string): Promise<HarnessSettingsSnapshot> {
	const res = await fetch(`${SERVER_URL}/api/settings/harness`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...settings, expectedRevision }),
	});
	const body = (await res.json()) as Partial<HarnessSettingsSnapshot> & { error?: string; currentRevision?: string };
	if (res.status === 409) throw new HarnessSettingsConflictError(body.currentRevision);
	if (!res.ok || !body.harness || !body.revision) throw new Error(body.error ?? "update harness settings failed");
	return { harness: body.harness, revision: body.revision };
}

// ---- agents registry (teams.json) ----

export async function listAgents(): Promise<AgentConfig[]> {
	const res = await fetch(`${SERVER_URL}/api/agents`);
	if (!res.ok) throw new Error(`list agents failed: ${res.status}`);
	return ((await res.json()) as { agents: AgentConfig[] }).agents;
}

export class AgentCreationUncertainError extends Error {
	constructor(message: string, readonly agentName: string) {
		super(message);
		this.name = "AgentCreationUncertainError";
	}
}

export async function createAgent(agent: AgentConfig, operationId?: string): Promise<AgentConfig> {
	const res = await fetch(`${SERVER_URL}/api/agents`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(operationId ? { "Idempotency-Key": operationId } : {}) },
		body: JSON.stringify(agent),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string; code?: string; agentName?: string } | null;
		if (res.status === 409 && body?.code === "agent_creation_uncertain" && body.agentName) throw new AgentCreationUncertainError(body.error ?? "Agent 创建结果未确认", body.agentName);
		throw new Error(body?.error ?? `create agent failed: ${res.status}`);
	}
	return ((await res.json()) as { agent: AgentConfig }).agent;
}

/** 复制 Worker 的非敏感配置；服务端生成新身份并让副本保持停用。 */
export async function duplicateAgent(name: string): Promise<AgentConfig> {
	const data = await postJson<MutationResponse>(
		`/api/agents/${encodeURIComponent(name)}/duplicate`,
		{},
		"duplicate agent failed",
	);
	return data.agent;
}

export async function updateAgent(name: string, agent: AgentConfig): Promise<AgentConfig> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...agent, expectedRevision: agent.extensionRevision ?? 0 }),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		if (res.status === 409) throw new ApiConflictError(body?.error ?? "Agent 配置已变化", {});
		throw new Error(body?.error ?? `update agent failed: ${res.status}`);
	}
	return ((await res.json()) as { agent: AgentConfig }).agent;
}

export async function deleteAgent(name: string): Promise<{ credentialsCleanup: "complete" | "pending" }> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}`, { method: "DELETE" });
	await ensureOk(res, "delete agent failed");
	return res.status === 202 ? { credentialsCleanup: "pending" } : { credentialsCleanup: "complete" };
}

export async function probeAgent(name: string): Promise<AgentProbeResult> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/probe`, { method: "POST" });
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `probe failed: ${res.status}`);
	}
	return ((await res.json()) as { probe: AgentProbeResult }).probe;
}

export interface AgentExecutionCapabilities {
	agentId: string;
	agentRevision: number;
	connectorId: string;
	transport: "sdk" | "spawn" | "http";
	workspace: {
		honorsInvocationCwd: boolean;
		readOnlyEnforcement: "none" | "sandbox" | "remote_policy";
		isolatedWorkspace: boolean;
		mutationInterception: "none" | "pre_mutation";
	};
	verificationSource: "connector_declared";
	securityWarnings: string[];
}

export async function getAgentExecutionCapabilities(name: string): Promise<AgentExecutionCapabilities> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/execution-capabilities`);
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `load execution capabilities failed: ${res.status}`);
	}
	return (await res.json()) as AgentExecutionCapabilities;
}

export async function listAgentConnectorConfigOptions(name: string, field: string): Promise<DriverConfigOption[]> {
	const res = await fetch(
		`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/connector/config-options/${encodeURIComponent(field)}`,
	);
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `load Connector options failed: ${res.status}`);
	}
	const body = (await res.json()) as { options?: DriverConfigOption[] };
	return body.options ?? [];
}

export interface WorkerRuntimeModelState {
	supported: boolean;
	modelCatalog: "pi" | "driver";
	effortLevels: string[];
	settings: { model?: string; effort?: string };
	defaults: { model?: string; effort?: string };
}

async function workerModelResponse<T>(response: Response): Promise<T> {
	const body = await response.json();
	if (!response.ok) throw new Error(body.error ?? `会话模型设置失败：${response.status}`);
	return body as T;
}

export async function getWorkerRuntimeModel(sessionId: string): Promise<WorkerRuntimeModelState> {
	return workerModelResponse(await fetch(`${SERVER_URL}/api/sessions/${encodeURIComponent(sessionId)}/worker-runtime-model`));
}

export async function setWorkerRuntimeModel(sessionId: string, patch: { model?: string | null; effort?: string | null }): Promise<WorkerRuntimeModelState["settings"]> {
	const result = await workerModelResponse<{ settings: WorkerRuntimeModelState["settings"] }>(await fetch(`${SERVER_URL}/api/sessions/${encodeURIComponent(sessionId)}/worker-runtime-model`, {
		method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
	}));
	return result.settings;
}

export async function getWorkerRuntimeModelOptions(sessionId: string): Promise<DriverConfigOption[]> {
	return (await workerModelResponse<{ options: DriverConfigOption[] }>(await fetch(`${SERVER_URL}/api/sessions/${encodeURIComponent(sessionId)}/worker-runtime-model/options`))).options;
}

// ---- Phase 5：Extension 目录与 Connector/Capability 绑定（§10.1） ----

/** 409 冲突错误：附带后端返回的引用方 agents / 进行中 runs（启停、卸载用）。 */
export class ApiConflictError extends Error {
	readonly payload: { agents?: string[]; runs?: ConflictRun[] };
	constructor(message: string, payload: { agents?: string[]; runs?: ConflictRun[] }) {
		super(message);
		this.name = "ApiConflictError";
		this.payload = payload;
	}
}

/** 统一错误解析：409 抛 ApiConflictError，其余抛带后端 error 文案的 Error。 */
async function ensureOk(res: Response, fallback: string): Promise<void> {
	if (res.ok) return;
	const body = (await res.json().catch(() => null)) as
		| { error?: string; agents?: string[]; runs?: ConflictRun[] }
		| null;
	const message = body?.error ?? `${fallback}: ${res.status}`;
	if (res.status === 409) throw new ApiConflictError(message, { agents: body?.agents, runs: body?.runs });
	throw new Error(message);
}

async function postJson<T>(url: string, body: unknown, fallback: string, method = "POST"): Promise<T> {
	const res = await fetch(`${SERVER_URL}${url}`, {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	await ensureOk(res, fallback);
	return (await res.json()) as T;
}

/** Extension 目录：kind 必传，Connector 与 Capability 不得混在同一选择器（§10.1）。 */
export async function listExtensionCatalog(kind: "connector" | "capability"): Promise<CatalogEntry[]> {
	const res = await fetch(`${SERVER_URL}/api/extensions/catalog?kind=${kind}`);
	if (!res.ok) throw new Error(`list extension catalog failed: ${res.status}`);
	return ((await res.json()) as { extensions: CatalogEntry[] }).extensions;
}

/** 已安装扩展贡献的外部系统连接状态（只读，不触发登录或更新）。 */
export async function listExtensionConnections(): Promise<ExtensionConnectionStatus[]> {
	const res = await fetch(`${SERVER_URL}/api/extensions/connections`);
	if (!res.ok) throw new Error(`list extension connections failed: ${res.status}`);
	return ((await res.json()) as { connections: ExtensionConnectionStatus[] }).connections;
}

// ---- 平台托管 MCP Server Catalog ----

export async function listMcpServers(): Promise<McpCatalogResponse> {
	const res = await fetch(`${SERVER_URL}/api/extensions/mcp/servers`);
	const body = (await res.json()) as Partial<McpCatalogResponse> & { error?: string };
	if (!res.ok) throw new Error(body.error ?? `list MCP servers failed: ${res.status}`);
	return body as McpCatalogResponse;
}

export function createMcpServer(input: {
	id: string;
	displayName: string;
	description?: string;
	definition: McpServerDefinition;
	secrets?: Record<string, string>;
}): Promise<McpServerRecord> {
	return postJson<{ server: McpServerRecord }>("/api/extensions/mcp/servers", input, "create MCP server failed")
		.then((result) => result.server);
}

export function updateMcpServer(id: string, input: {
	displayName: string;
	description?: string;
	definition: McpServerDefinition;
	secrets?: Record<string, string>;
}): Promise<McpServerRecord> {
	return postJson<{ server: McpServerRecord }>(
		`/api/extensions/mcp/servers/${encodeURIComponent(id)}`,
		input,
		"update MCP server failed",
		"PUT",
	).then((result) => result.server);
}

export async function deleteMcpServer(id: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/extensions/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
	await ensureOk(res, "delete MCP server failed");
}

export async function getAgentMcpServers(name: string): Promise<{ serverIds: string[]; revision: number }> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/mcp`);
	const body = (await res.json()) as { serverIds?: string[]; revision?: number; error?: string };
	if (!res.ok) throw new Error(body.error ?? `get Agent MCP servers failed: ${res.status}`);
	return { serverIds: body.serverIds ?? [], revision: body.revision ?? 0 };
}

export function putAgentMcpServers(name: string, serverIds: string[], expectedRevision: number): Promise<MutationResponse> {
	return postJson<MutationResponse>(
		`/api/agents/${encodeURIComponent(name)}/mcp`,
		{ serverIds, expectedRevision },
		"save Agent MCP servers failed",
		"PUT",
	);
}

/** 执行连接卡明确声明、且由用户确认触发的动作。 */
export async function runExtensionConnectionAction(
	connection: Pick<ExtensionConnectionStatus, "extensionId" | "connectionId">,
	actionId: string,
): Promise<ExtensionConnectionStatus> {
	const res = await fetch(
		`${SERVER_URL}/api/extensions/${encodeURIComponent(connection.extensionId)}/connections/${encodeURIComponent(connection.connectionId)}/actions/${encodeURIComponent(actionId)}`,
		{ method: "POST" },
	);
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `connection action failed: ${res.status}`);
	}
	return ((await res.json()) as { connection: ExtensionConnectionStatus }).connection;
}

/** 发起、读取或取消插件贡献的授权会话，浏览器不接触上游设备码。 */
export interface FeishuSettingsSnapshot {
	configured: boolean; appId: string; secretConfigured: boolean; scope: string; accountName?: string;
}
async function feishuSettingsRequest(path = "", init?: RequestInit): Promise<FeishuSettingsSnapshot> {
	const response = await fetch(`${SERVER_URL}/api/settings/feishu${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(15_000) });
	const data = await response.json() as FeishuSettingsSnapshot & { error?: string };
	if (!response.ok) throw new Error(data.error ?? "飞书设置请求失败");
	return data;
}
export const getFeishuSettings = () => feishuSettingsRequest();
export const saveFeishuSettings = (input: { appId: string; appSecret?: string; confirmReplace?: boolean }) => feishuSettingsRequest("", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
export const importFeishuConnection = () => feishuSettingsRequest("/import-local", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

export async function extensionAuthorization(
	connection: Pick<ExtensionConnectionStatus, "extensionId" | "connectionId">,
	request: { actionId: string } | { sessionId: string; cancel?: boolean },
	authorizationBase?: string,
): Promise<ExtensionAuthorizationSession | null> {
	const base = `${SERVER_URL}${authorizationBase ?? `/api/extensions/${encodeURIComponent(connection.extensionId)}/connections/${encodeURIComponent(connection.connectionId)}/authorizations`}`;
	const res = await fetch("sessionId" in request ? `${base}/${encodeURIComponent(request.sessionId)}` : base, {
		method: "actionId" in request ? "POST" : request.cancel ? "DELETE" : "GET",
		...( "actionId" in request ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) } : {}),
		cache: "no-store",
		signal: AbortSignal.timeout(40_000),
	});
	if (!res.ok) {
		const body = await res.json().catch(() => null) as { error?: string } | null;
		throw new Error(body?.error ?? "授权状态请求失败，请重试");
	}
	return res.status === 204 ? null : ((await res.json()) as { session: ExtensionAuthorizationSession }).session;
}

/** 从本地目录安装 Extension：link（默认）= 开发者本地链接；copy = 用户安装（复制进数据目录）。 */
export async function installExtension(input: { path: string; versionPin?: string; mode?: "link" | "copy" }): Promise<CatalogEntry> {
	const data = await postJson<{ extension: CatalogEntry }>("/api/extensions/install", input, "install extension failed");
	return data.extension;
}

/** 更新已安装 Extension（可换路径/固定版本）。 */
export async function updateExtension(
	extensionId: string,
	input: { path?: string; versionPin?: string },
): Promise<CatalogEntry> {
	const data = await postJson<{ extension: CatalogEntry }>(
		`/api/extensions/${encodeURIComponent(extensionId)}/update`,
		input,
		"update extension failed",
	);
	return data.extension;
}

/** 卸载 Extension；409 时抛 ApiConflictError（含引用它的 agents/runs）。 */
export async function uninstallExtension(extensionId: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/extensions/${encodeURIComponent(extensionId)}`, { method: "DELETE" });
	await ensureOk(res, "uninstall extension failed");
}

/** 读取 Agent 的 Connector 绑定与对应扩展 manifest（未绑定时均为 null）。 */
export async function getAgentConnector(
	name: string,
): Promise<{ connector: AgentConnectorBinding | null; extension: PuddingTeamsExtensionManifest | null; securityWarnings: string[] }> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/connector`);
	if (!res.ok) throw new Error(`get connector failed: ${res.status}`);
	return (await res.json()) as { connector: AgentConnectorBinding | null; extension: PuddingTeamsExtensionManifest | null; securityWarnings: string[] };
}

/** 设置/更换 Connector 绑定（secrets 明文提交，服务端只存 secretRefs）。 */
export function putAgentConnector(
	name: string,
	input: {
		expectedRevision: number;
		extensionId: string;
		connectorId: string;
		transport: AgentConnectorBinding["transport"];
		config?: Record<string, unknown>;
		secrets?: Record<string, string>;
		versionPin?: string;
	},
): Promise<MutationResponse> {
	return postJson<MutationResponse>(
		`/api/agents/${encodeURIComponent(name)}/connector`,
		input,
		"set connector failed",
		"PUT",
	);
}

/** Capability 绑定列表。 */
export async function listAgentBindings(
	name: string,
): Promise<{ bindings: AgentCapabilityBinding[]; revision: number }> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/extensions`);
	if (!res.ok) throw new Error(`list bindings failed: ${res.status}`);
	return (await res.json()) as { bindings: AgentCapabilityBinding[]; revision: number };
}

/** 新增 Capability 绑定。 */
export function addAgentBinding(
	name: string,
	input: {
		expectedRevision: number;
		extensionId: string;
		capabilityId: string;
		enabled?: boolean;
		config?: Record<string, unknown>;
		activation?: ToolActivation;
		versionPin?: string;
		secrets?: Record<string, string>;
	},
): Promise<MutationResponse> {
	return postJson<MutationResponse>(`/api/agents/${encodeURIComponent(name)}/extensions`, input, "add binding failed");
}

/** 更新 Capability 绑定（enabled/config/activation/versionPin/secrets）。 */
export function patchAgentBinding(
	name: string,
	bindingId: string,
	patch: {
		expectedRevision: number;
		enabled?: boolean;
		config?: Record<string, unknown>;
		activation?: ToolActivation;
		versionPin?: string;
		secrets?: Record<string, string>;
	},
): Promise<MutationResponse> {
	return postJson<MutationResponse>(
		`/api/agents/${encodeURIComponent(name)}/extensions/${encodeURIComponent(bindingId)}`,
		patch,
		"patch binding failed",
		"PATCH",
	);
}

/** 删除 Capability 绑定（保留安装包本身）。 */
export async function deleteAgentBinding(name: string, bindingId: string, expectedRevision: number): Promise<MutationResponse> {
	const res = await fetch(
		`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/extensions/${encodeURIComponent(bindingId)}`,
		{ method: "DELETE", headers: { "x-expected-revision": String(expectedRevision) } },
	);
	await ensureOk(res, "delete binding failed");
	return (await res.json()) as MutationResponse;
}

/** Capability 绑定探测：安装/加载/启用状态与将注册的工具清单。 */
export async function probeAgentBinding(name: string, bindingId: string): Promise<BindingProbeResult> {
	const res = await fetch(
		`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/extensions/${encodeURIComponent(bindingId)}/probe`,
		{ method: "POST" },
	);
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `binding probe failed: ${res.status}`);
	}
	return ((await res.json()) as { probe: BindingProbeResult }).probe;
}

/**
 * 启用/禁用（§9.3.6）：禁用时有进行中 Run 必须显式传 resolve（"keep" 保留 /
 * "cancel" 取消），否则后端 409，抛 ApiConflictError 由 UI 弹确认。
 */
export function setAgentEnabled(
	name: string,
	enabled: boolean,
	expectedRevision: number,
	resolve?: "keep" | "cancel",
): Promise<MutationResponse> {
	return postJson<MutationResponse>(
		`/api/agents/${encodeURIComponent(name)}/enabled`,
		{ enabled, expectedRevision, ...(resolve ? { resolve } : {}) },
		"set enabled failed",
		"PUT",
	);
}

/** pinned manager 可编辑配置（§10.5）：描述 + manager settings 合并更新。 */
export function updateManager(input: {
	expectedRevision: number;
	description?: string;
	manager?: PiManagerSettingsPatch;
	responsibility?: AgentConfig["responsibility"] | null;
	piResources?: PiResourceConfig | null;
}): Promise<MutationResponse> {
	return postJson<MutationResponse>("/api/agents/manager/manager", input, "update manager failed", "PATCH");
}

export async function previewAgentPiResources(name: string, workspaceId?: string): Promise<PiResourcePreview> {
	const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/pi-resources/preview${query}`);
	const body = (await res.json()) as { preview?: PiResourcePreview; error?: string };
	if (!res.ok) throw new Error(body.error ?? `preview pi resources failed: ${res.status}`);
	return body.preview!;
}

export function putAgentPiResources(name: string, piResources: PiResourceConfig | null, expectedRevision: number): Promise<MutationResponse> {
	return postJson<MutationResponse>(
		`/api/agents/${encodeURIComponent(name)}/pi-resources`,
		{ piResources, expectedRevision },
		"save pi resources failed",
		"PUT",
	);
}

/**
 * 统一配置接口（独立配置页，§10.5）：manager 与 pi worker 同构的合并更新。
 * pinned manager 用 manager 键级合并（传 connector 会 400）；pi worker 用
 * connector.config（传 manager 会 400）；piResources 为整体替换，null 清除。
 */
export function putAgentConfig(
	name: string,
	input: {
		expectedRevision: number;
		description?: string;
		displayName?: string | null;
		responsibility?: AgentConfig["responsibility"] | null;
		manager?: PiManagerSettingsPatch;
		connector?: { config?: Record<string, unknown> };
		piResources?: PiResourceConfig | null;
		codeSearch?: AgentConfig["codeSearch"];
	},
): Promise<MutationResponse> {
	return postJson<MutationResponse>(
		`/api/agents/${encodeURIComponent(name)}/config`,
		input,
		"save agent config failed",
		"PUT",
	);
}

// ---- pi 资源库（/api/resources/*）：错误统一 { error }，400/404/409 ----

async function deleteResource(url: string, fallback: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}${url}`, { method: "DELETE" });
	if (res.status === 204) return;
	const body = (await res.json().catch(() => null)) as { error?: string } | null;
	throw new Error(body?.error ?? `${fallback}: ${res.status}`);
}

export async function listSkillLibrary(): Promise<{ skills: SkillEntry[]; diagnostics: ResourceDiagnostic[] }> {
	const res = await fetch(`${SERVER_URL}/api/resources/skills`);
	const body = (await res.json()) as { skills?: SkillEntry[]; diagnostics?: ResourceDiagnostic[]; error?: string };
	if (!res.ok) throw new Error(body.error ?? `list skill library failed: ${res.status}`);
	return { skills: body.skills ?? [], diagnostics: body.diagnostics ?? [] };
}

export function createSkillResource(input: {
	name: string;
	content: string;
	description?: string;
	disableModelInvocation?: boolean;
}): Promise<{ skill: SkillEntry; diagnostics: ResourceDiagnostic[] }> {
	return postJson("/api/resources/skills", input, "create skill failed");
}

export async function getSkillResource(name: string): Promise<SkillDocument> {
	const res = await fetch(`${SERVER_URL}/api/resources/skills/${encodeURIComponent(name)}`);
	const body = (await res.json()) as { skill?: SkillDocument; error?: string };
	if (!res.ok) throw new Error(body.error ?? `get skill failed: ${res.status}`);
	return body.skill!;
}

export function updateSkillResource(
	name: string,
	input: { content: string; description?: string; disableModelInvocation?: boolean },
): Promise<{ skill: SkillEntry; diagnostics: ResourceDiagnostic[] }> {
	return postJson(`/api/resources/skills/${encodeURIComponent(name)}`, input, "update skill failed", "PUT");
}

export function deleteSkillResource(name: string): Promise<void> {
	return deleteResource(`/api/resources/skills/${encodeURIComponent(name)}`, "delete skill failed");
}

export function importSkillResource(path: string): Promise<{ skill: SkillEntry; diagnostics: ResourceDiagnostic[] }> {
	return postJson("/api/resources/skills/import", { path }, "import skill failed");
}

/** 上传 zip 批量导入技能：body 直接传 File/Blob（application/zip）。 */
export async function importSkillsZip(file: Blob): Promise<SkillsZipImportResult> {
	const res = await fetch(`${SERVER_URL}/api/resources/skills/import-zip`, {
		method: "POST",
		headers: { "content-type": "application/zip" },
		body: file,
	});
	const body = (await res.json().catch(() => null)) as (Partial<SkillsZipImportResult> & { error?: string }) | null;
	if (!res.ok) throw new Error(body?.error ?? `import skills zip failed: ${res.status}`);
	return { imported: body?.imported ?? [], skipped: body?.skipped ?? [], diagnostics: body?.diagnostics ?? [] };
}

export async function listTemplateLibrary(): Promise<{ templates: TemplateEntry[]; diagnostics: ResourceDiagnostic[] }> {
	const res = await fetch(`${SERVER_URL}/api/resources/templates`);
	const body = (await res.json()) as { templates?: TemplateEntry[]; diagnostics?: ResourceDiagnostic[]; error?: string };
	if (!res.ok) throw new Error(body.error ?? `list template library failed: ${res.status}`);
	return { templates: body.templates ?? [], diagnostics: body.diagnostics ?? [] };
}

export function createTemplateResource(input: {
	name: string;
	content: string;
	description?: string;
	argumentHint?: string;
}): Promise<{ template: TemplateEntry; diagnostics: ResourceDiagnostic[] }> {
	return postJson("/api/resources/templates", input, "create template failed");
}

export async function getTemplateResource(name: string): Promise<TemplateDocument> {
	const res = await fetch(`${SERVER_URL}/api/resources/templates/${encodeURIComponent(name)}`);
	const body = (await res.json()) as { template?: TemplateDocument; error?: string };
	if (!res.ok) throw new Error(body.error ?? `get template failed: ${res.status}`);
	return body.template!;
}

export function updateTemplateResource(
	name: string,
	input: { content: string; description?: string; argumentHint?: string },
): Promise<{ template: TemplateEntry; diagnostics: ResourceDiagnostic[] }> {
	return postJson(`/api/resources/templates/${encodeURIComponent(name)}`, input, "update template failed", "PUT");
}

export function deleteTemplateResource(name: string): Promise<void> {
	return deleteResource(`/api/resources/templates/${encodeURIComponent(name)}`, "delete template failed");
}

export function importTemplateResource(path: string): Promise<{ template: TemplateEntry; diagnostics: ResourceDiagnostic[] }> {
	return postJson("/api/resources/templates/import", { path }, "import template failed");
}

// ---- encrypted secrets (~/.puddingteams) ----

/** Names of env keys configured for a worker (never the values). */
export async function getAgentSecrets(name: string): Promise<string[]> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/secrets`);
	if (!res.ok) throw new Error(`get secrets failed: ${res.status}`);
	return ((await res.json()) as { configured: string[] }).configured;
}

/** Set env secrets for a worker (AES-256 encrypted at rest). */
export async function setAgentSecrets(name: string, secrets: Record<string, string>): Promise<string[]> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/secrets`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ secrets }),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `set secrets failed: ${res.status}`);
	}
	return ((await res.json()) as { configured: string[] }).configured;
}

/** Remove one env secret for a worker. */
export async function deleteAgentSecret(name: string, key: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/secrets/${encodeURIComponent(key)}`, {
		method: "DELETE",
	});
	if (!res.ok) throw new Error(`delete secret failed: ${res.status}`);
}

// ---- avatars (§11) ----

/** URL for an agent's uploaded avatar; `v` busts the cache after changes. */
export function agentAvatarUrl(name: string, v = 0, defaultRevision?: string): string {
	const revision = defaultRevision ? `&default=${encodeURIComponent(defaultRevision)}` : "";
	return `${SERVER_URL}/api/agents/${encodeURIComponent(name)}/avatar?v=${v}${revision}`;
}

export async function uploadAgentAvatar(name: string, file: File): Promise<AgentConfig> {
	const buf = new Uint8Array(await file.arrayBuffer());
	let bin = "";
	for (let i = 0; i < buf.length; i += 0x8000) {
		bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
	}
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/avatar`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ data: btoa(bin), mediaType: file.type }),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `upload avatar failed: ${res.status}`);
	}
	return ((await res.json()) as { agent: AgentConfig }).agent;
}

export async function deleteAgentAvatar(name: string): Promise<AgentConfig> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/avatar`, { method: "DELETE" });
	if (!res.ok) throw new Error(`delete avatar failed: ${res.status}`);
	return ((await res.json()) as { agent: AgentConfig }).agent;
}

// ---- rooms / windows ----

export async function listRoomsWithContext(): Promise<{ rooms: RoomSummary[]; defaultCwdSnapshot: string }> {
	const res = await fetch(`${SERVER_URL}/api/rooms`);
	if (!res.ok) throw new Error(`list rooms failed: ${res.status}`);
	return (await res.json()) as { rooms: RoomSummary[]; defaultCwdSnapshot: string };
}

export async function listRooms(): Promise<RoomSummary[]> {
	return (await listRoomsWithContext()).rooms;
}

export async function getRoom(id: string): Promise<RoomSummary> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${id}`);
	if (!res.ok) throw new Error(`get room failed: ${res.status}`);
	return ((await res.json()) as { room: RoomSummary }).room;
}

/** Resolve a chat attachment against its room workspace and open it with the
 * operating system's default application. */
export async function openRoomFile(roomId: string, targetPath: string): Promise<string> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${encodeURIComponent(roomId)}/open-file`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path: targetPath }),
	});
	const body = (await res.json().catch(() => null)) as { path?: string; error?: string } | null;
	if (!res.ok) throw new Error(body?.error ?? `open file failed: ${res.status}`);
	if (!body?.path) throw new Error("server did not return the opened file path");
	return body.path;
}

/** 发起对话：direct（单聊）/ group（群聊）。单聊按 worker 去重，命中返回 existed。 */
export class WorkerDisabledError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerDisabledError";
	}
}

export class RoomSelectionStaleError extends Error {
	constructor(message: string, readonly selection: "worker" | "workspace") {
		super(message);
		this.name = "RoomSelectionStaleError";
	}
}

export class RoomSourceStaleError extends Error {
	constructor(message: string, readonly unavailable: boolean) {
		super(message);
		this.name = "RoomSourceStaleError";
	}
}

export class RoomCreationOperationConflictError extends Error {
	constructor(message: string) { super(message); this.name = "RoomCreationOperationConflictError"; }
}

export async function createRoom(input: {
	type: "direct" | "group";
	members: string[];
	workspaceId?: string;
	name?: string;
}, operationId?: string): Promise<{ room: RoomSummary; existed: boolean }> {
	const res = await fetch(`${SERVER_URL}/api/rooms`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(operationId ? { "idempotency-key": operationId } : {}) },
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
		if (res.status === 409 && body?.code === "worker_disabled") {
			throw new WorkerDisabledError(body.error ?? "Worker 已停用，请重新选择");
		}
		if (body?.code === "worker_unavailable" || body?.code === "workspace_unavailable") {
			throw new RoomSelectionStaleError(body.error ?? "发起对话的选择已失效，请重新选择", body.code === "worker_unavailable" ? "worker" : "workspace");
		}
		if (body?.code === "room_operation_conflict" || body?.code === "room_operation_gone") throw new RoomCreationOperationConflictError(body.error ?? "群聊创建操作键不可再用，请核对房间列表");
		throw new Error(body?.error ?? `create room failed: ${res.status}`);
	}
	return (await res.json()) as { room: RoomSummary; existed: boolean };
}

export async function updateRoom(
	id: string,
	patch: { name?: string; members?: string[]; prompt?: string },
): Promise<RoomSummary> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
	if (!res.ok) throw new Error(`update room failed: ${res.status}`);
	return ((await res.json()) as { room: RoomSummary }).room;
}

export async function listWorkspaces(): Promise<WorkspaceRecord[]> {
	const res = await fetch(`${SERVER_URL}/api/workspaces`);
	if (!res.ok) throw new Error(`list workspaces failed: ${res.status}`);
	return ((await res.json()) as { workspaces: WorkspaceRecord[] }).workspaces;
}

export async function browseWorkspaceDirectories(path: string): Promise<WorkspaceDirectoryListing> {
	const res = await fetch(`${SERVER_URL}/api/workspaces/browse?path=${encodeURIComponent(path)}`);
	const body = (await res.json()) as WorkspaceDirectoryListing & { error?: string };
	if (!res.ok) throw new Error(body.error ?? `browse workspace directories failed: ${res.status}`);
	return body;
}

export async function pickWorkspaceDirectory(initialPath: string): Promise<string | undefined> {
	// 桌面宿主：优先用主进程原生目录选择器（Finder/Explorer），比 server 端
	// AppleScript/对话框更自然；浏览器里回退到 server 路由。
	const bridge = getDesktopBridge();
	if (bridge?.pickDirectory) {
		const picked = await bridge.pickDirectory(initialPath);
		return picked ?? undefined;
	}
	const res = await fetch(`${SERVER_URL}/api/workspaces/pick-directory`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ initialPath }),
	});
	const body = (await res.json()) as { path?: string; cancelled?: boolean; error?: string };
	if (!res.ok) throw new Error(body.error ?? `pick workspace directory failed: ${res.status}`);
	return body.cancelled ? undefined : body.path;
}

export async function createWorkspace(input: { path?: string; name?: string; managed?: boolean }): Promise<WorkspaceRecord> {
	const res = await fetch(`${SERVER_URL}/api/workspaces`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	const body = (await res.json()) as { workspace?: WorkspaceRecord; error?: string };
	if (!res.ok) throw new Error(body.error ?? `create workspace failed: ${res.status}`);
	return body.workspace!;
}

/** 信任决策（§7.2）：trusted/denied/pending + approvedResources；响应带撤销影响的活跃会话数。 */
export async function putWorkspaceTrust(
	id: string,
	input: { state: WorkspaceTrustState; approvedResources?: WorkspaceResourceKind[] },
): Promise<{ workspace: WorkspaceRecord; dirtySessions: number }> {
	const res = await fetch(`${SERVER_URL}/api/workspaces/${encodeURIComponent(id)}/trust`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	const body = (await res.json()) as { workspace?: WorkspaceRecord; dirtySessions?: number; error?: string };
	if (!res.ok) throw new Error(body.error ?? `put workspace trust failed: ${res.status}`);
	return { workspace: body.workspace!, dirtySessions: body.dirtySessions ?? 0 };
}

export async function switchRoomWorkspace(
	roomId: string,
	workspaceId: string | null,
	mode: "new_window" | "in_place" = "new_window",
	operationId?: string,
	source?: RoomSummary,
	): Promise<{ room: RoomSummary; existed: boolean; restored: boolean }> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${roomId}/switch-workspace`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(operationId ? { "idempotency-key": operationId } : {}) },
		body: JSON.stringify({ workspaceId, mode, ...(source && mode === "new_window" ? { source: {
			type: source.type,
			name: source.name,
			members: source.members.map((member) => member.name),
			prompt: source.prompt,
			workspaceId: source.workspace?.id ?? null,
			cwdSnapshot: source.cwdSnapshot,
		} } : {}) }),
	});
	const body = (await res.json()) as { room?: RoomSummary; existed?: boolean; restored?: boolean; error?: string; code?: string };
	if (!res.ok) {
		if (body.code === "room_operation_conflict" || body.code === "room_operation_gone") throw new RoomCreationOperationConflictError(body.error ?? "群聊创建操作键不可再用，请核对房间列表");
		if (body.code === "workspace_unavailable" || body.code === "worker_unavailable") throw new RoomSelectionStaleError(body.error ?? "项目或 Worker 选择已失效，请重新选择", body.code === "workspace_unavailable" ? "workspace" : "worker");
		if (body.code === "room_source_changed" || body.code === "room_source_unavailable") throw new RoomSourceStaleError(body.error ?? "来源房间已变化，请刷新后重试", body.code === "room_source_unavailable");
		throw new Error(body.error ?? `switch workspace failed: ${res.status}`);
	}
	return { room: body.room!, existed: body.existed === true, restored: body.restored === true };
}

export async function getDeveloperMode(): Promise<boolean> {
	const res = await fetch(`${SERVER_URL}/api/extensions/developer-mode`);
	if (!res.ok) throw new Error(`get developer mode failed: ${res.status}`);
	return ((await res.json()) as { developerMode: boolean }).developerMode;
}

export async function setDeveloperMode(enabled: boolean): Promise<boolean> {
	const res = await fetch(`${SERVER_URL}/api/extensions/developer-mode`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ enabled }),
	});
	const body = (await res.json()) as { developerMode?: boolean; error?: string };
	if (!res.ok) throw new Error(body.error ?? `set developer mode failed: ${res.status}`);
	return body.developerMode === true;
}

/** 删除窗口（级联删除其全部 pi session）。solo 会被后端拒绝。 */
export async function deleteRoom(id: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${id}`, { method: "DELETE" });
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `delete room failed: ${res.status}`);
	}
}

/** Create a new pi session inside a window and make it the active one. */
export async function createRoomSession(
	roomId: string,
	goal?: { goal: string; completionBoundary: string; reviewMode?: "manager" | "independent"; reviewerModel?: string },
): Promise<SessionSummary> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${roomId}/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json", ...(goal ? { "Idempotency-Key": operationKey("room-goal") } : {}) },
		body: JSON.stringify(goal ?? {}),
	});
	if (!res.ok) throw new Error(`create room session failed: ${res.status}`);
	return ((await res.json()) as { session: SessionSummary }).session;
}

/** Reserve one Manager Session and submit its first message as one retryable operation. */
export class ManagerWorkSubmissionError extends Error {
	constructor(message: string, readonly sessionId: string, readonly code?: string) {
		super(message);
		this.name = "ManagerWorkSubmissionError";
	}
}

export async function createManagerWork(roomId: string, content: string, operationId: string, context: { workspaceId: string | null; cwdSnapshot: string }, modelRef?: string, attachments: MessageAttachmentInput[] = [], thinkingLevel?: string): Promise<string> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${encodeURIComponent(roomId)}/new-work`, {
		method: "POST",
		headers: { "content-type": "application/json", "Idempotency-Key": operationId },
		body: JSON.stringify({ content, ...context, ...(modelRef ? { modelRef } : {}), ...(thinkingLevel ? { thinkingLevel } : {}), attachments }),
	});
	const body = (await res.json()) as { sessionId?: string; error?: string; code?: string };
	if (!res.ok || !body.sessionId) {
		const message = body.error ?? `create Manager work failed: ${res.status}`;
		if (body.sessionId) throw new ManagerWorkSubmissionError(message, body.sessionId, body.code);
		throw new Error(message);
	}
	return body.sessionId;
}

export async function markRoomRead(roomId: string, sessionId: string, activityRevision: number): Promise<{ readRevision: number; activityRevision: number; hasUnreadActivity: boolean }> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${encodeURIComponent(roomId)}/read-watermark`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId, activityRevision }),
	});
	const body = (await res.json()) as { readRevision?: number; activityRevision?: number; hasUnreadActivity?: boolean; error?: string };
	if (!res.ok || body.readRevision === undefined || body.activityRevision === undefined) throw new Error(body.error ?? `mark room read failed: ${res.status}`);
	return { readRevision: body.readRevision, activityRevision: body.activityRevision, hasUnreadActivity: body.hasUnreadActivity === true };
}

export async function getManagerSessionLocation(roomId: string, sessionId: string): Promise<{ roomId: string; sessionId: string; workspaceId: string | null; active: boolean }> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${encodeURIComponent(roomId)}/sessions/${encodeURIComponent(sessionId)}/location`);
	const body = (await res.json()) as { roomId?: string; sessionId?: string; workspaceId?: string | null; active?: boolean; error?: string };
	if (!res.ok || body.roomId !== roomId || body.sessionId !== sessionId) throw new Error(body.error ?? `locate Manager session failed: ${res.status}`);
	return { roomId: body.roomId, sessionId: body.sessionId, workspaceId: body.workspaceId ?? null, active: body.active === true };
}

export async function getSessionWorkState(sessionId: string, goalId?: string): Promise<{
	workState: SessionWorkState | null;
	activeGoalId: string | null;
	goals: SessionGoalSummary[];
	decisions: DecisionRequest[];
	delegations: DelegationTrace[];
}> {
	const query = goalId ? `?goalId=${encodeURIComponent(goalId)}` : "";
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/work-state${query}`);
	const body = (await res.json()) as { workState?: SessionWorkState | null; activeGoalId?: string | null; goals?: SessionGoalSummary[]; decisions?: DecisionRequest[]; delegations?: DelegationTrace[]; error?: string };
	if (!res.ok) throw new Error(body.error ?? `get work state failed: ${res.status}`);
	return { workState: body.workState ?? null, activeGoalId: body.activeGoalId ?? null, goals: body.goals ?? [], decisions: body.decisions ?? [], delegations: body.delegations ?? [] };
}

export async function putSessionWorkState(
	sessionId: string,
	input: Partial<SessionWorkState> & { goal?: string; completionBoundary?: string; revision?: number },
): Promise<SessionWorkState> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/work-state`, {
		method: "PUT",
		headers: { "content-type": "application/json", "Idempotency-Key": operationKey("goal") },
		body: JSON.stringify(input),
	});
	const body = (await res.json()) as { workState?: SessionWorkState; current?: SessionWorkState; error?: string };
	if (!res.ok) throw new Error(body.error ?? `update work state failed: ${res.status}`);
	return body.workState!;
}

export async function answerDecisionRequest(
	decisionId: string,
	answer: string,
	grantedAuthorizationScope?: string,
): Promise<DecisionRequest> {
	const res = await fetch(`${SERVER_URL}/api/decision-requests/${decisionId}/answer`, {
		method: "POST",
		headers: { "content-type": "application/json", "Idempotency-Key": operationKey("decision") },
		body: JSON.stringify({ answer, grantedAuthorizationScope }),
	});
	const body = (await res.json()) as { decision?: DecisionRequest; error?: string };
	if (!res.ok) throw new Error(body.error ?? `answer decision failed: ${res.status}`);
	return body.decision!;
}

function operationKey(kind: string): string {
	return `${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export class WorkStateApiConflictError extends Error {
	constructor(
		message: string,
		readonly expectedRevision: number,
		readonly currentRevision: number,
		readonly current: SessionWorkState,
	) {
		super(message);
		this.name = "WorkStateApiConflictError";
	}
}

export async function reviewWorkItem(
	sessionId: string,
	workItemId: string,
	input: { expectedGoalId: string; expectedRevision: number; expectedEpoch: number; expectedWorkItemRevision: number; expectedSubmissionId: string; verdict: "accepted" | "revision" | "blocked"; summary: string; evidenceRefs?: string[] },
): Promise<SessionWorkState> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/work-items/${encodeURIComponent(workItemId)}/review`, {
		method: "POST",
		headers: { "content-type": "application/json", "Idempotency-Key": operationKey("work-item-review") },
		body: JSON.stringify(input),
	});
	const body = (await res.json()) as { workState?: SessionWorkState; current?: SessionWorkState; expectedRevision?: number; currentRevision?: number; error?: string; code?: string };
	if (!res.ok) {
		if (res.status === 409 && body.code === "stale_goal_state" && body.current && body.expectedRevision !== undefined && body.currentRevision !== undefined) {
			throw new WorkStateApiConflictError(body.error ?? "验收目标已变化", body.expectedRevision, body.currentRevision, body.current);
		}
		throw new Error(body.error ?? `review work item failed: ${res.status}`);
	}
	return body.workState!;
}

export async function interruptGoal(sessionId: string, expectedGoalId: string, expectedRevision: number): Promise<SessionWorkState> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/goal/interrupt`, {
		method: "POST",
		headers: { "content-type": "application/json", "Idempotency-Key": operationKey("goal-interrupt") },
		body: JSON.stringify({ expectedGoalId, expectedRevision, kind: "user" }),
	});
	const body = (await res.json()) as { workState?: SessionWorkState; error?: string };
	if (!res.ok) throw new Error(body.error ?? `interrupt goal failed: ${res.status}`);
	return body.workState!;
}

export async function resumeGoal(sessionId: string, expectedGoalId: string, expectedRevision: number): Promise<SessionWorkState> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/goal/resume`, {
		method: "POST",
		headers: { "content-type": "application/json", "Idempotency-Key": operationKey("goal-resume") },
		body: JSON.stringify({ expectedGoalId, expectedRevision, ownerId: "web-user" }),
	});
	const body = (await res.json()) as { workState?: SessionWorkState; error?: string };
	if (!res.ok) throw new Error(body.error ?? `resume goal failed: ${res.status}`);
	return body.workState!;
}

export async function abandonGoal(sessionId: string, expectedGoalId: string, expectedRevision: number, reason: string): Promise<SessionWorkState> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/goal/abandon`, {
		method: "POST",
		headers: { "content-type": "application/json", "Idempotency-Key": operationKey("goal-abandon") },
		body: JSON.stringify({ expectedGoalId, expectedRevision, reason }),
	});
	const body = (await res.json()) as { workState?: SessionWorkState; error?: string };
	if (!res.ok) throw new Error(body.error ?? `abandon goal failed: ${res.status}`);
	return body.workState!;
}

export async function supersedeGoal(
	sessionId: string,
	input: {
		expectedGoalId: string; expectedRevision: number; reason: string;
		goal: string; completionBoundary: string; reviewMode?: "manager" | "independent"; reviewerModel?: string;
	},
): Promise<{ previous: SessionWorkState; workState: SessionWorkState }> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/goal/supersede`, {
		method: "POST",
		headers: { "content-type": "application/json", "Idempotency-Key": operationKey("goal-supersede") },
		body: JSON.stringify(input),
	});
	const body = (await res.json()) as { previous?: SessionWorkState; workState?: SessionWorkState; error?: string };
	if (!res.ok) throw new Error(body.error ?? `supersede goal failed: ${res.status}`);
	return { previous: body.previous!, workState: body.workState! };
}

/** Switch the active pi session of a window. */
export async function setActiveRoomSession(roomId: string, sessionId: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${encodeURIComponent(roomId)}/sessions/${encodeURIComponent(sessionId)}/activate`, {
		method: "POST",
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `switch session failed: ${res.status}`);
	}
}

/** Delete a pi session inside a window (the last one is protected). */
export async function deleteRoomSession(roomId: string, sessionId: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${roomId}/sessions/${sessionId}`, {
		method: "DELETE",
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `delete room session failed: ${res.status}`);
	}
}

/** Rename a session inside a window without changing the window name. */
export async function renameRoomSession(roomId: string, sessionId: string, name: string): Promise<RoomSession> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${roomId}/sessions/${sessionId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name }),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `rename room session failed: ${res.status}`);
	}
	return ((await res.json()) as { session: RoomSession }).session;
}

// ---- interactions（HITL 审批，§6.4）----

export interface InteractionRequestView {
	requestId: string;
	prompt: string;
	command?: string;
	path?: string;
	risk?: string;
	options?: string[];
}

export interface InteractionView {
	id: string;
	delegationId: string;
	source: "worker" | "platform_policy";
	kind: "permission" | "question" | "confirmation";
	requests: InteractionRequestView[];
	status: "pending" | "responding" | "approved" | "rejected" | "expired" | "failed";
	revision: number;
	expiresAt?: string;
	policySummary?: {
		reasonCode: "read_only_not_enforceable" | "cwd_not_honored";
		allowedActions: Array<"cancel" | "proceed_with_worker" | "select_another_worker">;
		workerStarted: false;
	};
	application?: {
		status: "pending" | "applying" | "applied" | "failed";
		failureCode?: string;
		replacementAgentId?: string;
		replacementDelegationId?: string;
	};
	decision?: { chosenAction: "cancel" | "proceed_with_worker" | "select_another_worker"; replacementAgentId?: string };
	replacementCandidates?: Array<{
		agentId: string;
		displayName: string;
		readOnlyEnforcement: "sandbox" | "remote_policy";
		verificationSource: "connector_declared";
	}>;
}

export interface InteractionDelegationView {
	goalId?: string;
	workerStarted: boolean;
}

/** 列出窗口下的审批卡（页面刷新/对账恢复）。 */
export async function listInteractions(windowId?: string): Promise<InteractionView[]> {
	const qs = windowId ? `?windowId=${encodeURIComponent(windowId)}` : "";
	const res = await fetch(`${SERVER_URL}/api/interactions${qs}`);
	if (!res.ok) throw new Error(`list interactions failed: ${res.status}`);
	return ((await res.json()) as { interactions: InteractionView[] }).interactions;
}

/** 单个审批卡（含 delegation，供刷新恢复）。 */
export async function getInteraction(
	id: string,
): Promise<{ interaction: InteractionView; delegation?: InteractionDelegationView }> {
	const res = await fetch(`${SERVER_URL}/api/interactions/${id}`);
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `get interaction failed: ${res.status}`);
	}
	return (await res.json()) as { interaction: InteractionView; delegation?: InteractionDelegationView };
}

export interface InteractionResponseSubmit {
	requestId: string;
	revision: number;
	expectedGoalId?: string;
	windowId?: string;
	responses: Array<{ requestId: string; action: string; scope?: string; value?: unknown }>;
}

/** 提交审批（approve / reject / confirm）。 */
export async function submitInteractionResponse(
	id: string,
	input: InteractionResponseSubmit,
): Promise<unknown> {
	const res = await fetch(`${SERVER_URL}/api/interactions/${id}/responses`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
		throw new Error(body?.error ?? `submit response failed: ${res.status}`);
	}
	return res.json();
}

/** 取消一个 pending 审批。 */
export async function cancelInteraction(id: string, expectedGoalId?: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/interactions/${id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedGoalId }) });
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `cancel interaction failed: ${res.status}`);
	}
}

export type WebSearchProvider = "tavily" | "deepseek" | "grok";
export interface WebResearchConfig {
 enabled:boolean; fetchEnabled:boolean; defaultScope:"domestic"|"global"; fallbackEnabled:boolean; crossCheckEnabled:boolean; maxProviderAttempts:number;
 domesticOrder:WebSearchProvider[]; globalOrder:WebSearchProvider[]; proxyUrl:string;
 providers:Record<WebSearchProvider,{enabled:boolean;model:string;searchDepth?:"basic"|"advanced";webEnabled?:boolean;xEnabled?:boolean}>;
}
export interface WebResearchGrant { search:boolean; fetch:boolean }
export interface WebResearchTarget { id:string; name:string; kind:"manager"|"worker"; supported:boolean; enabled:boolean; reason?:string }
export interface WebResearchView {
 revision:number; settings:WebResearchConfig;
 grants:Record<string,WebResearchGrant>; targets:WebResearchTarget[];
 providers:Record<WebSearchProvider,{configured:boolean;credentialSource:"network"|"model"|"none";test:{status:"ready"|"error";checkedAt:string;message:string}|null}>;
}
export const WEB_RESEARCH_CHANGED_EVENT = "puddingteams:web-research-changed";
export const WEB_RESEARCH_REVISION_KEY = "puddingteams:web-research-revision";
function publishWebResearchChange(revision:number):void {
 if (typeof window === "undefined") return;
 try { window.localStorage.setItem(WEB_RESEARCH_REVISION_KEY,String(revision)); } catch { /* Availability does not depend on browser storage. */ }
 window.dispatchEvent(new Event(WEB_RESEARCH_CHANGED_EVENT));
}
export async function putWorkerWebResearchGrant(agentId:string,grant:WebResearchGrant,expectedRevision:number):Promise<WebResearchView> {
 const result=await knowledgeResponse<WebResearchView>(await fetch(`${SERVER_URL}/api/settings/web-research/workers/${encodeURIComponent(agentId)}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedRevision,grant})}));
 publishWebResearchChange(result.revision);
 return result;
}
export async function getWebResearchSettings():Promise<WebResearchView> {
 return knowledgeResponse<WebResearchView>(await fetch(`${SERVER_URL}/api/settings/web-research`));
}
export async function saveWebResearchSettings(value:{expectedRevision:number;settings:WebResearchConfig;keys?:Partial<Record<WebSearchProvider,string>>;grants?:Record<string,WebResearchGrant>}):Promise<WebResearchView> {
 const result=await knowledgeResponse<WebResearchView>(await fetch(`${SERVER_URL}/api/settings/web-research`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(value)}));
 publishWebResearchChange(result.revision);
 return result;
}
export async function testWebResearchProvider(provider:WebSearchProvider):Promise<WebResearchView> {
 const result=await knowledgeResponse<WebResearchView>(await fetch(`${SERVER_URL}/api/settings/web-research/${provider}/test`,{method:"POST"}));
 publishWebResearchChange(result.revision);
 return result;
}
export async function testAndSaveWebResearchProvider(provider:WebSearchProvider,value:Parameters<typeof saveWebResearchSettings>[0]):Promise<WebResearchView> {
 const result=await knowledgeResponse<WebResearchView>(await fetch(`${SERVER_URL}/api/settings/web-research/${provider}/test-and-save`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(value)}));
 publishWebResearchChange(result.revision);
 return result;
}
