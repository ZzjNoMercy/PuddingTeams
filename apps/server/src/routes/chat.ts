import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { serializePiEvent } from "../pi-bridge/bridge.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import type { TeamsStore } from "../store/teams.js";
import { directTaskId, directWorkerFor, dispatchDirectMessage } from "../agent-runtime/direct-dispatch.js";
import type { AgentInvoker } from "../agent-runtime/invoker.js";
import { config } from "../config.js";
import type { WorkStateStore } from "../store/work-state.js";
import { identifyUploads, type UploadInput, type UploadStore } from "../store/uploads.js";
import { getAgentDir, type PromptOptions } from "@earendil-works/pi-coding-agent";
import { previewPiResources } from "../pi-bridge/pi-resources.js";
import { ProviderRecoveryRequiredError, type ProviderDeletionCoordinator } from "../pi-bridge/provider-deletion.js";
import { CustomProviderDurabilityError } from "../pi-bridge/custom-providers.js";
import { MessageSubmissionConflictError, MessageSubmissionOperations, MessageSubmissionUnconfirmedError } from "../store/message-submission-operations.js";
import type { ChatKnowledgeIntake, ChatSourceRefs } from "../knowledge/chat-intake.js";
import { localViewerIdentity } from "./identity.js";

/**
 * Version of the bundled pi SDK, surfaced via /api/health for the About
 * dialog. The package's exports map hides ./package.json and defines only an
 * `import` condition, so resolve via import.meta and read the manifest next
 * to the entry point.
 */
function readPiVersion(): string | undefined {
	try {
		const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		let dir = path.dirname(entry);
		for (let i = 0; i < 5; i++) {
			try {
				const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf-8")) as {
					name?: string;
					version?: string;
				};
				if (pkg.name === "@earendil-works/pi-coding-agent") return pkg.version;
			} catch {
				// keep walking up
			}
			dir = path.dirname(dir);
		}
	} catch {
		// unresolvable — omit the field
	}
	return undefined;
}

const piVersion = readPiVersion();

interface WsHandlerParams {
	Params: { id: string };
	Querystring: Record<string, never>;
	Body: unknown;
}

/**
 * Fan-out registry: all sockets currently subscribed to a session.
 * Errors raised by background prompt() runs are forwarded here so the
 * browser sees them even when the HTTP POST already returned.
 */
const socketsBySession = new Map<string, Set<WebSocket>>();
const wireMessageIds = new WeakMap<object, string>();

function withWireMessageId<T extends object>(message: T): T & { puddingMessageId: string } {
	let id = wireMessageIds.get(message);
	if (!id) { id = randomUUID(); wireMessageIds.set(message, id); }
	return { ...message, puddingMessageId: id };
}

function serializeChatEvent(event: Parameters<typeof serializePiEvent>[0]): string | null {
	try {
		if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
			return serializePiEvent({ ...event, message: withWireMessageId(event.message) });
		}
		return serializePiEvent(event);
	} catch {
		return null;
	}
}

/** In-process marker: only the rooms route may assign a reclaimable first-work upload batch. */
export const internalFirstWorkFreezeToken = randomUUID();

export interface LocalPathReference { token: string; absolutePath: string }

export function localPathReferences(content: string): LocalPathReference[] {
	const found: LocalPathReference[] = [];
	const add = (token: string, value: string): void => {
		const absolutePath = value.trim();
		if (path.isAbsolute(absolutePath) && !found.some((item) => item.token === token)) found.push({ token, absolutePath });
	};
	for (const match of content.matchAll(/`(\/[^`\n]+)`/g)) add(match[1]!, match[1]!);
	for (const match of content.matchAll(/file:\/\/[^\s`<>]+/g)) {
		try { add(match[0], fileURLToPath(match[0])); } catch { /* malformed URI remains ordinary text */ }
	}
	for (const match of content.matchAll(/(?:^|\s)(\/[^\s`"'<>]+)/g)) {
		const token = match[1]!.replace(/[),.;:!?]+$/, "");
		add(token, token);
	}
	return found;
}

export function isWithin(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

class MessagePreflightRejectionError extends Error {
	constructor(message: string) { super(message); this.name = "MessagePreflightRejectionError"; }
}

function userText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content.filter((part): part is { type: string; text: string } =>
		Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string"))
		.map((part) => part.text).join("\n").trim();
}

function directAdmissionCardsPersisted(sessionFile: string, operationId: string, taskId: string, windowId: string, worker: string): boolean {
	try {
		const entries = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
			type?: string; customType?: string; display?: boolean; details?: Record<string, unknown>;
		});
		const user = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "pudding:user_message" &&
			entry.display === true && entry.details?.operationId === operationId && entry.details.windowId === windowId);
		const assignment = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "pudding:task_assign" &&
			entry.display === true && entry.details?.operationId === operationId && entry.details.taskId === taskId &&
			entry.details.windowId === windowId && entry.details.worker === worker && entry.details.from === "direct" &&
			entry.details.status === "running" && !entry.details.delegationId);
		return user.length === 1 && assignment.length === 1;
	} catch { return false; }
}

function piAdmissionPersisted(sessionFile: string, operationId: string, requestHash: string, contextHash: string): boolean {
	try {
		const entries = readFileSync(sessionFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
			id?: string; type?: string; customType?: string; display?: boolean; details?: Record<string, unknown>; message?: { role?: string };
		});
		const markers = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "pudding:message_admission" &&
			entry.details?.operationId === operationId);
		if (markers.length !== 1) return false;
		if (markers[0]!.display !== false) return false;
		const facts = markers[0]!.details!;
		if (facts.requestHash !== requestHash || facts.contextHash !== contextHash || typeof facts.userEntryId !== "string") return false;
		return entries.filter((entry) => entry.type === "message" && entry.id === facts.userEntryId && entry.message?.role === "user").length === 1;
	} catch { return false; }
}

function messageEntryPersisted(sessionFile: string | undefined, entryId: string, role: "user" | "assistant"): boolean {
	if (!sessionFile) return false;
	try {
		return readFileSync(sessionFile, "utf8").split("\n").some((line) => {
			if (!line.includes(entryId)) return false;
			try {
				const entry = JSON.parse(line) as { id?: string; type?: string; message?: { role?: string } };
				return entry.id === entryId && entry.type === "message" && entry.message?.role === role;
			} catch { return false; }
		});
	} catch { return false; }
}

function forwardError(sessionId: string, message: string): void {
	const sockets = socketsBySession.get(sessionId);
	if (!sockets) return;
	const payload = JSON.stringify({ type: "error", message });
	for (const socket of sockets) {
		if (socket.readyState === socket.OPEN) socket.send(payload);
	}
}

export async function registerChatRoutes(
	app: FastifyInstance,
	store: PiSessionStore,
	teams?: TeamsStore,
	workStates?: WorkStateStore,
	uploads?: UploadStore,
	invoker?: AgentInvoker,
	health?: { dataHomeId?: string; runId?: string },
	providerDeletion?: ProviderDeletionCoordinator,
	messageOperations?: MessageSubmissionOperations,
	knowledgeIntakes?: ChatKnowledgeIntake,
): Promise<void> {
	const requireActiveSessionContext = async (sessionId: string) => {
		if (!teams) return undefined;
		const context = await teams.contextForSession(sessionId);
		if (context && !context.active) throw new Error("该会话所属项目未激活，请先切换回对应项目");
		return context;
	};
	const withActiveSessionLifecycle = <T>(sessionId: string, action: () => Promise<T>): Promise<T> =>
		invoker
			? invoker.withActiveSessionLifecycle(sessionId, action)
			: requireActiveSessionContext(sessionId).then(action);
	const inactiveContextError = (err: unknown): boolean =>
		err instanceof Error && err.message.includes("所属项目未激活");
	const recoverAcceptedDirectOperation = async (
		sessionId: string, operationKey: string,
		context: NonNullable<Awaited<ReturnType<TeamsStore["contextForSession"]>>>,
	): Promise<boolean> => {
		if (!teams || !invoker) return false;
		const target = await directWorkerFor(teams, sessionId);
		if (!target || target.window.id !== context.window.id) return false;
		const taskId = directTaskId(operationKey);
		const matching = (await invoker.delegationsForManagerSession(sessionId)).filter((item) => item.operationId === operationKey);
		if (matching.length !== 1) return false;
		const delegation = matching[0]!;
		if (delegation.managerToolCallId !== taskId || delegation.windowId !== context.window.id ||
			delegation.workspaceId !== context.workspaceId || delegation.cwdSnapshot !== context.cwdSnapshot ||
			delegation.agentId !== target.workerName || delegation.purpose !== "execution") return false;
		const session = await store.open(sessionId);
		return Boolean(session.sessionFile && directAdmissionCardsPersisted(session.sessionFile, operationKey, taskId, context.window.id, target.workerName));
	};
	const recoverAcceptedPiOperation = async (sessionId: string, operationKey: string, requestHash: string, contextHash: string): Promise<boolean> => {
		const session = await store.open(sessionId);
		return Boolean(session.sessionFile && piAdmissionPersisted(session.sessionFile, operationKey, requestHash, contextHash));
	};

	app.get("/api/health", async () => ({
		ok: true,
		service: "puddingteams-server",
		piVersion,
		...(health?.dataHomeId ? { dataHomeId: health.dataHomeId } : {}),
		...(health?.runId ? { runId: health.runId } : {}),
	}));

	app.get("/api/models", async () => ({ models: await store.listModels() }));

	app.get("/api/providers", async () => ({ providers: await store.listProviders() }));

	app.get<{ Params: { id: string } }>("/api/sessions/:id/commands", async (req, reply) => {
		try {
			return await withActiveSessionLifecycle(req.params.id, async () => {
				const direct = teams ? await directWorkerFor(teams, req.params.id) : undefined;
				if (direct && teams) {
					const agent = await teams.getAgent(direct.workerName);
					if (!agent || agent.connector?.connectorId !== "pi") return { commands: [] };
					const preview = await previewPiResources({
						cwd: direct.window.cwdSnapshot,
						agentDir: getAgentDir(),
						resources: agent.piResources,
						workspaceAccess: await teams.workspaces.resourceAccessFor(direct.window.workspaceId),
					});
					return {
						commands: preview.skills
							.filter((skill) => skill.enabled)
							.map((skill) => ({ name: `skill:${skill.name}`, description: skill.description, source: "skill" as const }))
							.sort((a, b) => a.name.localeCompare(b.name)),
					};
				}
				return { commands: await store.listSkillCommands(req.params.id) };
			});
		} catch (err) {
			if (inactiveContextError(err)) return reply.code(409).send({ error: "session_context_inactive" });
			if (err instanceof Error && err.message.startsWith("Session not found")) {
				return reply.code(404).send({ error: "session not found" });
			}
			throw err;
		}
	});

	app.get<{ Params: { id: string } }>("/api/providers/:id/models", async (req, reply) => {
		if (!(await store.hasProvider(req.params.id))) {
			return reply.code(404).send({ error: "provider not found" });
		}
		return { models: await store.listProviderModels(req.params.id) };
	});

	app.post<{ Params: { id: string }; Body: { apiKey?: string } }>(
		"/api/providers/:id/key",
		async (req, reply) => {
			const apiKey = req.body?.apiKey?.trim();
			if (!apiKey) {
				return reply.code(400).send({ error: "apiKey is required" });
			}
			try {
				const mutate = async () => await store.hasProvider(req.params.id) ? store.setProviderKey(req.params.id, apiKey) : null;
				const result = providerDeletion ? await providerDeletion.withMutation(mutate) : await mutate();
				if (!result) return reply.code(404).send({ error: "provider not found" });
				const { availableCount } = result;
				return { ok: true, availableCount };
			} catch (err) {
					return reply.code(err instanceof ProviderRecoveryRequiredError || err instanceof CustomProviderDurabilityError ? 503 : inactiveContextError(err) ? 409 : 400).send({
						error: inactiveContextError(err) ? "session_context_inactive" : err instanceof Error ? err.message : String(err),
						...(err instanceof ProviderRecoveryRequiredError ? { code: "provider_recovery_required" } : {}),
						...(err instanceof CustomProviderDurabilityError ? { code: "provider_write_uncertain" } : {}),
					});
			}
		},
	);

	app.delete<{ Params: { id: string } }>("/api/providers/:id/key", async (req, reply) => {
		try {
			const mutate = async () => {
				if (!(await store.hasProvider(req.params.id))) return false;
				await store.removeProviderKey(req.params.id);
				return true;
			};
			const found = providerDeletion ? await providerDeletion.withMutation(mutate) : await mutate();
			return found ? reply.code(204).send() : reply.code(404).send({ error: "provider not found" });
		} catch (err) {
			if (err instanceof ProviderRecoveryRequiredError) return reply.code(503).send({ error: err.message, code: "provider_recovery_required" });
			if (err instanceof CustomProviderDurabilityError) return reply.code(503).send({ error: err.message, code: "provider_write_uncertain" });
			throw err;
		}
	});

	app.get("/api/sessions", async () => ({ sessions: await store.list() }));

	app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
		try {
			let existed = false;
			const preflight = async () => {
				const context = await requireActiveSessionContext(req.params.id);
				const owner = context?.window;
				if (owner?.sessions.length === 1) throw new Error("窗口至少要保留一个会话");
			};
			const remove = async () => {
				// A fresh window session may only exist as a config (pi writes the
				// session file lazily) — clean the window store regardless, and only
				// 404 when nothing existed at all.
				const inWindow = teams ? await teams.windowForSession(req.params.id) : undefined;
				const removed = await store.remove(req.params.id);
				await teams?.removeSessionFromWindows(req.params.id);
				await workStates?.removeSession(req.params.id);
				existed = removed || Boolean(inWindow);
			};
			if (invoker) await invoker.closeManagerSession(req.params.id, preflight, remove);
			else {
				await preflight();
				await remove();
			}
			if (!existed) return reply.code(404).send({ error: "session not found" });
			return reply.code(204).send();
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	const workerModelContext = async (id: string) => {
		const target = teams && await directWorkerFor(teams, id);
		if (!target || !teams || !invoker) throw new Error("仅 Worker 单聊支持会话模型设置");
		const agent = await invoker.requireAgent(target.workerName);
		const capabilities = await invoker.capabilitiesFor(agent.name);
		return { agent, support: capabilities?.runtimeModel };
	};
	app.get<{ Params: { id: string } }>("/api/sessions/:id/worker-runtime-model", async (req, reply) => {
		try {
			return await withActiveSessionLifecycle(req.params.id, async () => {
				const { agent, support } = await workerModelContext(req.params.id);
				const config = agent.connector?.config ?? {};
				return { supported: Boolean(support), modelCatalog: agent.connector?.connectorId === "pi" ? "pi" : "driver", effortLevels: support?.effortLevels ?? [], settings: await store.workerRuntimeModel(req.params.id), defaults: {
					model: typeof config.model === "string" ? config.model : undefined,
					effort: typeof config.effort === "string" ? config.effort : typeof config.thinkingLevel === "string" ? config.thinkingLevel : undefined,
				} };
			});
		} catch (err) { return reply.code(inactiveContextError(err) ? 409 : 400).send({ error: err instanceof Error ? err.message : String(err) }); }
	});
	app.put<{ Params: { id: string }; Body: { model?: string | null; effort?: string | null } }>("/api/sessions/:id/worker-runtime-model", async (req, reply) => {
		try {
			return await withActiveSessionLifecycle(req.params.id, async () => {
				const { agent, support } = await workerModelContext(req.params.id);
				if (!support) throw new Error("当前 Connector 不支持实时切换模型和 effort");
				const body = req.body;
				if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).some((key) => key !== "model" && key !== "effort")) throw new Error("无效的会话模型设置");
				const settings = await store.workerRuntimeModel(req.params.id);
				for (const key of ["model", "effort"] as const) {
					if (body[key] === undefined) continue;
					if (body[key] === null) { delete settings[key]; continue; }
					if (typeof body[key] !== "string" || !body[key]!.trim() || body[key]!.length > 256) throw new Error(`${key} 必须是非空字符串或 null`);
					settings[key] = body[key]!.trim();
				}
				if (settings.effort && !support.effortLevels.includes(settings.effort)) throw new Error("当前 Connector 不支持该 effort 档位");
				if (agent.connector?.connectorId === "pi") {
					const modelRef = settings.model ?? agent.connector.config?.model;
					const model = (await store.listModels()).find((item) => item.id === modelRef);
					if (settings.model && !model) throw new Error("模型目录中不存在该模型");
					if (model && settings.effort && !model.thinkingLevels.includes(settings.effort)) throw new Error("当前模型不支持该 effort 档位");
				}
				await store.setWorkerRuntimeModel(req.params.id, settings);
				return { settings };
			});
		} catch (err) { return reply.code(inactiveContextError(err) ? 409 : 400).send({ error: err instanceof Error ? err.message : String(err) }); }
	});
	app.get<{ Params: { id: string } }>("/api/sessions/:id/worker-runtime-model/options", async (req, reply) => {
		try {
			return await withActiveSessionLifecycle(req.params.id, async () => {
				const { agent, support } = await workerModelContext(req.params.id);
				if (!support) return { options: [] };
				if (agent.connector?.connectorId === "pi") return { options: (await store.listModels()).map((model) => ({ value: model.id, label: model.name, effortLevels: model.thinkingLevels })) };
				const context = await teams!.contextForSession(req.params.id);
				return { options: await invoker!.runtimeModelOptions(agent.name, context!.cwdSnapshot) };
			});
		} catch (err) { return reply.code(inactiveContextError(err) ? 409 : 502).send({ error: err instanceof Error ? err.message : String(err) }); }
	});

	app.post<{ Params: { id: string }; Body: { model?: string } }>(
		"/api/sessions/:id/model",
		async (req, reply) => {
			const model = req.body?.model?.trim();
			if (!model) {
				return reply.code(400).send({ error: "model is required" });
			}
			try {
				return await withActiveSessionLifecycle(req.params.id, async () => ({ model: await store.setModel(req.params.id, model) }));
			} catch (err) {
				return reply.code(inactiveContextError(err) ? 409 : 400).send({ error: inactiveContextError(err) ? "session_context_inactive" : err instanceof Error ? err.message : String(err) });
			}
		},
	);

	/** 会话级 thinking level（§10.6）：composer 对该 Session 的选择，优先级高于 manager 默认。 */
	app.post<{ Params: { id: string }; Body: { thinkingLevel?: string } }>(
		"/api/sessions/:id/thinking-level",
		async (req, reply) => {
			const thinkingLevel = req.body?.thinkingLevel?.trim();
			if (!thinkingLevel) {
				return reply.code(400).send({ error: "thinkingLevel is required" });
			}
			try {
				return await withActiveSessionLifecycle(req.params.id, async () => ({ thinkingLevel: await store.setThinkingLevel(req.params.id, thinkingLevel) }));
			} catch (err) {
				return reply.code(inactiveContextError(err) ? 409 : 400).send({ error: inactiveContextError(err) ? "session_context_inactive" : err instanceof Error ? err.message : String(err) });
			}
		},
	);

	app.post<{ Params: { id: string }; Body: { content?: string; attachments?: UploadInput[] } }>(
		"/api/sessions/:id/messages",
		{ bodyLimit: 28 * 1024 * 1024 },
		async (req, reply) => {
			const content = req.body?.content?.trim();
			const attachments = req.body?.attachments ?? [];
			if (!content && attachments.length === 0) {
				return reply.code(400).send({ error: "content or attachments is required" });
			}
			if (!Array.isArray(attachments)) return reply.code(400).send({ error: "attachments must be an array" });
			const freezeHeader = req.headers["x-puddingteams-first-work-freeze-id"];
			const internalFirstWork = typeof freezeHeader === "string" && req.headers["x-puddingteams-first-work-token"] === internalFirstWorkFreezeToken;
			const operationKey = req.headers["idempotency-key"];
			if (messageOperations && !internalFirstWork && typeof operationKey !== "string") {
				return reply.code(428).send({ error: "发送消息需要 Idempotency-Key", code: "message_operation_required" });
			}
			const operationHash = messageOperations && typeof operationKey === "string"
				? createHash("sha256").update(JSON.stringify({ content: content ?? "", attachments })).digest("hex")
				: undefined;
			let operationReserved = false;
			let operationContextHash: string | undefined;
			let stored = [] as Awaited<ReturnType<UploadStore["save"]>>;
			let promptContent = content ?? "";
			let sourceRefs: ChatSourceRefs | undefined;
			try {
				const context = await requireActiveSessionContext(req.params.id);
				if (teams && !context) throw new Error("会话已失去项目归属，请重新打开会话");
				if (messageOperations && typeof operationKey === "string" && operationHash) {
					const contextHash = createHash("sha256").update(JSON.stringify({
						windowId: context?.window.id ?? null,
						workspaceId: context?.workspaceId ?? null,
						cwdSnapshot: context?.cwdSnapshot ?? null,
					})).digest("hex");
					operationContextHash = contextHash;
					const reservation = await messageOperations.reserve(operationKey, req.params.id, operationHash, contextHash);
					if (reservation === "accepted") return { accepted: true, attachments: [] };
					if (typeof reservation === "object") return reply.code(400).send({ error: reservation.rejected, code: "message_operation_rejected" });
					if (reservation === "unconfirmed") {
						const recovered = await (async () => {
							const direct = teams && await directWorkerFor(teams, req.params.id);
							return direct && context
								? recoverAcceptedDirectOperation(req.params.id, operationKey, context)
								: recoverAcceptedPiOperation(req.params.id, operationKey, operationHash, contextHash);
						})().catch(() => false);
						if (recovered) {
							await messageOperations.markAccepted(operationKey, req.params.id, operationHash).catch(() => { throw new MessageSubmissionUnconfirmedError(); });
							return { accepted: true, attachments: [] };
						}
						return reply.code(409).send({ error: new MessageSubmissionUnconfirmedError().message, code: "message_delivery_unconfirmed" });
					}
					operationReserved = true;
				}
				const cwdSnapshot = context?.cwdSnapshot ?? process.cwd();
				const workspaceRoot = await realpath(cwdSnapshot).catch(() => path.resolve(cwdSnapshot));
				const external: Array<LocalPathReference & { canonicalPath: string; dev: number | bigint; ino: number | bigint }> = [];
				// SDK slash commands occupy the first token; their arguments still
				// undergo ordinary path preflight. Unknown absolute paths stay checked.
				const command = /^\/([A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?)(?=\s|$)/.exec(promptContent);
				let pathInput = promptContent;
				if (command && context?.window.type !== "direct" && (command[1]!.startsWith("skill:") ||
					(context && (await store.open(req.params.id)).promptTemplates?.some((template) => template.name === command[1])))) pathInput = promptContent.slice(command[0].length);
				for (const reference of localPathReferences(pathInput)) {
					const canonicalPath = await realpath(reference.absolutePath).catch(() => undefined);
					if (!canonicalPath) throw new MessagePreflightRejectionError(`绝对路径不存在或不可访问，未交给 Agent：${reference.absolutePath}`);
					const info = await stat(canonicalPath).catch(() => { throw new MessagePreflightRejectionError(`绝对路径不存在或不可访问，未交给 Agent：${reference.absolutePath}`); });
					if (isWithin(canonicalPath, workspaceRoot)) continue;
					if (info.isDirectory()) {
						throw new MessagePreflightRejectionError(`目录「${reference.absolutePath}」不属于当前 Workspace；请先登记为 Workspace 或配置明确的临时挂载范围`);
					}
					if (info.isFile()) external.push({ ...reference, canonicalPath, dev: info.dev, ino: info.ino });
				}
				if (external.length && !uploads) throw new MessagePreflightRejectionError("平台未启用会话附件冻结，不能读取 Workspace 外文件");
				if (freezeHeader !== undefined && req.headers["x-puddingteams-first-work-token"] !== internalFirstWorkFreezeToken) {
					throw new MessagePreflightRejectionError("首次工作附件冻结身份只能由内部请求指定");
				}
				try { identifyUploads(attachments); }
				catch (error) { throw new MessagePreflightRejectionError(error instanceof Error ? error.message : String(error)); }
				const freezeId = typeof freezeHeader === "string" ? freezeHeader : undefined;
				stored = await uploads?.saveWithLocalFiles(req.params.id, attachments, external.map((item) => ({ path: item.canonicalPath, dev: item.dev, ino: item.ino })), freezeId) ?? [];
				const frozen = stored.slice(attachments.length);
				for (let index = 0; index < external.length; index++) {
					promptContent = promptContent.split(external[index]!.token).join(frozen[index]!.path);
				}
				if (knowledgeIntakes && context) sourceRefs = await knowledgeIntakes.prepare({ ownerId: localViewerIdentity().user.id,
					sessionId: req.params.id, windowId: context.window.id, operationId: typeof operationKey === "string" ? operationKey : randomUUID(),
					text: req.body.content ?? "", uploads: stored });
			} catch (err) {
				if (err instanceof MessageSubmissionConflictError) return reply.code(409).send({ error: err.message, code: "message_operation_conflict" });
				if (err instanceof MessagePreflightRejectionError) {
					if (operationReserved && messageOperations && typeof operationKey === "string" && operationHash) {
						try { await messageOperations.markRejected(operationKey, req.params.id, operationHash, err.message); }
						catch { return reply.code(409).send({ error: new MessageSubmissionUnconfirmedError().message, code: "message_delivery_unconfirmed" }); }
					}
					return reply.code(400).send({ error: err.message, code: "message_operation_rejected" });
				}
				if (err instanceof MessageSubmissionUnconfirmedError || operationReserved) return reply.code(409).send({ error: new MessageSubmissionUnconfirmedError().message, code: "message_delivery_unconfirmed" });
				return reply.code(inactiveContextError(err) ? 409 : 400).send({
					error: inactiveContextError(err) ? "session_context_inactive" : err instanceof Error ? err.message : String(err),
				});
			}
			try {
				if (teams && invoker && await directWorkerFor(teams, req.params.id)) {
					const attachmentText = stored.length
						? `\n\n用户附件（平台冻结路径，可按需读取并在委托任务中原样传递）：\n${stored.map((item) => `- ${item.name} (${item.mediaType}, ${item.size} bytes): ${item.path}`).join("\n")}`
						: "";
					const promptText = `${promptContent || "请处理所附文件。"}${attachmentText}`;
					const attachLine = stored.length ? `附件：${stored.map((item) => item.name).join("、")}` : "";
					const displayText = [content, attachLine].filter(Boolean).join("\n\n");
					const handled = await dispatchDirectMessage(
						{ teams, sessions: store, invoker, workStates, runtimeModelFor: (id) => store.workerRuntimeModel(id), onError: forwardError, log: (message) => app.log.info(message),
							onUserMessageDurable: async (id, refs) => { await knowledgeIntakes?.admitDirect(await store.open(id), refs); } },
						req.params.id, promptText, displayText,
						typeof operationKey === "string" ? operationKey : sourceRefs?.operationId,
						sourceRefs,
					);
					if (!handled) throw new Error("direct 窗口在消息接收时已变化");
					if (messageOperations && typeof operationKey === "string" && operationHash) await messageOperations.markAccepted(operationKey, req.params.id, operationHash);
					return { accepted: true, attachments: stored.map(({ base64: _base64, ...item }) => item) };
				}
				return await withActiveSessionLifecycle(req.params.id, async () => {
					const session = await store.open(req.params.id);
					const priorUserCount = session.messages.filter((message) => message.role === "user").length;
					const attachmentText = stored.length
						? `\n\n用户附件（平台冻结路径，可按需读取并在委托任务中原样传递）：\n${stored.map((item) => `- ${item.name} (${item.mediaType}, ${item.size} bytes): ${item.path}`).join("\n")}`
						: "";
					const promptText = `${promptContent || "请处理所附文件。"}${attachmentText}`;
					const images = stored
						.filter((item) => item.mediaType.startsWith("image/"))
						.map((item) => ({ type: "image" as const, data: item.base64, mimeType: item.mediaType }));
					// 第一条消息到达时，异步调 LLM 生成会话标题（session_info），
					// 不阻塞消息发送本身。
					const isFirstMessage = session.messages.length === 0;
					const generateTitle = () => {
						void store.generateSessionTitle(req.params.id, content || stored.map((item) => item.name).join("、")).catch((err: unknown) => {
							app.log.warn({ err, sessionId: req.params.id }, "title generation failed");
						});
					};
					const awaitDurableUser = req.headers["x-puddingteams-await-preflight"] === "1" || operationReserved;
					const priorUserIds = new Set((awaitDurableUser ? session.sessionManager.getBranch() : [])
						.filter((entry) => entry.type === "message" && entry.message.role === "user")
						.map((entry) => entry.id));
					let disarmIntake: ReturnType<ChatKnowledgeIntake["armManager"]> | undefined;
					const newUserIsDurable = (): string | undefined => {
						const executedPrompt = (disarmIntake?.executionText() ?? promptText).trim();
						const entry = session.sessionManager.getBranch().find((item) =>
							item.type === "message" && item.message.role === "user" && !priorUserIds.has(item.id));
						if (entry?.type !== "message" || entry.message.role !== "user" || userText(entry.message.content) !== executedPrompt || !session.sessionFile) return undefined;
						try {
							return readFileSync(session.sessionFile, "utf8").split("\n").some((line) => {
								if (!line) return false;
								try {
									const persisted = JSON.parse(line) as { id?: string; type?: string; message?: { role?: string; content?: unknown } };
									return persisted.id === entry.id && persisted.type === "message" && persisted.message?.role === "user"
										&& userText(persisted.message.content) === executedPrompt;
								}
								catch { return false; }
							}) ? entry.id : undefined;
						} catch { return undefined; }
					};
					let resolveUserEntry: ((persisted: string | undefined) => void) | undefined;
					const userEntry = awaitDurableUser ? new Promise<string | undefined>((resolve) => { resolveUserEntry = resolve; }) : null;
					const unsubscribeUser = awaitDurableUser ? store.subscribe(req.params.id, (event) => {
						if (event.type === "message_end" && event.message.role === "user") {
							// pi broadcasts message_end before its synchronous JSONL append.
							queueMicrotask(() => { const persisted = newUserIsDurable(); if (persisted) resolveUserEntry?.(persisted); });
						}
					}) : undefined;
					let resolvePreflight: ((accepted: boolean) => void) | undefined;
					const preflight = new Promise<boolean>((resolve) => { resolvePreflight = resolve; });
					const promptOptions = {
						...(images.length ? { images } : {}),
						preflightResult: (accepted: boolean) => resolvePreflight?.(accepted),
					} as PromptOptions;
					disarmIntake = sourceRefs ? knowledgeIntakes?.armManager(session, sourceRefs, promptText, stored) : undefined;
					const completion = session.prompt(promptText, promptOptions);
					void completion.finally(() => disarmIntake?.()).catch(() => {});
					void completion.catch((err: unknown) => {
						app.log.error({ err, sessionId: req.params.id }, "prompt failed");
						forwardError(req.params.id, err instanceof Error ? err.message : String(err));
					});
					let timeout: ReturnType<typeof setTimeout> | undefined;
					try {
						if (!(await preflight)) {
							try { await completion; }
							finally {
								if (stored.length && session.messages.filter((message) => message.role === "user").length === priorUserCount) {
									await uploads?.discard(req.params.id, stored).catch((error: unknown) => app.log.warn({ error, sessionId: req.params.id }, "failed to discard rejected message attachments"));
								}
							}
							throw new Error("消息未通过模型准入");
						}
						if (awaitDurableUser) {
							const deadline = new Promise<undefined>((resolve) => { timeout = setTimeout(() => resolve(undefined), 5000); });
							const persisted = await Promise.race([userEntry!, completion.then(newUserIsDurable), deadline]);
							if (!persisted) throw new Error("首次发送尚未写入会话记录，请保留原操作键重试");
							if (operationReserved && typeof operationKey === "string" && operationHash && operationContextHash) {
								await store.appendMessageAdmission(req.params.id, { operationId: operationKey, requestHash: operationHash, contextHash: operationContextHash, userEntryId: persisted });
							}
						}
					} finally {
						if (timeout) clearTimeout(timeout);
						unsubscribeUser?.();
					}
					if (messageOperations && typeof operationKey === "string" && operationHash) await messageOperations.markAccepted(operationKey, req.params.id, operationHash);
					if (isFirstMessage) generateTitle();
					return { accepted: true, attachments: stored.map(({ base64: _base64, ...item }) => item) };
				});
			} catch (err) {
				if (operationReserved) return reply.code(409).send({ error: new MessageSubmissionUnconfirmedError().message, code: "message_delivery_unconfirmed" });
				return reply.code(inactiveContextError(err) ? 409 : 400).send({
					error: inactiveContextError(err) ? "session_context_inactive" : err instanceof Error ? err.message : String(err),
				});
			}
		},
	);

	app.post<{ Params: { id: string } }>("/api/sessions/:id/abort", async (req, reply) => {
		try {
			await requireActiveSessionContext(req.params.id);
			// Stop is a durable execution boundary, not only an SDK cancellation.
			// Fence every already-issued manager/worker callback by advancing the
			// Goal epoch before aborting external execution.
			const activeDelegations = invoker
				? (await invoker.delegationsForManagerSession(req.params.id)).filter((item) =>
					["waiting_admission", "running", "waiting_input", "cancel_requested", "reconciling"].includes(item.executionState),
				)
				: [];
			const shouldFenceGoal = store.isRunning(req.params.id) || activeDelegations.length > 0;
			if (shouldFenceGoal && workStates) {
				const goal = await workStates.getActive(req.params.id);
				if (goal && goal.execution.status !== "interrupted") {
					await workStates.interruptGoal(
						req.params.id,
						goal.revision,
						{
							kind: "manager_interrupted",
							fingerprint: `manager_abort:${goal.goalId}:${goal.execution.epoch}`,
							delegationIds: activeDelegations.filter((item) => item.goalId === goal.goalId).map((item) => item.id).sort(),
						},
						`manager-abort:${goal.goalId}:${goal.execution.epoch}`,
						goal.goalId,
					);
				}
			}
			const result = await store.abort(req.params.id);
			if (!result.aborted) {
				return reply.code(409).send({ ...result, error: "当前会话没有正在运行的任务" });
			}
			return result;
		} catch (err) {
			if (inactiveContextError(err)) return reply.code(409).send({ aborted: false, reconciledToolResults: 0, error: "session_context_inactive" });
			app.log.error({ err, sessionId: req.params.id }, "abort failed");
			return reply.code(500).send({ aborted: false, reconciledToolResults: 0, error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.get<{ Params: { id: string } }>("/api/sessions/:id/messages", async (req, reply) => {
		try {
			return await withActiveSessionLifecycle(req.params.id, async () => {
				const toolCallState = await store.recoverToolCallState(req.params.id);
				const session = await store.open(req.params.id);
				const running = store.isRunning?.(req.params.id) ?? false;
				const branch = session.sessionManager.getBranch();
				const lastConversationEntry = [...branch].reverse().find((entry) =>
					entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"));
				const unansweredUserMessage = !running && lastConversationEntry?.type === "message" && lastConversationEntry.message.role === "user"
					&& messageEntryPersisted(session.sessionFile, lastConversationEntry.id, "user");
				const unfinishedAssistantTurn = !running && lastConversationEntry?.type === "message" && lastConversationEntry.message.role === "assistant"
					&& lastConversationEntry.message.stopReason === "toolUse"
					&& branch.some((entry) => entry.type === "message" && entry.message.role === "user")
					&& messageEntryPersisted(session.sessionFile, lastConversationEntry.id, "assistant");
				return { messages: session.messages.map(withWireMessageId), running, unansweredUserMessage, unfinishedAssistantTurn, ...toolCallState };
			});
		} catch (err) {
			if (inactiveContextError(err)) return reply.code(409).send({ error: "session_context_inactive" });
			if (err instanceof Error && err.message.startsWith("Session not found")) {
				return reply.code(404).send({ error: "session not found" });
			}
			throw err;
		}
	});

	app.get<WsHandlerParams>(
		"/api/sessions/:id/ws",
		{ websocket: true },
		async (socket, req) => {
			const sessionId = req.params.id;
			// Browsers always send Origin on cross-origin upgrades; native
			// clients (curl/node) may omit it — allow those, block foreign pages.
			// 发行态同源托管：server 可能绑 0.0.0.0 从局域网 IP/主机名访问，
			// Origin 与请求 Host 一致即同源，无需进白名单。
			const origin = req.headers.origin;
			let sameOrigin = false;
			if (origin) {
				try {
					sameOrigin = new URL(origin).host === req.headers.host;
				} catch {
					sameOrigin = false;
				}
			}
			if (origin && !sameOrigin && !config.allowedOrigins.includes(origin)) {
				socket.close(1008, "origin not allowed");
				return;
			}
			let sockets = socketsBySession.get(sessionId);
			if (!sockets) {
				sockets = new Set();
				socketsBySession.set(sessionId, sockets);
			}
			sockets.add(socket);

			try {
				await withActiveSessionLifecycle(sessionId, async () => {
					// open 只为校验存在性并确保实例已物化；订阅走 store 级通道，
					// runtimeDirty 空闲重建换掉 AgentSession 实例后推送不断流。
					await store.open(sessionId);
					socket.send(JSON.stringify({ type: "session_ready", sessionId }));
					const unsubscribe = store.subscribe(sessionId, (event) => {
						const payload = serializeChatEvent(event);
						if (payload && socket.readyState === socket.OPEN) socket.send(payload);
					});
					const unsubscribeContext = teams?.onChange(() => {
						void requireActiveSessionContext(sessionId).catch(() => {
							if (socket.readyState === socket.OPEN) socket.close(1008, "session workspace is not active");
						});
					});
					const cleanup = () => {
						unsubscribe();
						unsubscribeContext?.();
						sockets?.delete(socket);
					};
					socket.on("close", () => {
						cleanup();
					});
					socket.on("error", () => {
						cleanup();
					});
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				sockets.delete(socket);
				if (inactiveContextError(err)) {
					socket.close(1008, "session workspace is not active");
					return;
				}
				if (message.startsWith("Session not found")) {
					// 4404 lets the client tell "session is gone" (deleted or not
					// migrated) apart from a transient drop, so it stops
					// reconnecting instead of looping the same failure forever.
					socket.close(4404, "session not found");
					return;
				}
				socket.send(JSON.stringify({ type: "error", message }));
				socket.close();
			}
		},
	);
}
