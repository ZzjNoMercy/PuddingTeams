import type { FastifyInstance } from "fastify";
import path from "node:path";
import {
	AVATAR_MAX_BYTES,
	MANAGER_AGENT_NAME,
	TeamsStore,
	agentIdFromDisplayName,
	type AgentConfig,
} from "../store/teams.js";
import { CredentialsStore } from "../store/credentials.js";
import type { AgentRuntime } from "../agent-runtime/runtime.js";
import type { AgentInvoker } from "../agent-runtime/invoker.js";
import type { ExtensionRegistry } from "../agent-runtime/extension-registry.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import {
	capabilityBindingStateDir,
	type AgentCapabilityBinding,
	type AgentConnectorBinding,
} from "../agent-runtime/extensions.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { previewPiResources } from "../pi-bridge/pi-resources.js";
import { PI_CONNECTOR_ID } from "../agent-runtime/pi-extension.js";

/** 头像回退用的 connector id：有绑定用绑定；pinned manager / pi worker 归 pi。 */
function avatarConnectorId(agent: AgentConfig): string | undefined {
	return agent.connector?.connectorId ?? (agent.invoke?.type === "pi" ? PI_CONNECTOR_ID : undefined);
}

export interface AgentsRouteDeps {
	credentials?: CredentialsStore;
	/** 禁用保护需要查询/取消 active/waiting Run（§9.3.6）。 */
	runtime?: AgentRuntime;
	/** Connector 绑定的 Driver probe 与 driverFor 解析。 */
	invoker?: AgentInvoker;
	/** Connector/Capability 绑定校验安装包存在与 kind。 */
	extensions?: ExtensionRegistry;
	/** 写操作后同步撤权并统计受影响 manager Session（§10.1）。 */
	sessions?: PiSessionStore;
	/** Capability 自管认证状态的 binding 级隔离根目录。 */
	capabilityStateRoot?: string;
}

interface MutationResponse {
	agent: AgentConfig;
	revision: number;
	affectedSessions: { affectedSessions: number; activeNow: number; reloadPending: number };
	securityWarnings: string[];
}

const SECRET_KEY = /^[A-Z0-9_]+$/;

/** Connector config 的用户可见风险。cwd 是运行上下文，不能替代 Agent 自身权限机制。 */
function connectorSecurityWarnings(agent: AgentConfig): string[] {
	const binding = agent.connector;
	if (!binding) return [];
	if (binding.connectorId === "claude-code") {
		const mode = typeof binding.config.permissionMode === "string" ? binding.config.permissionMode : "bypassPermissions";
		if (mode === "bypassPermissions") {
			return [
				"Claude Code 当前使用 bypassPermissions：它会绕过 Claude 自身的权限确认。Workspace/cwd 只决定工作目录，不构成强制文件访问边界。仅在信任项目与任务时使用。",
			];
		}
	}
	if (binding.connectorId === "codex") {
		const sandbox = typeof binding.config.sandbox === "string" ? binding.config.sandbox : "workspace-write";
		if (sandbox === "danger-full-access") {
			return [
				"Codex 当前使用 danger-full-access：Codex 自身沙箱已关闭，Workspace/cwd 不能限制它访问项目外文件。",
			];
		}
	}
	return [];
}

/** Thin HTTP facade over the worker registry (agents.json) + Phase 5 管理 API（§10.1）。 */
export function registerAgentsRoutes(app: FastifyInstance, teams: TeamsStore, deps: AgentsRouteDeps = {}): void {
	const { credentials, runtime, invoker, extensions, sessions, capabilityStateRoot } = deps;

	/** 给 API 的 Agent 视图补充包内默认头像事实；不写回 agents.json。 */
	function presentAgent(agent: AgentConfig): AgentConfig & { hasDefaultAvatar?: true } {
		const connectorId = avatarConnectorId(agent);
		return !agent.avatar && connectorId && extensions?.hasConnectorAvatar(connectorId)
			? { ...agent, hasDefaultAvatar: true }
			: agent;
	}

	function connectorBindingIssue(binding: unknown): string | undefined {
		if (!binding || typeof binding !== "object" || Array.isArray(binding)) return undefined;
		const value = binding as Record<string, unknown>;
		const extensionId = typeof value.extensionId === "string" ? value.extensionId : "";
		const connectorId = typeof value.connectorId === "string" ? value.connectorId : "";
		const transport = typeof value.transport === "string" ? value.transport : "";
		if (!extensionId || !connectorId || !transport) return "connector 必须声明 extensionId、connectorId 与 transport";
		const manifest = extensions?.manifestOf(extensionId);
		if (!manifest) return extensions ? `extension「${extensionId}」未安装` : undefined;
		if (manifest.kind !== "connector" || manifest.connector.id !== connectorId) {
			return `extension「${extensionId}」不包含 connector「${connectorId}」`;
		}
		if (!(manifest.connector.supportedTransports as string[]).includes(transport)) {
			return `connector「${connectorId}」不支持 transport「${transport}」`;
		}
		return undefined;
	}

	/**
	 * 写操作统一响应（§10.1）：先同步撤权，再带 extensionRevision 与受影响
	 * manager Session 统计（active_now / reload_pending）。
	 */
	async function mutationReply(agent: AgentConfig): Promise<MutationResponse> {
		if (sessions) await sessions.syncAgentConfigChange();
		const affectedSessions = sessions
			? sessions.agentSessionStats(agent.name)
			: { affectedSessions: 0, activeNow: 0, reloadPending: 0 };
		return { agent: presentAgent(agent), revision: agent.extensionRevision ?? 0, affectedSessions, securityWarnings: connectorSecurityWarnings(agent) };
	}

	function notFoundOr400(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown): unknown {
		const msg = err instanceof Error ? err.message : String(err);
		return reply.code(msg.includes("not found") || msg.includes("不存在") ? 404 : 400).send({ error: msg });
	}

	/** secret 明文只进 CredentialsStore，Agent 配置里只留 secretRefs（key→key 引用）。 */
	async function applySecrets(
		name: string,
		secrets: Record<string, string> | undefined,
		existingRefs: Record<string, string> | undefined,
		allowedKeys?: ReadonlySet<string>,
	): Promise<Record<string, string> | undefined> {
		const refs = { ...(existingRefs ?? {}) };
		if (allowedKeys) {
			for (const key of Object.keys(refs)) {
				if (allowedKeys.has(key)) continue;
				delete refs[key];
				await credentials?.removeSecret(name, key);
			}
		}
		if (secrets === undefined) return Object.keys(refs).length > 0 ? refs : undefined;
		if (!credentials) throw new Error("secrets store not configured");
		for (const [k, v] of Object.entries(secrets)) {
			if (typeof v !== "string") throw new Error(`secret "${k}" must be a string`);
			if (!SECRET_KEY.test(k)) throw new Error(`secret key "${k}" must be UPPER_SNAKE (env var name)`);
			if (allowedKeys && !allowedKeys.has(k)) throw new Error(`secret "${k}" is not declared by this extension`);
		}
		await credentials.setSecrets(name, secrets);
		for (const k of Object.keys(secrets)) refs[k] = k;
		return Object.keys(refs).length > 0 ? refs : undefined;
	}

	app.get("/api/agents", async () => {
		const agents = await teams.listAgents();
		// §11：未上传头像但 connector 声明了包内默认头像时，标记 hasDefaultAvatar，
		// 前端据此走 avatar URL（GET avatar 路由会回退到包内资源）。
		if (!extensions) return { agents };
		return { agents: agents.map(presentAgent) };
	});

	app.get<{ Params: { name: string } }>("/api/agents/:name/execution-capabilities", async (req, reply) => {
		const agent = await teams.getAgent(req.params.name);
		if (!agent) return reply.code(404).send({ error: "agent not found" });
		if (!invoker) return reply.code(503).send({ error: "Agent Runtime 未启用" });
		try {
			const capabilities = await invoker.capabilitiesFor(agent.name);
			if (!capabilities) return reply.code(404).send({ error: "Connector driver unavailable" });
			const workspace = capabilities.workspace ?? {
				honorsInvocationCwd: false,
				readOnlyEnforcement: "none" as const,
				isolatedWorkspace: false,
			};
			return {
				agentId: agent.name,
				agentRevision: agent.extensionRevision ?? 0,
				connectorId: agent.connector?.connectorId ?? agent.name,
				transport: capabilities.transport,
				workspace: { ...workspace, mutationInterception: capabilities.workspace?.mutationInterception ?? "none" },
				verificationSource: "connector_declared",
				securityWarnings: connectorSecurityWarnings(agent),
			};
		} catch (err) {
			return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.post<{ Body: Partial<Record<string, unknown>> }>("/api/agents", async (req, reply) => {
		try {
			const body = { ...(req.body ?? {}) } as Record<string, unknown>;
			let generateUniqueName = false;
			const connectorIssue = connectorBindingIssue(body.connector);
			if (connectorIssue) return reply.code(400).send({ error: connectorIssue });
			// name/id 解耦：未显式给内部 id（name）时，从显示名派生并保证唯一。
			if (typeof body.name !== "string" || !body.name.trim()) {
				const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
				if (!displayName) return reply.code(400).send({ error: "displayName 必填（name 缺省时据此生成内部 id）" });
				body.name = agentIdFromDisplayName(displayName);
				generateUniqueName = true;
			} else if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(body.name.trim())) {
				// 显式 id 必须是文件名/工具名安全字符（生成路径已保证）。
				return reply.code(400).send({ error: "name（内部 id）只能包含字母、数字、连字符或下划线，且以字母或数字开头" });
			}
			const agent = await teams.upsertAgent(body as unknown as AgentConfig, { createOnly: true, generateUniqueName });
			return mutationReply(agent);
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	/**
	 * 复制 Worker 配置并创建独立、默认停用的新身份。凭证、env、头像、
	 * Session/Window 关系不复制；Capability binding id 由存储层重新生成。
	 */
	app.post<{ Params: { name: string } }>("/api/agents/:name/duplicate", async (req, reply) => {
		try {
			return mutationReply(await teams.duplicateAgent(req.params.name));
		} catch (err) {
			return notFoundOr400(reply, err);
		}
	});

	app.put<{ Params: { name: string }; Body: Partial<Record<string, unknown>> }>(
		"/api/agents/:name",
		async (req, reply) => {
			try {
				// pinned manager 的可编辑项走专用通道（§10.5）。
				if (req.params.name === MANAGER_AGENT_NAME) {
					const agent = await teams.updateManager({
						...(typeof req.body?.description === "string" ? { description: req.body.description } : {}),
						...(typeof req.body?.displayName === "string" || req.body?.displayName === null
							? { displayName: req.body.displayName }
							: {}),
						...(req.body?.responsibility === null || (req.body?.responsibility && typeof req.body.responsibility === "object")
							? { responsibility: req.body.responsibility as AgentConfig["responsibility"] | null }
							: {}),
						...(req.body?.manager && typeof req.body.manager === "object"
							? { manager: req.body.manager as Record<string, unknown> }
							: {}),
						...(req.body?.piResources === null || (req.body?.piResources && typeof req.body.piResources === "object")
							? { piResources: req.body.piResources as AgentConfig["piResources"] | null }
							: {}),
					});
					return mutationReply(agent);
				}
				const existing = await teams.getAgent(req.params.name);
				if (!existing) return reply.code(404).send({ error: "agent not found" });
				const connectorIssue = connectorBindingIssue(req.body?.connector);
				if (connectorIssue) return reply.code(400).send({ error: connectorIssue });
				const agent = await teams.upsertAgent({
					...(req.body as unknown as AgentConfig),
					name: req.params.name,
				});
				return mutationReply(agent);
			} catch (err) {
				return notFoundOr400(reply, err);
			}
		},
	);

	/** pinned manager 可编辑配置（§10.5）：描述 + manager settings 合并更新。 */
	app.patch<{ Params: { name: string }; Body: { description?: string; displayName?: string | null; manager?: Record<string, unknown>; responsibility?: AgentConfig["responsibility"] | null; piResources?: AgentConfig["piResources"] | null } }>(
		"/api/agents/:name/manager",
		async (req, reply) => {
			if (req.params.name !== MANAGER_AGENT_NAME) {
				return reply.code(400).send({ error: "只有 pinned manager 支持该配置区" });
			}
			try {
				const agent = await teams.updateManager({
					...(req.body?.description !== undefined ? { description: req.body.description } : {}),
					...(req.body?.displayName !== undefined ? { displayName: req.body.displayName } : {}),
					...(req.body?.responsibility !== undefined ? { responsibility: req.body.responsibility } : {}),
					...(req.body?.manager !== undefined ? { manager: req.body.manager } : {}),
					...(req.body?.piResources !== undefined ? { piResources: req.body.piResources } : {}),
				});
				return mutationReply(agent);
			} catch (err) {
				return notFoundOr400(reply, err);
			}
		},
	);

	app.get<{ Params: { name: string }; Querystring: { workspaceId?: string } }>(
		"/api/agents/:name/pi-resources/preview",
		async (req, reply) => {
			const agent = await teams.getAgent(req.params.name);
			if (!agent) return reply.code(404).send({ error: "agent not found" });
			if (!agent.pinned && agent.connector?.connectorId !== "pi") {
				return reply.code(400).send({ error: "只有 pi Agent 支持资源预览" });
			}
			try {
				const workspaceId = req.query.workspaceId?.trim() || undefined;
				const context = await teams.contextForWorkspace(workspaceId);
				// 信任门（§7.2/§6.3）：无 workspaceId = 全关且 workspace:null；
				// pending/denied 的 workspace 来源不进预览候选集。
				const workspaceAccess = await teams.workspaces.resourceAccessFor(workspaceId);
				return {
					preview: await previewPiResources({
						cwd: context.cwdSnapshot,
						agentDir: getAgentDir(),
						resources: agent.piResources,
						workspaceAccess,
						workspace:
							context.workspaceId && context.trust
								? { id: context.workspaceId, trust: context.trust }
								: null,
					}),
				};
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	);

	app.put<{ Params: { name: string }; Body: { piResources?: AgentConfig["piResources"] | null } }>(
		"/api/agents/:name/pi-resources",
		async (req, reply) => {
			const agent = await teams.getAgent(req.params.name);
			if (!agent) return reply.code(404).send({ error: "agent not found" });
			if (!agent.pinned && agent.connector?.connectorId !== "pi") {
				return reply.code(400).send({ error: "只有 pi Agent 支持资源配置" });
			}
			try {
				if (agent.pinned) {
					return mutationReply(await teams.updateManager({ piResources: req.body?.piResources ?? null }));
				}
				const updated = await teams.upsertAgent({
					...agent,
					piResources: req.body?.piResources ?? undefined,
				});
				return mutationReply(updated);
			} catch (err) {
				return notFoundOr400(reply, err);
			}
		},
	);

	/**
	 * 统一配置接口（独立配置页，§10.5）：manager 与 pi worker 同构的合并更新。
	 * pinned manager 走 updateManager（description/responsibility/manager/
	 * piResources）；worker 走 upsertAgent，connector 字段只允许 pi 绑定的
	 * config 更新，非 pinned 条目传 manager 字段一律 400。
	 */
	app.put<{
		Params: { name: string };
		Body: {
			description?: string;
			displayName?: string | null;
			responsibility?: AgentConfig["responsibility"] | null;
			manager?: Record<string, unknown>;
			connector?: { config?: Record<string, unknown> } | null;
			piResources?: AgentConfig["piResources"] | null;
			codeSearch?: AgentConfig["codeSearch"];
		};
	}>("/api/agents/:name/config", async (req, reply) => {
		const agent = await teams.getAgent(req.params.name);
		if (!agent) return reply.code(404).send({ error: "agent not found" });
		const body = req.body ?? {};
		if (agent.pinned) {
			if (body.connector !== undefined) {
				return reply.code(400).send({ error: "pinned manager 不绑定 Connector" });
			}
			try {
				const updated = await teams.updateManager({
					...(body.description !== undefined ? { description: body.description } : {}),
					...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
					...(body.responsibility !== undefined ? { responsibility: body.responsibility } : {}),
					...(body.manager !== undefined ? { manager: body.manager } : {}),
					...(body.piResources !== undefined ? { piResources: body.piResources } : {}),
				});
				return mutationReply(updated);
			} catch (err) {
				return notFoundOr400(reply, err);
			}
		}
		if (body.manager !== undefined) {
			return reply.code(400).send({ error: "manager 配置区仅适用于 pinned manager" });
		}
		if (body.codeSearch !== undefined && agent.connector?.connectorId !== "pi") {
			return reply.code(400).send({ error: "codeSearch 仅适用于 pi Worker" });
		}
		if (body.description !== undefined && typeof body.description !== "string") {
			return reply.code(400).send({ error: "description 必须是字符串" });
		}
		if (body.displayName !== undefined && body.displayName !== null && typeof body.displayName !== "string") {
			return reply.code(400).send({ error: "displayName 必须是字符串" });
		}
		if (body.connector !== undefined && agent.connector?.connectorId !== "pi") {
			return reply.code(400).send({ error: "connector 配置区仅适用于 pi Connector 绑定的 Agent" });
		}
		const connectorConfig = body.connector?.config;
		if (connectorConfig !== undefined && (typeof connectorConfig !== "object" || connectorConfig === null || Array.isArray(connectorConfig))) {
			return reply.code(400).send({ error: "connector.config 必须是对象" });
		}
		try {
			const next: AgentConfig = { ...agent };
			if (body.codeSearch !== undefined) next.codeSearch = body.codeSearch;
			if (body.description !== undefined) next.description = body.description;
			if (body.displayName !== undefined) {
				// null/空串 = 清除显示名（展示回退内部 id）；归一化在 upsertAgent。
				next.displayName = body.displayName ?? "";
			}
			if (body.responsibility !== undefined) {
				if (body.responsibility === null) delete next.responsibility;
				else next.responsibility = body.responsibility;
			}
			if (body.piResources !== undefined) {
				if (body.piResources === null) delete next.piResources;
				else next.piResources = body.piResources;
			}
			if (body.connector !== undefined && agent.connector) {
				next.connector = { ...agent.connector, ...(connectorConfig !== undefined ? { config: connectorConfig } : {}) };
			}
			return mutationReply(await teams.upsertAgent(next));
		} catch (err) {
			return notFoundOr400(reply, err);
		}
	});

	app.delete<{ Params: { name: string } }>("/api/agents/:name", async (req, reply) => {
		const existing = await teams.getAgent(req.params.name);
		if (!existing) return reply.code(404).send({ error: "agent not found" });
		// pinned 双层拒绝（§10.5）：路由先挡，store 再兜底。
		if (existing.pinned) return reply.code(400).send({ error: `agent「${existing.name}」是 pinned 内置 Agent，不可删除` });
		const removed = await teams.removeAgent(req.params.name);
		if (!removed) return reply.code(404).send({ error: "agent not found" });
		// 连带清除该 worker 的加密密钥。
		await credentials?.removeAgentSecrets(req.params.name);
		return reply.code(204).send();
	});

	/**
	 * 启用/禁用（§9.3.6）：禁用时若该 Agent 有 active/waiting Run，必须显式
	 * 传 resolve——"keep" 保留 Run 但拒绝新委托，"cancel" 走 Runtime 取消；
	 * 否则 409 + 受影响 Run 清单，绝不静默杀死。
	 */
	app.put<{ Params: { name: string }; Body: { enabled?: boolean; resolve?: string } }>(
		"/api/agents/:name/enabled",
		async (req, reply) => {
			const agent = await teams.getAgent(req.params.name);
			if (!agent) return reply.code(404).send({ error: "agent not found" });
			const enabled = req.body?.enabled;
			if (typeof enabled !== "boolean") return reply.code(400).send({ error: "body must be { enabled: boolean }" });
			if (agent.pinned && !enabled) {
				return reply.code(400).send({ error: `agent「${agent.name}」是 pinned 内置 Agent，不可禁用` });
			}
			if (enabled) {
				return mutationReply(await teams.setEnabled(agent.name, true));
			}
			const resolve = req.body?.resolve;
			const active = runtime
				? (await runtime.listDelegations()).filter(
						(d) => d.agentId === agent.name && (d.executionState === "running" || d.executionState === "waiting_input" || d.executionState === "cancel_requested" || d.executionState === "reconciling"),
					)
				: [];
			if (active.length > 0 && resolve !== "keep" && resolve !== "cancel") {
				return reply.code(409).send({
					error: `agent「${agent.name}」有 ${active.length} 个进行中/等待审批的 Run；显式传 resolve: "keep" | "cancel"`,
					runs: active.map((d) => ({
						delegationId: d.id,
					executionState: d.executionState,
						windowId: d.windowId,
						managerSessionId: d.managerSessionId,
					})),
				});
			}
			if (resolve === "cancel" && runtime) {
				for (const d of active) {
					await runtime.cancel(d.id, { cwd: teams.defaultContextCwd(), env: {} }).catch(() => undefined);
				}
			}
			// "keep"：保留 Run，新委托由 Invoker 门控拒绝（§9.3.6）。
			return mutationReply(await teams.setEnabled(agent.name, false));
		},
	);

	// ---- Connector 绑定（§10.1 基础接入） ----

	app.get<{ Params: { name: string } }>("/api/agents/:name/connector", async (req, reply) => {
		const agent = await teams.getAgent(req.params.name);
		if (!agent) return reply.code(404).send({ error: "agent not found" });
		const binding = agent.connector ?? null;
		const contribution =
			binding && extensions ? (extensions.manifestOf(binding.extensionId) ?? null) : null;
		return { connector: binding, extension: contribution, securityWarnings: connectorSecurityWarnings(agent) };
	});

	/** Connector-owned dynamic config choices (for example Codex model/list). */
	app.get<{ Params: { name: string; field: string } }>(
		"/api/agents/:name/connector/config-options/:field",
		async (req, reply) => {
			try {
				const agent = await teams.getAgent(req.params.name);
				if (!agent) return reply.code(404).send({ error: "agent not found" });
				if (!agent.connector || !invoker) return reply.code(400).send({ error: "agent has no Connector" });
				if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(req.params.field)) {
					return reply.code(400).send({ error: "invalid config field" });
				}
				const driver = await invoker.driverFor(agent.name);
				if (!driver) return reply.code(404).send({ error: "Connector driver unavailable" });
				if (!driver.listConfigOptions) return { options: [] };
				const secrets = credentials ? await credentials.getSecrets(agent.name) : {};
				return {
					options: await driver.listConfigOptions(req.params.field, {
						cwd: teams.defaultContextCwd(),
						env: { ...process.env, ...(agent.env ?? {}), ...secrets },
					}),
				};
			} catch (err) {
				return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	);

	app.put<{
		Params: { name: string };
		Body: {
			extensionId?: string;
			connectorId?: string;
			transport?: string;
			config?: Record<string, unknown>;
			secrets?: Record<string, string>;
			versionPin?: string;
		};
	}>("/api/agents/:name/connector", async (req, reply) => {
		const agent = await teams.getAgent(req.params.name);
		if (!agent) return reply.code(404).send({ error: "agent not found" });
		if (agent.pinned) return reply.code(400).send({ error: "pinned manager 不绑定 Connector" });
		const { extensionId, connectorId, transport, config } = req.body ?? {};
		if (!extensionId?.trim() || !connectorId?.trim() || !transport?.trim()) {
			return reply.code(400).send({ error: "body must be { extensionId, connectorId, transport, config?, secrets? }" });
		}
		if (config !== undefined && (typeof config !== "object" || config === null || Array.isArray(config))) {
			return reply.code(400).send({ error: "connector.config 必须是对象" });
		}
		// 校验安装包存在且 contribution 匹配（§9.3：先安装再绑定）。
		const manifest = extensions?.manifestOf(extensionId);
		if (extensions && (!manifest || manifest.kind !== "connector" || manifest.connector.id !== connectorId)) {
			return reply.code(400).send({ error: `extension「${extensionId}」未安装或不包含 connector「${connectorId}」` });
		}
		if (manifest?.kind === "connector" && !(manifest.connector.supportedTransports as string[]).includes(transport)) {
			return reply.code(400).send({ error: `connector「${connectorId}」不支持 transport「${transport}」` });
		}
		try {
			const allowedSecretKeys = new Set(manifest?.kind === "connector" ? (manifest.connector.secretSchema ?? []).map((item) => item.key) : []);
			const secretRefs = await applySecrets(agent.name, req.body?.secrets, agent.connector?.secretRefs, allowedSecretKeys);
			const updated = await teams.setConnectorBinding(agent.name, {
				extensionId: extensionId.trim(),
				connectorId: connectorId.trim(),
				transport: transport as AgentConnectorBinding["transport"],
				config: config ?? {},
				...(secretRefs ? { secretRefs } : {}),
				...(typeof req.body?.versionPin === "string" ? { versionPin: req.body.versionPin } : {}),
			});
			return mutationReply(updated);
		} catch (err) {
			return notFoundOr400(reply, err);
		}
	});

	// ---- Capability Extension 绑定（§10.1 Extensions 页签） ----

	app.get<{ Params: { name: string } }>("/api/agents/:name/extensions", async (req, reply) => {
		const agent = await teams.getAgent(req.params.name);
		if (!agent) return reply.code(404).send({ error: "agent not found" });
		return { bindings: agent.capabilityExtensions ?? [], revision: agent.extensionRevision ?? 0 };
	});

	app.post<{
		Params: { name: string };
		Body: {
			extensionId?: string;
			capabilityId?: string;
			enabled?: boolean;
			config?: Record<string, unknown>;
			activation?: string;
			versionPin?: string;
			secrets?: Record<string, string>;
		};
	}>("/api/agents/:name/extensions", async (req, reply) => {
		const agent = await teams.getAgent(req.params.name);
		if (!agent) return reply.code(404).send({ error: "agent not found" });
		const { extensionId, capabilityId, enabled, config, activation, versionPin } = req.body ?? {};
		if (!extensionId?.trim() || !capabilityId?.trim()) {
			return reply.code(400).send({ error: "body must be { extensionId, capabilityId, enabled?, config? }" });
		}
		if (activation !== undefined && activation !== "always" && activation !== "searchable") {
			return reply.code(400).send({ error: 'activation 必须是 "always" | "searchable"' });
		}
		const manifest = extensions?.manifestOf(extensionId);
		if (extensions && (!manifest || manifest.kind !== "capability" || manifest.capability.id !== capabilityId)) {
			return reply.code(400).send({ error: `extension「${extensionId}」未安装或不包含 capability「${capabilityId}」` });
		}
		if (manifest?.kind === "capability" && manifest.capability.compatibleConnectors?.length) {
			const targetConnectorId = agent.pinned ? PI_CONNECTOR_ID : agent.connector?.connectorId;
			if (!targetConnectorId || !manifest.capability.compatibleConnectors.includes(targetConnectorId)) {
				return reply.code(400).send({
					error: `capability「${capabilityId}」不兼容当前 Agent 的 Connector「${targetConnectorId ?? "未绑定"}」`,
				});
			}
		}
		try {
			const allowedSecretKeys = new Set(manifest?.kind === "capability" ? (manifest.capability.secretSchema ?? []).map((item) => item.key) : []);
			const secretRefs = await applySecrets(agent.name, req.body?.secrets, undefined, allowedSecretKeys);
			const updated = await teams.addCapabilityBinding(agent.name, {
				extensionId: extensionId.trim(),
				capabilityId: capabilityId.trim(),
				enabled: enabled ?? true,
				config: config ?? {},
				...(secretRefs ? { secretRefs } : {}),
				...(activation ? { activation } : {}),
				...(typeof versionPin === "string" ? { versionPin } : {}),
			});
			return mutationReply(updated);
		} catch (err) {
			return notFoundOr400(reply, err);
		}
	});

	app.patch<{
		Params: { name: string; bindingId: string };
		Body: {
			enabled?: boolean;
			config?: Record<string, unknown>;
			activation?: string;
			versionPin?: string;
			secrets?: Record<string, string>;
		};
	}>("/api/agents/:name/extensions/:bindingId", async (req, reply) => {
		const agent = await teams.getAgent(req.params.name);
		if (!agent) return reply.code(404).send({ error: "agent not found" });
		const binding = (agent.capabilityExtensions ?? []).find((b) => b.id === req.params.bindingId);
		if (!binding) return reply.code(404).send({ error: `binding not found: ${req.params.bindingId}` });
		const { enabled, config, activation, versionPin } = req.body ?? {};
		if (activation !== undefined && activation !== "always" && activation !== "searchable") {
			return reply.code(400).send({ error: 'activation 必须是 "always" | "searchable"' });
		}
		const manifest = extensions?.manifestOf(binding.extensionId);
		try {
			const allowedSecretKeys = new Set(manifest?.kind === "capability" ? (manifest.capability.secretSchema ?? []).map((item) => item.key) : []);
			const secretRefs = await applySecrets(agent.name, req.body?.secrets, binding.secretRefs, allowedSecretKeys);
			const patch: Partial<Omit<AgentCapabilityBinding, "id" | "extensionId" | "capabilityId">> = {
				...(enabled !== undefined ? { enabled } : {}),
				...(config !== undefined ? { config } : {}),
				...(activation !== undefined ? { activation } : {}),
				...(versionPin !== undefined ? { versionPin } : {}),
				...(secretRefs !== undefined ? { secretRefs } : {}),
			};
			return mutationReply(await teams.patchCapabilityBinding(agent.name, binding.id, patch));
		} catch (err) {
			return notFoundOr400(reply, err);
		}
	});

	app.delete<{ Params: { name: string; bindingId: string } }>(
		"/api/agents/:name/extensions/:bindingId",
		async (req, reply) => {
			try {
				return mutationReply(await teams.removeCapabilityBinding(req.params.name, req.params.bindingId));
			} catch (err) {
				return notFoundOr400(reply, err);
			}
		},
	);

	/** Capability 绑定探测：安装/加载/启用状态与将注册的工具清单。 */
	app.post<{ Params: { name: string; bindingId: string } }>(
		"/api/agents/:name/extensions/:bindingId/probe",
		async (req, reply) => {
			const agent = await teams.getAgent(req.params.name);
			if (!agent) return reply.code(404).send({ error: "agent not found" });
			const binding = (agent.capabilityExtensions ?? []).find((b) => b.id === req.params.bindingId);
			if (!binding) return reply.code(404).send({ error: `binding not found: ${req.params.bindingId}` });
			const entry = extensions?.get(binding.extensionId);
			const issues: Array<{ code: string; message: string; fixAction?: string }> = [];
			if (!entry) issues.push({ code: "not_installed", message: `extension「${binding.extensionId}」未安装` });
			else if (!entry.loaded) issues.push({ code: "load_failed", message: entry.loadError ?? "模块加载失败" });
			if (!binding.enabled) issues.push({ code: "disabled", message: "该绑定已禁用" });
			const tools =
				entry?.manifest.kind === "capability"
					? entry.manifest.capability.tools.map((t) =>
							agent.pinned ? `manager__${entry.manifest.id}__${t.name}` : `agent_${agent.name}__${entry.manifest.id}__${t.name}`,
						)
					: [];
			const module = extensions?.capabilityModuleOf(binding.extensionId);
			let runtimeProbe:
				| {
						authenticated?: boolean | "unknown";
						details?: Record<string, unknown>;
						issues?: Array<{ code: string; message: string; fixAction?: string }>;
					}
				| undefined;
			if (module?.runtime?.probe && capabilityStateRoot) {
				try {
					runtimeProbe = await module.runtime.probe({
						agent: {
							id: agent.name,
							name: agent.name,
							description: agent.description,
							capabilities: agent.capabilities ?? [],
							pinned: agent.pinned === true,
							...(agent.connector?.connectorId ? { connectorId: agent.connector.connectorId } : {}),
						},
						binding,
						config: binding.config ?? {},
						cwd: process.cwd(),
						env: { ...process.env, ...(agent.env ?? {}) },
						stateDir: capabilityBindingStateDir(
							capabilityStateRoot,
							binding.extensionId,
							agent.name,
							binding.id,
						),
						sharedStateDir: path.join(capabilityStateRoot, binding.extensionId, "shared"),
					});
					for (const issue of runtimeProbe.issues ?? []) issues.push(issue);
				} catch (err) {
					issues.push({
						code: "runtime_probe_failed",
						message: err instanceof Error ? err.message : String(err),
					});
				}
			}
			return {
				probe: {
					extensionInstalled: Boolean(entry),
					extensionVersion: entry?.version,
					loaded: entry?.loaded ?? false,
					enabled: binding.enabled,
					activation: binding.activation ?? null,
					tools,
					issues,
					...(runtimeProbe?.authenticated !== undefined ? { authenticated: runtimeProbe.authenticated } : {}),
					...(runtimeProbe?.details ? { details: runtimeProbe.details } : {}),
				},
			};
		},
	);

	/**
	 * Agent 健康探测：Connector 接入的 Agent 走 Driver.probe（§9.4，返回
	 * 结构化 ProbeResult）；legacy command invoke 走注册表探测。
	 */
	app.post<{ Params: { name: string } }>("/api/agents/:name/probe", async (req, reply) => {
		try {
			const agent = await teams.getAgent(req.params.name);
			if (!agent) return reply.code(404).send({ error: "agent not found" });
			if (agent.pinned || agent.invoke?.type === "pi") {
				return reply.code(400).send({ error: "pinned manager 无 Connector probe" });
			}
			if (agent.connector && invoker) {
				const driver = await invoker.driverFor(agent.name);
				const manifest = extensions?.manifestOf(agent.connector.extensionId);
				if (!driver) {
					// connector_missing：不静默回退（§9.3.8）。
					return {
						probe: {
							extensionInstalled: Boolean(manifest),
							extensionVersion: manifest?.version,
							detected: false,
							configured: false,
							authenticated: "unknown",
							enabled: agent.enabled !== false,
							compatibility: "unknown",
							issues: [{ code: "connector_missing", message: `Connector「${agent.connector.connectorId}」不可用（未安装或加载失败）` }],
						},
					};
				}
				const secrets = credentials ? await credentials.getSecrets(agent.name) : {};
				const probe = await driver.probe({
					cwd: teams.defaultContextCwd(),
					env: { ...process.env, ...(agent.env ?? {}), ...secrets },
				});
				probe.enabled = agent.enabled !== false;
				if (manifest) {
					probe.extensionInstalled = true;
					probe.extensionVersion = manifest.version;
				}
				for (const message of connectorSecurityWarnings(agent)) {
					probe.issues.push({ code: "permission_risk", message, fixAction: "在 Connector 配置中选择更严格的权限模式" });
				}
				return { probe };
			}
			return { probe: await teams.probeAgent(req.params.name) };
		} catch (err) {
			return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	// ---- secrets（加密存储于 ~/.puddingteams，派活时注入 worker env）----

	app.get<{ Params: { name: string } }>("/api/agents/:name/secrets", async (req, reply) => {
		if (!credentials) return reply.code(501).send({ error: "secrets store not configured" });
		if (!(await teams.getAgent(req.params.name))) return reply.code(404).send({ error: "agent not found" });
		return { configured: await credentials.listConfigured(req.params.name) };
	});

	app.put<{ Params: { name: string }; Body: { secrets?: Record<string, string> } }>(
		"/api/agents/:name/secrets",
		async (req, reply) => {
			if (!credentials) return reply.code(501).send({ error: "secrets store not configured" });
			if (!(await teams.getAgent(req.params.name))) return reply.code(404).send({ error: "agent not found" });
			const secrets = req.body?.secrets;
			if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
				return reply.code(400).send({ error: "body must be { secrets: { KEY: value } }" });
			}
			for (const [k, v] of Object.entries(secrets)) {
				if (typeof v !== "string") return reply.code(400).send({ error: `secret "${k}" must be a string` });
				if (!SECRET_KEY.test(k)) {
					return reply.code(400).send({ error: `secret key "${k}" must be UPPER_SNAKE (env var name)` });
				}
			}
			const configured = await credentials.setSecrets(req.params.name, secrets);
			await teams.bumpAgentRevision(req.params.name);
			await sessions?.syncAgentConfigChange();
			return { configured };
		},
	);

	app.delete<{ Params: { name: string; key: string } }>(
		"/api/agents/:name/secrets/:key",
		async (req, reply) => {
			if (!credentials) return reply.code(501).send({ error: "secrets store not configured" });
			if (!(await teams.getAgent(req.params.name))) return reply.code(404).send({ error: "agent not found" });
			await credentials.removeSecret(req.params.name, req.params.key);
			await teams.bumpAgentRevision(req.params.name);
			await sessions?.syncAgentConfigChange();
			return reply.code(204).send();
		},
	);

	// ---- avatars (§11): files under <assets>/avatars/, field on agents.json ----

	// base64 of a 2MB image is ~2.7MB; Fastify's default 1MB body limit would
	// reject legitimate uploads, so this route opts into a larger cap.
	app.post<{ Params: { name: string }; Body: { data?: string; mediaType?: string } }>(
		"/api/agents/:name/avatar",
		{ bodyLimit: 4 * 1024 * 1024 },
		async (req, reply) => {
			const data = req.body?.data;
			if (typeof data !== "string" || data.length === 0) {
				return reply.code(400).send({ error: "body must be { data: base64 }" });
			}
			// Cheap pre-decode bound so a huge base64 string is rejected early.
			if (data.length > Math.ceil(AVATAR_MAX_BYTES / 3) * 4 + 8) {
				return reply.code(413).send({ error: `avatar exceeds ${AVATAR_MAX_BYTES / 1024 / 1024}MB limit` });
			}
			try {
				const agent = await teams.saveAvatar(req.params.name, Buffer.from(data, "base64"));
				return { agent };
			} catch (err) {
				return notFoundOr400(reply, err);
			}
		},
	);

	app.delete<{ Params: { name: string } }>("/api/agents/:name/avatar", async (req, reply) => {
		try {
			await teams.removeAvatar(req.params.name);
			return reply.code(204).send();
		} catch (err) {
			return notFoundOr400(reply, err);
		}
	});

	app.get<{ Params: { name: string } }>("/api/agents/:name/avatar", async (req, reply) => {
		const avatar = await teams.readAvatar(req.params.name);
		// 未上传头像时回退到 connector manifest 声明的包内默认头像（§11）。
		if (!avatar) {
			if (extensions) {
				const agent = (await teams.listAgents()).find((a) => a.name === req.params.name);
				const connectorId = agent ? avatarConnectorId(agent) : undefined;
				const fallback = connectorId ? await extensions.readConnectorAvatar(connectorId) : null;
				if (fallback) {
					return reply
						.header("content-type", fallback.mime)
						.header("cache-control", "public, max-age=3600")
						.send(fallback.buf);
				}
			}
			return reply.code(404).send({ error: "no avatar" });
		}
		// Frontend busts the cache with ?v=<n> on upload/delete, so a long
		// max-age is safe.
		return reply
			.header("content-type", avatar.mime)
			.header("cache-control", "public, max-age=3600")
			.send(avatar.buf);
	});
}
