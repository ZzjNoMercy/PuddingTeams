import type { FastifyInstance } from "fastify";
import path from "node:path";
import type { ExtensionRegistry } from "../agent-runtime/extension-registry.js";
import type { AgentRuntime } from "../agent-runtime/runtime.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type { TeamsStore } from "../store/teams.js";
import type { ExtensionConnectionStatus, ExtensionKind } from "../agent-runtime/extensions.js";
import type { ProductSettingsStore } from "../store/product-settings.js";
import type { McpServerInput, McpServerStore } from "../store/mcp-servers.js";
import type { ExtensionMutationJournal } from "../store/extension-mutation-journal.js";
import { MANAGED_MCP_ADAPTER_VERSION } from "../pi-bridge/mcp-runtime.js";

export interface ExtensionRouteDeps {
	registry: ExtensionRegistry;
	teams: TeamsStore;
	/** 卸载保护需要查询 active/waiting Run（§9.3.8）。 */
	runtime?: AgentRuntime;
	/** 更新/卸载后标记活跃会话空闲重建。 */
	sessions?: PiSessionStore;
	settings: ProductSettingsStore;
	/** Capability 的共享运行依赖根目录。 */
	capabilityStateRoot: string;
	/** 平台 MCP Server Catalog；协议执行由默认启用的 pi-mcp-adapter 提供。 */
	mcpServers: McpServerStore;
	mutationJournal: ExtensionMutationJournal;
	mcpMutationJournal: ExtensionMutationJournal;
}

/**
 * Extension 目录与安装 API（§10.1）。Connector 与 Capability 是两种独立包，
 * catalog 必须带 kind 过滤，前端不得把两类混在同一选择器。
 */
export function registerExtensionsRoutes(app: FastifyInstance, deps: ExtensionRouteDeps): void {
	const { registry, teams } = deps;
	const connectionContext = (extensionId: string) => ({
		connection: registry.connectionServiceOf(extensionId),
		cwd: process.cwd(),
		env: process.env,
		stateDir: path.join(deps.capabilityStateRoot, extensionId, "shared"),
	});
	let developerModeQueue: Promise<unknown> = Promise.resolve();
	function serializeDeveloperMode<T>(fn: () => Promise<T>): Promise<T> {
		const run = developerModeQueue.then(fn, fn);
		developerModeQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
	async function invalidateBoundAgents(extensionIds: Set<string>): Promise<void> {
		for (const agent of await teams.listAgents()) {
			if (
				extensionIds.has(agent.connector?.extensionId ?? "") ||
				(agent.capabilityExtensions ?? []).some((binding) => extensionIds.has(binding.extensionId))
			) {
				await teams.bumpAgentRevision(agent.name);
			}
		}
		await deps.sessions?.syncAgentConfigChange();
	}
	async function invalidateMcpAgents(serverId: string): Promise<void> {
		for (const agent of await teams.listAgents()) {
			if ((agent.mcpServerIds ?? []).includes(serverId)) await teams.bumpAgentRevision(agent.name);
		}
		await deps.sessions?.syncAgentConfigChange();
	}
	async function withMcpAffectedAgents<T>(serverId: string, action: () => Promise<T>): Promise<T> {
		const names = (await teams.listAgents())
			.filter((agent) => (agent.mcpServerIds ?? []).includes(serverId))
			.map((agent) => agent.name);
		return teams.withAgentRunAdmissions(names, async () => {
			const before = await deps.mcpServers.mutationFingerprint();
			const ids = await deps.mcpMutationJournal.begin(names);
			teams.setAgentAdmissionsBlocked(ids, true);
			try {
				const result = await action();
				await deps.mcpMutationJournal.complete();
				teams.setAgentAdmissionsBlocked(ids, false);
				return result;
			} catch (error) {
				let changed = false;
				try {
					if (await deps.mcpServers.mutationFingerprint() === before) {
						await deps.mcpMutationJournal.complete();
					} else {
						changed = true;
						await deps.mcpMutationJournal.recover(async (name) => {
							if (await teams.getAgent(name)) await teams.bumpAgentRevision(name);
						}, async () => { await deps.sessions?.syncAgentConfigChange(); });
					}
					teams.setAgentAdmissionsBlocked(ids, false);
				} catch (recoveryError) {
					throw new AggregateError([error, recoveryError], "MCP 目录与 Agent 修订号对账失败，已阻断受影响 Agent 接单");
				}
				if (changed) throw Object.assign(new Error("MCP 目录已变更并完成修订对账，请回读后确认"), { statusCode: 503 });
				throw error;
			}
		});
	}
	async function withExtensionAffectedAgents<T>(extensionIds: Set<string>, action: () => Promise<T>): Promise<T> {
		const names = (await teams.listAgents())
			.filter((agent) => extensionIds.has(agent.connector?.extensionId ?? "") ||
				(agent.capabilityExtensions ?? []).some((binding) => extensionIds.has(binding.extensionId)))
			.map((agent) => agent.name);
		return teams.withAgentRunAdmissions(names, () => withDurableExtensionMutation(names, action));
	}
	async function withDurableExtensionMutation<T>(names: string[], action: () => Promise<T>): Promise<T> {
		const beforeRegistry = registry.mutationFingerprint();
		const beforeDeveloperMode = (await deps.settings.get()).developerMode;
		const ids = await deps.mutationJournal.begin(names);
		teams.setAgentAdmissionsBlocked(ids, true);
		try {
			const result = await action();
			await deps.mutationJournal.complete();
			teams.setAgentAdmissionsBlocked(ids, false);
			return result;
		} catch (error) {
			try {
				if (registry.mutationFingerprint() === beforeRegistry &&
					(await deps.settings.get()).developerMode === beforeDeveloperMode) {
					await deps.mutationJournal.complete();
				} else {
					await deps.mutationJournal.recover(async (name) => {
						if (await teams.getAgent(name)) await teams.bumpAgentRevision(name);
					}, async () => { await deps.sessions?.syncAgentConfigChange(); });
				}
				teams.setAgentAdmissionsBlocked(ids, false);
			} catch (recoveryError) {
				throw new AggregateError([error, recoveryError], "Extension 变更与 Agent 修订号对账失败，已阻断受影响 Agent 接单");
			}
			throw error;
		}
	}

	app.get("/api/extensions/developer-mode", async () => deps.settings.get());

	app.put<{ Body: { enabled?: boolean } }>("/api/extensions/developer-mode", async (req, reply) => {
		if (typeof req.body?.enabled !== "boolean") return reply.code(400).send({ error: "enabled must be boolean" });
		return serializeDeveloperMode(() => teams.withAgentCatalogMutation(async () => {
			const ids = new Set(registry.list().filter((item) => item.origin === "local-link").map((item) => item.manifest.id));
			return withExtensionAffectedAgents(ids, async () => {
				const settings = await deps.settings.setDeveloperMode(req.body.enabled!);
				await registry.setDeveloperMode(settings.developerMode);
				await invalidateBoundAgents(ids);
				deps.sessions?.markAllDirty();
				return settings;
			});
		}));
	});

	app.get<{ Querystring: { kind?: string } }>("/api/extensions/catalog", async (req, reply) => {
		const kind = req.query.kind;
		if (kind !== undefined && kind !== "connector" && kind !== "capability") {
			return reply.code(400).send({ error: 'kind 必须是 "connector" | "capability"' });
		}
		return { extensions: registry.list(kind as ExtensionKind | undefined) };
	});

	// ---- MCP Server Catalog（独立于 Connector/Capability 包） ----

	app.get("/api/extensions/mcp/servers", async () => {
		const agents = await teams.listAgents();
		return {
			adapter: { id: "pi-mcp-adapter", version: MANAGED_MCP_ADAPTER_VERSION, enabled: true },
			servers: (await deps.mcpServers.list()).map((server) => ({
				...server,
				usedBy: agents
					.filter((agent) => (agent.mcpServerIds ?? []).includes(server.id))
					.map((agent) => ({ id: agent.name, displayName: agent.displayName ?? agent.name })),
			})),
		};
	});

	app.post<{ Body: Partial<McpServerInput> }>("/api/extensions/mcp/servers", async (req, reply) => teams.withAgentCatalogMutation(async () => {
		try {
			const body = req.body ?? {};
			const server = await deps.mcpServers.create(body as McpServerInput);
			return reply.code(201).send({ server });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const status = (err as { statusCode?: number })?.statusCode;
			return reply.code(status === 503 ? 503 : message.includes("已存在") ? 409 : 400).send({ error: message });
		}
	}));

	app.put<{ Params: { serverId: string }; Body: Partial<Omit<McpServerInput, "id">> }>(
		"/api/extensions/mcp/servers/:serverId",
		async (req, reply) => teams.withAgentCatalogMutation(async () => {
			try {
				return await withMcpAffectedAgents(req.params.serverId, async () => {
					const server = await deps.mcpServers.update(req.params.serverId, req.body as Omit<McpServerInput, "id">);
					await invalidateMcpAgents(server.id);
					return { server };
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const status = (err as { statusCode?: number })?.statusCode;
				return reply.code(status === 503 || err instanceof AggregateError ? 503 : message.includes("不存在") ? 404 : 400).send({ error: message });
			}
		}),
	);

	app.delete<{ Params: { serverId: string } }>("/api/extensions/mcp/servers/:serverId", async (req, reply) => teams.withAgentCatalogMutation(async () => {
		const agents = (await teams.listAgents()).filter((agent) => (agent.mcpServerIds ?? []).includes(req.params.serverId));
		if (agents.length > 0) {
			return reply.code(409).send({
				error: `MCP Server「${req.params.serverId}」仍被 Agent 使用，请先取消勾选`,
				agents: agents.map((agent) => ({ id: agent.name, displayName: agent.displayName ?? agent.name })),
			});
		}
		if (!await deps.mcpServers.remove(req.params.serverId)) return reply.code(404).send({ error: "MCP Server 不存在" });
		return reply.code(204).send();
	}));

	/** 扩展贡献的外部系统连接状态。单个插件探测失败不能拖垮整页。 */
	app.get("/api/extensions/connections", async () => {
		const connections: Array<ExtensionConnectionStatus & { connectionId: string; extensionId: string; extensionName: string }> = [];
		for (const entry of registry.list("capability")) {
			if (!entry.loaded) continue;
			const module = registry.capabilityModuleOf(entry.manifest.id);
			if (!module?.listConnections) continue;
			try {
				for (const connection of await module.listConnections(connectionContext(entry.manifest.id))) {
					connections.push({
						...connection,
						id: `${entry.manifest.id}:${connection.id}`,
						connectionId: connection.id,
						extensionId: entry.manifest.id,
						extensionName: entry.manifest.displayName,
					});
				}
			} catch {
				connections.push({
					id: `${entry.manifest.id}:probe-error`,
					connectionId: "probe-error",
					extensionId: entry.manifest.id,
					extensionName: entry.manifest.displayName,
					name: entry.manifest.displayName,
					state: "error" as const,
					message: "连接状态检查失败",
					checkedAt: new Date().toISOString(),
				});
			}
		}
		return { connections };
	});

	/** 连接动作必须由插件显式声明并由用户主动触发，探测接口绝不调用。 */
	app.post<{ Params: { extensionId: string; connectionId: string; actionId: string } }>(
		"/api/extensions/:extensionId/connections/:connectionId/actions/:actionId",
		async (req, reply) => {
			const entry = registry.get(req.params.extensionId);
			if (!entry || entry.manifest.kind !== "capability" || !entry.loaded) {
				return reply.code(404).send({ error: "能力插件不存在或尚未加载" });
			}
			const module = registry.capabilityModuleOf(entry.manifest.id);
			if (!module?.listConnections || !module.runConnectionAction) {
				return reply.code(404).send({ error: "该插件未提供连接动作" });
			}
			const ctx = connectionContext(entry.manifest.id);
			const before = (await module.listConnections(ctx)).find((item) => item.id === req.params.connectionId);
			if (!before?.actions?.some((action) => action.id === req.params.actionId)) {
				return reply.code(409).send({ error: "该动作已不可用，请重新检查连接状态" });
			}
			try {
				await module.runConnectionAction(req.params.connectionId, req.params.actionId, ctx);
				const connection = (await module.listConnections(ctx)).find((item) => item.id === req.params.connectionId);
				if (!connection) return reply.code(404).send({ error: "连接不存在" });
				return {
					connection: {
						...connection,
						id: `${entry.manifest.id}:${connection.id}`,
						connectionId: connection.id,
						extensionId: entry.manifest.id,
						extensionName: entry.manifest.displayName,
					},
				};
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : "连接动作执行失败" });
			}
		},
	);

	/** 授权通过插件贡献完成；宿主不接触上游设备码或 token。 */
	app.post<{ Params: { extensionId: string; connectionId: string }; Body: { actionId?: string } }>(
		"/api/extensions/:extensionId/connections/:connectionId/authorizations", async (req, reply) => {
			reply.header("Cache-Control", "no-store");
			const entry = registry.get(req.params.extensionId);
			const module = entry?.loaded && entry.manifest.kind === "capability" ? registry.capabilityModuleOf(entry.manifest.id) : undefined;
			if (!module?.authorization || !module.listConnections) return reply.code(404).send({ error: "该插件未提供用户授权" });
			const ctx = connectionContext(req.params.extensionId);
			try {
				const connection = (await module.listConnections(ctx)).find(item => item.id === req.params.connectionId);
				const action = connection?.actions?.find(item => item.id === req.body?.actionId && item.kind === "authorization");
				if (!action) return reply.code(409).send({ error: "授权动作已不可用，请重新检查连接状态" });
				return { session: await module.authorization.begin(req.params.connectionId, action.id, ctx) };
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : "无法发起授权" });
			}
		},
	);
	for (const method of ["GET", "DELETE"] as const) {
		app.route<{ Params: { extensionId: string; connectionId: string; sessionId: string } }>({
			method, url: "/api/extensions/:extensionId/connections/:connectionId/authorizations/:sessionId",
			async handler(req, reply) {
				reply.header("Cache-Control", "no-store");
				const entry = registry.get(req.params.extensionId);
				const module = entry?.loaded && entry.manifest.kind === "capability" ? registry.capabilityModuleOf(entry.manifest.id) : undefined;
				if (!module?.authorization) return reply.code(404).send({ error: "该插件未提供用户授权" });
				const ctx = connectionContext(req.params.extensionId);
				try {
					if (method === "DELETE") {
						await module.authorization.cancel(req.params.connectionId, req.params.sessionId, ctx);
						return reply.code(204).send();
					}
					const session = await module.authorization.status(req.params.connectionId, req.params.sessionId, ctx);
					return session ? { session } : reply.code(404).send({ error: "授权会话不存在或已过期，请重新发起" });
				} catch { return reply.code(400).send({ error: "授权状态处理失败，请重试" }); }
			},
		});
	}

	app.post<{ Body: { path?: string; versionPin?: string; mode?: string } }>("/api/extensions/install", async (req, reply) => {
		const dir = req.body?.path;
		if (typeof dir !== "string" || !dir.trim()) {
			return reply.code(400).send({ error: "body must be { path: 本地扩展目录 }" });
		}
		// link（默认）= 开发者本地链接，受开发者模式闸门；copy = 用户安装，
		// 内容复制到 PUDDINGTEAMS_HOME/extensions/packages/<id>/<version>/。
		const mode = req.body?.mode ?? "link";
		if (mode !== "link" && mode !== "copy") {
			return reply.code(400).send({ error: 'mode 必须是 "link" | "copy"' });
		}
		return serializeDeveloperMode(() => teams.withAgentCatalogMutation(async () => {
			try {
				const opts = typeof req.body?.versionPin === "string" ? { versionPin: req.body.versionPin } : {};
				// 安装来源可在读取 manifest 后变化；先挡住所有当前 Agent 的接单，
				// 以 registry 实际激活的包 id 决定谁需要递增修订号。
				const agentNames = (await teams.listAgents()).map((agent) => agent.name);
				return await teams.withAgentRunAdmissions(agentNames, () => withDurableExtensionMutation(agentNames, async () => {
					const entry = mode === "copy" ? await registry.installUserPackage(dir.trim(), opts) : await registry.install(dir.trim(), opts);
					await invalidateBoundAgents(new Set([entry.manifest.id]));
					deps.sessions?.markAllDirty();
					return { extension: entry };
				}));
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const conflict = msg.includes("已安装") || msg.includes("互不覆盖") || msg.includes("builtin");
				return reply.code(conflict ? 409 : 400).send({ error: msg });
			}
		}));
	});

	app.post<{ Params: { extensionId: string }; Body: { path?: string; versionPin?: string } }>(
		"/api/extensions/:extensionId/update",
		async (req, reply) => {
			return serializeDeveloperMode(() => teams.withAgentCatalogMutation(async () => {
				const current = registry.get(req.params.extensionId);
				if (!current) return reply.code(404).send({ error: `extension not installed: ${req.params.extensionId}` });
				if (current.origin === "builtin" || current.origin === "bundled") {
					return reply.code(400).send({ error: `平台预置 extension「${req.params.extensionId}」不能从外部路径更新` });
			}
			try {
					return await withExtensionAffectedAgents(new Set([req.params.extensionId]), async () => {
						const entry = await registry.update(req.params.extensionId, {
							...(typeof req.body?.path === "string" ? { path: req.body.path } : {}),
							...(typeof req.body?.versionPin === "string" ? { versionPin: req.body.versionPin } : {}),
						});
						await invalidateBoundAgents(new Set([req.params.extensionId]));
						deps.sessions?.markAllDirty();
						return { extension: entry };
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					const code = msg.includes("not installed") ? 404 : msg.includes("固定版本") ? 409 : 400;
					return reply.code(code).send({ error: msg });
				}
			}));
		},
	);

	app.delete<{ Params: { extensionId: string } }>("/api/extensions/:extensionId", async (req, reply) => {
		return serializeDeveloperMode(() => teams.withAgentCatalogMutation(async () => {
			const id = req.params.extensionId;
			const entry = registry.get(id);
			if (!entry) return reply.code(404).send({ error: `extension not installed: ${id}` });
			if (entry.origin === "builtin" || entry.origin === "bundled") {
				return reply.code(400).send({ error: `平台预置 extension「${id}」不可卸载` });
			}

			// 卸载保护（§9.3.8）：有启用 Agent 绑定该 Extension，或这些 Agent 还有
			// active/waiting Run 时返回 409，不静默回退。
			return withExtensionAffectedAgents(new Set([id]), async () => {
				const agents = await teams.listAgents();
				const bound = agents.filter(
					(a) =>
						a.connector?.extensionId === id ||
						(a.capabilityExtensions ?? []).some((b) => b.extensionId === id),
				);
				const enabledBound = bound.filter((a) => a.enabled !== false);
				const runs =
					entry.manifest.kind === "connector" && deps.runtime
						? (await deps.runtime.listDelegations()).filter(
								(d) =>
										(d.executionState === "admitted" || d.executionState === "waiting_admission" || d.executionState === "running" || d.executionState === "waiting_input" || d.executionState === "cancel_requested" || d.executionState === "reconciling") &&
									bound.some((a) => a.name === d.agentId),
							)
						: [];
				if (enabledBound.length > 0 || runs.length > 0) {
					return reply.code(409).send({
						error: `extension「${id}」仍被使用：先禁用相关 Agent 并处理进行中的 Run`,
						agents: enabledBound.map((a) => a.name),
						runs: runs.map((d) => ({
							delegationId: d.id,
							agentId: d.agentId,
							executionState: d.executionState,
							windowId: d.windowId,
						})),
					});
				}
				try {
					await registry.uninstall(id);
				} catch (err) {
					return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
				}
				await invalidateBoundAgents(new Set([id]));
				// 历史绑定保留：对应 Agent 调用时进入 connector_missing，不静默回退。
				deps.sessions?.markAllDirty();
				return reply.code(204).send();
			});
		}));
	});
}
