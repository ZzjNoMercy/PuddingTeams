import type {
	AgentCapabilityBinding,
	AgentConfig,
	AgentConnectorBinding,
	AgentProbeResult,
	BindingProbeResult,
	CatalogEntry,
	ConflictRun,
	CustomProviderInput,
	CustomProviderRecord,
	ModelSummary,
	MutationResponse,
	PiManagerSettings,
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
	SessionSummary,
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
const SERVER_URL =
	process.env.NEXT_PUBLIC_SERVER_URL ??
	(process.env.NODE_ENV === "production" && typeof window !== "undefined"
		? window.location.origin
		: "http://127.0.0.1:8933");

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

export async function listSessions(): Promise<SessionSummary[]> {
	const res = await fetch(`${SERVER_URL}/api/sessions`);
	if (!res.ok) throw new Error(`list sessions failed: ${res.status}`);
	return ((await res.json()) as { sessions: SessionSummary[] }).sessions;
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

export async function listCustomProviders(): Promise<CustomProviderRecord[]> {
	const res = await fetch(`${SERVER_URL}/api/providers/custom`);
	if (!res.ok) throw new Error(`list custom providers failed: ${res.status}`);
	return ((await res.json()) as { providers: CustomProviderRecord[] }).providers;
}

export async function upsertCustomProvider(id: string, input: CustomProviderInput): Promise<CustomProviderRecord> {
	const res = await fetch(`${SERVER_URL}/api/providers/custom/${encodeURIComponent(id)}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	const data = (await res.json()) as { provider?: CustomProviderRecord; error?: string };
	if (!res.ok) throw new Error(data.error ?? `save custom provider failed: ${res.status}`);
	return data.provider!;
}

export async function deleteCustomProvider(id: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/providers/custom/${encodeURIComponent(id)}`, { method: "DELETE" });
	if (!res.ok) {
		const data = (await res.json().catch(() => ({}))) as { error?: string };
		throw new Error(data.error ?? `delete custom provider failed: ${res.status}`);
	}
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

export async function setSessionModel(sessionId: string, model: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/model`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model }),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `set model failed: ${res.status}`);
	}
}

export async function fetchMessages(sessionId: string): Promise<{ messages: unknown[]; runningToolCallIds: string[] }> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/messages`);
	if (!res.ok) throw new Error(`fetch messages failed: ${res.status}`);
	const body = (await res.json()) as { messages: unknown[]; runningToolCallIds?: string[] };
	return { messages: body.messages, runningToolCallIds: body.runningToolCallIds ?? [] };
}

export interface MessageAttachmentInput {
	filename: string;
	mediaType?: string;
	data: string;
}

export async function sendMessage(sessionId: string, content: string, attachments: MessageAttachmentInput[] = []): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content, attachments }),
	});
	if (!res.ok) throw new Error(`send message failed: ${res.status}`);
}

export async function abortSession(sessionId: string): Promise<void> {
	await fetch(`${SERVER_URL}/api/sessions/${sessionId}/abort`, { method: "POST" });
}

export function sessionWsUrl(sessionId: string): string {
	return `${SERVER_URL.replace(/^http/, "ws")}/api/sessions/${sessionId}/ws`;
}

// ---- worker 执行过程可视化（pi worker，只读） ----

export interface WorkerProcessInfo {
	delegationId: string;
	agentId: string;
	status: string;
	sessionHandle?: string;
	/** 委托创建时间（ISO）：worker 会话跨任务续接，用它切出本次委托的消息。 */
	createdAt: string;
	live: boolean;
}

export async function fetchDelegationProcess(delegationId: string): Promise<WorkerProcessInfo> {
	const res = await fetch(`${SERVER_URL}/api/delegations/${delegationId}/process`);
	if (!res.ok) throw new Error(`fetch delegation process failed: ${res.status}`);
	return (await res.json()) as WorkerProcessInfo;
}

export async function fetchDelegationProcessMessages(
	delegationId: string,
): Promise<{ messages: unknown[]; live: boolean; agentId: string; status: string; createdAt: string; runningToolCallIds: string[] }> {
	const res = await fetch(`${SERVER_URL}/api/delegations/${delegationId}/process/messages`);
	if (!res.ok) throw new Error(`fetch worker messages failed: ${res.status}`);
	const body = (await res.json()) as {
		messages: unknown[];
		live: boolean;
		agentId: string;
		status: string;
		createdAt: string;
		runningToolCallIds?: string[];
	};
	return { ...body, runningToolCallIds: body.runningToolCallIds ?? [] };
}

export function delegationProcessWsUrl(delegationId: string): string {
	return `${SERVER_URL.replace(/^http/, "ws")}/api/delegations/${delegationId}/process/ws`;
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

// ---- agents registry (teams.json) ----

export async function listAgents(): Promise<AgentConfig[]> {
	const res = await fetch(`${SERVER_URL}/api/agents`);
	if (!res.ok) throw new Error(`list agents failed: ${res.status}`);
	return ((await res.json()) as { agents: AgentConfig[] }).agents;
}

export async function createAgent(agent: AgentConfig): Promise<AgentConfig> {
	const res = await fetch(`${SERVER_URL}/api/agents`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(agent),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `create agent failed: ${res.status}`);
	}
	return ((await res.json()) as { agent: AgentConfig }).agent;
}

export async function updateAgent(name: string, agent: AgentConfig): Promise<AgentConfig> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(agent),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `update agent failed: ${res.status}`);
	}
	return ((await res.json()) as { agent: AgentConfig }).agent;
}

export async function deleteAgent(name: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}`, { method: "DELETE" });
	if (!res.ok) throw new Error(`delete agent failed: ${res.status}`);
}

export async function probeAgent(name: string): Promise<AgentProbeResult> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/probe`, { method: "POST" });
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `probe failed: ${res.status}`);
	}
	return ((await res.json()) as { probe: AgentProbeResult }).probe;
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
		extensionId: string;
		connectorId: string;
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
export async function deleteAgentBinding(name: string, bindingId: string): Promise<MutationResponse> {
	const res = await fetch(
		`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/extensions/${encodeURIComponent(bindingId)}`,
		{ method: "DELETE" },
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
	resolve?: "keep" | "cancel",
): Promise<MutationResponse> {
	return postJson<MutationResponse>(
		`/api/agents/${encodeURIComponent(name)}/enabled`,
		{ enabled, ...(resolve ? { resolve } : {}) },
		"set enabled failed",
		"PUT",
	);
}

/** pinned manager 可编辑配置（§10.5）：描述 + manager settings 合并更新。 */
export function updateManager(input: {
	description?: string;
	manager?: Partial<PiManagerSettings>;
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

export function putAgentPiResources(name: string, piResources: PiResourceConfig | null): Promise<MutationResponse> {
	return postJson<MutationResponse>(
		`/api/agents/${encodeURIComponent(name)}/pi-resources`,
		{ piResources },
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
		description?: string;
		responsibility?: AgentConfig["responsibility"] | null;
		manager?: Partial<PiManagerSettings>;
		connector?: { config?: Record<string, unknown> };
		piResources?: PiResourceConfig | null;
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
export function agentAvatarUrl(name: string, v = 0): string {
	return `${SERVER_URL}/api/agents/${encodeURIComponent(name)}/avatar?v=${v}`;
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

export async function deleteAgentAvatar(name: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/agents/${encodeURIComponent(name)}/avatar`, { method: "DELETE" });
	if (!res.ok) throw new Error(`delete avatar failed: ${res.status}`);
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
export async function createRoom(input: {
	type: "direct" | "group";
	members: string[];
	workspaceId?: string;
	name?: string;
}): Promise<{ room: RoomSummary; existed: boolean }> {
	const res = await fetch(`${SERVER_URL}/api/rooms`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
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
): Promise<{ room: RoomSummary; existed: boolean }> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${roomId}/switch-workspace`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ workspaceId, mode }),
	});
	const body = (await res.json()) as { room?: RoomSummary; existed?: boolean; error?: string };
	if (!res.ok) throw new Error(body.error ?? `switch workspace failed: ${res.status}`);
	return { room: body.room!, existed: body.existed === true };
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
		headers: { "content-type": "application/json" },
		body: JSON.stringify(goal ?? {}),
	});
	if (!res.ok) throw new Error(`create room session failed: ${res.status}`);
	return ((await res.json()) as { session: SessionSummary }).session;
}

export async function getSessionWorkState(sessionId: string): Promise<{
	workState: SessionWorkState | null;
	decisions: DecisionRequest[];
	delegations: DelegationTrace[];
}> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/work-state`);
	const body = (await res.json()) as { workState?: SessionWorkState | null; decisions?: DecisionRequest[]; delegations?: DelegationTrace[]; error?: string };
	if (!res.ok) throw new Error(body.error ?? `get work state failed: ${res.status}`);
	return { workState: body.workState ?? null, decisions: body.decisions ?? [], delegations: body.delegations ?? [] };
}

export async function putSessionWorkState(
	sessionId: string,
	input: Partial<SessionWorkState> & { goal?: string; completionBoundary?: string; revision?: number },
): Promise<SessionWorkState> {
	const res = await fetch(`${SERVER_URL}/api/sessions/${sessionId}/work-state`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
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
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ answer, grantedAuthorizationScope }),
	});
	const body = (await res.json()) as { decision?: DecisionRequest; error?: string };
	if (!res.ok) throw new Error(body.error ?? `answer decision failed: ${res.status}`);
	return body.decision!;
}

/** Switch the active pi session of a window. */
export async function setActiveRoomSession(roomId: string, sessionId: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/rooms/${roomId}/sessions/${sessionId}/activate`, {
		method: "POST",
	});
	if (!res.ok) throw new Error(`switch session failed: ${res.status}`);
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
	kind: "permission" | "question" | "confirmation";
	requests: InteractionRequestView[];
	status: "pending" | "responding" | "approved" | "rejected" | "expired" | "failed";
	revision: number;
	expiresAt?: string;
}

export interface InteractionDelegationView {
	id: string;
	windowId: string;
	agentId: string;
	status: string;
	createdAt: string;
	updatedAt: string;
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
	windowId?: string;
	responses: Array<{ requestId: string; action: string; scope?: string }>;
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
export async function cancelInteraction(id: string): Promise<void> {
	const res = await fetch(`${SERVER_URL}/api/interactions/${id}/cancel`, { method: "POST" });
	if (!res.ok) {
		const body = (await res.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error ?? `cancel interaction failed: ${res.status}`);
	}
}
