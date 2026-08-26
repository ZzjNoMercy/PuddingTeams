import type { FastifyInstance } from "fastify";
import type { ExtensionRegistry } from "../agent-runtime/extension-registry.js";
import type { AgentRuntime } from "../agent-runtime/runtime.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type { TeamsStore } from "../store/teams.js";
import type { ExtensionConnectionStatus, ExtensionKind } from "../agent-runtime/extensions.js";
import type { ProductSettingsStore } from "../store/product-settings.js";

export interface ExtensionRouteDeps {
	registry: ExtensionRegistry;
	teams: TeamsStore;
	/** 卸载保护需要查询 active/waiting Run（§9.3.8）。 */
	runtime?: AgentRuntime;
	/** 更新/卸载后标记活跃会话空闲重建。 */
	sessions?: PiSessionStore;
	settings: ProductSettingsStore;
}

/**
 * Extension 目录与安装 API（§10.1）。Connector 与 Capability 是两种独立包，
 * catalog 必须带 kind 过滤，前端不得把两类混在同一选择器。
 */
export function registerExtensionsRoutes(app: FastifyInstance, deps: ExtensionRouteDeps): void {
	const { registry, teams } = deps;
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

	app.get("/api/extensions/developer-mode", async () => deps.settings.get());

	app.put<{ Body: { enabled?: boolean } }>("/api/extensions/developer-mode", async (req, reply) => {
		if (typeof req.body?.enabled !== "boolean") return reply.code(400).send({ error: "enabled must be boolean" });
		return serializeDeveloperMode(async () => {
			const settings = await deps.settings.setDeveloperMode(req.body.enabled!);
			await registry.setDeveloperMode(settings.developerMode);
			await invalidateBoundAgents(new Set(registry.list().filter((item) => item.origin === "local-link").map((item) => item.manifest.id)));
			deps.sessions?.markAllDirty();
			return settings;
		});
	});

	app.get<{ Querystring: { kind?: string } }>("/api/extensions/catalog", async (req, reply) => {
		const kind = req.query.kind;
		if (kind !== undefined && kind !== "connector" && kind !== "capability") {
			return reply.code(400).send({ error: 'kind 必须是 "connector" | "capability"' });
		}
		return { extensions: registry.list(kind as ExtensionKind | undefined) };
	});

	/** 扩展贡献的外部系统连接状态。单个插件探测失败不能拖垮整页。 */
	app.get("/api/extensions/connections", async () => {
		const connections: Array<ExtensionConnectionStatus & { extensionId: string; extensionName: string }> = [];
		for (const entry of registry.list("capability")) {
			if (!entry.loaded) continue;
			const module = registry.capabilityModuleOf(entry.manifest.id);
			if (!module?.listConnections) continue;
			try {
				for (const connection of await module.listConnections({ cwd: process.cwd(), env: process.env })) {
					connections.push({
						...connection,
						id: `${entry.manifest.id}:${connection.id}`,
						extensionId: entry.manifest.id,
						extensionName: entry.manifest.displayName,
					});
				}
			} catch {
				connections.push({
					id: `${entry.manifest.id}:probe-error`,
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
		return serializeDeveloperMode(async () => {
			try {
				const opts = typeof req.body?.versionPin === "string" ? { versionPin: req.body.versionPin } : {};
				const entry =
					mode === "copy" ? await registry.installUserPackage(dir.trim(), opts) : await registry.install(dir.trim(), opts);
				return { extension: entry };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				const conflict = msg.includes("已安装") || msg.includes("互不覆盖") || msg.includes("builtin");
				return reply.code(conflict ? 409 : 400).send({ error: msg });
			}
		});
	});

	app.post<{ Params: { extensionId: string }; Body: { path?: string; versionPin?: string } }>(
		"/api/extensions/:extensionId/update",
		async (req, reply) => {
			return serializeDeveloperMode(async () => {
				const current = registry.get(req.params.extensionId);
				if (!current) return reply.code(404).send({ error: `extension not installed: ${req.params.extensionId}` });
				if (current.origin === "builtin" || current.origin === "bundled") {
					return reply.code(400).send({ error: `平台预置 extension「${req.params.extensionId}」不能从外部路径更新` });
				}
				try {
					const entry = await registry.update(req.params.extensionId, {
						...(typeof req.body?.path === "string" ? { path: req.body.path } : {}),
						...(typeof req.body?.versionPin === "string" ? { versionPin: req.body.versionPin } : {}),
					});
					await invalidateBoundAgents(new Set([req.params.extensionId]));
					deps.sessions?.markAllDirty();
					return { extension: entry };
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					const code = msg.includes("not installed") ? 404 : msg.includes("固定版本") ? 409 : 400;
					return reply.code(code).send({ error: msg });
				}
			});
		},
	);

	app.delete<{ Params: { extensionId: string } }>("/api/extensions/:extensionId", async (req, reply) => {
		return serializeDeveloperMode(async () => {
			const id = req.params.extensionId;
			const entry = registry.get(id);
			if (!entry) return reply.code(404).send({ error: `extension not installed: ${id}` });
			if (entry.origin === "builtin" || entry.origin === "bundled") {
				return reply.code(400).send({ error: `平台预置 extension「${id}」不可卸载` });
			}

			// 卸载保护（§9.3.8）：有启用 Agent 绑定该 Extension，或这些 Agent 还有
			// active/waiting Run 时返回 409，不静默回退。
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
								(d.status === "running" || d.status === "waiting_input") &&
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
						status: d.status,
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
	});
}
