import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { serializePiEvent } from "../pi-bridge/bridge.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import type { TeamsStore } from "../store/teams.js";
import { directWorkerFor, dispatchDirectMessage } from "../agent-runtime/direct-dispatch.js";
import type { AgentInvoker } from "../agent-runtime/invoker.js";
import { config } from "../config.js";
import type { WorkStateStore } from "../store/work-state.js";
import type { UploadInput, UploadStore } from "../store/uploads.js";
import { getAgentDir, type PromptOptions } from "@earendil-works/pi-coding-agent";
import { previewPiResources } from "../pi-bridge/pi-resources.js";

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

interface LocalPathReference { token: string; absolutePath: string }

function localPathReferences(content: string): LocalPathReference[] {
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

function isWithin(candidate: string, root: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
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
	health?: { dataHomeId?: string },
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

	app.get("/api/health", async () => ({
		ok: true,
		service: "puddingteams-server",
		piVersion,
		...(health?.dataHomeId ? { dataHomeId: health.dataHomeId } : {}),
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
			if (!(await store.hasProvider(req.params.id))) {
				return reply.code(404).send({ error: "provider not found" });
			}
			const apiKey = req.body?.apiKey?.trim();
			if (!apiKey) {
				return reply.code(400).send({ error: "apiKey is required" });
			}
			try {
				const { availableCount } = await store.setProviderKey(req.params.id, apiKey);
				return { ok: true, availableCount };
				} catch (err) {
					return reply.code(inactiveContextError(err) ? 409 : 400).send({
						error: inactiveContextError(err) ? "session_context_inactive" : err instanceof Error ? err.message : String(err),
					});
			}
		},
	);

	app.delete<{ Params: { id: string } }>("/api/providers/:id/key", async (req, reply) => {
		if (!(await store.hasProvider(req.params.id))) {
			return reply.code(404).send({ error: "provider not found" });
		}
		await store.removeProviderKey(req.params.id);
		return reply.code(204).send();
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
			let stored = [] as Awaited<ReturnType<UploadStore["save"]>>;
			let promptContent = content ?? "";
			try {
				const context = await requireActiveSessionContext(req.params.id);
				const cwdSnapshot = context?.cwdSnapshot ?? process.cwd();
				const workspaceRoot = await realpath(cwdSnapshot).catch(() => path.resolve(cwdSnapshot));
				const external: Array<LocalPathReference & { canonicalPath: string; dev: number | bigint; ino: number | bigint }> = [];
				for (const reference of localPathReferences(promptContent)) {
					const canonicalPath = await realpath(reference.absolutePath).catch(() => undefined);
					if (!canonicalPath) throw new Error(`绝对路径不存在或不可访问，未交给 Agent：${reference.absolutePath}`);
					const info = await stat(canonicalPath);
					if (isWithin(canonicalPath, workspaceRoot)) continue;
					if (info.isDirectory()) {
						throw new Error(`目录「${reference.absolutePath}」不属于当前 Workspace；请先登记为 Workspace 或配置明确的临时挂载范围`);
					}
					if (info.isFile()) external.push({ ...reference, canonicalPath, dev: info.dev, ino: info.ino });
				}
				if (external.length && !uploads) throw new Error("平台未启用会话附件冻结，不能读取 Workspace 外文件");
				stored = await uploads?.saveWithLocalFiles(req.params.id, attachments, external.map((item) => ({ path: item.canonicalPath, dev: item.dev, ino: item.ino }))) ?? [];
				const frozen = stored.slice(attachments.length);
				for (let index = 0; index < external.length; index++) {
					promptContent = promptContent.split(external[index]!.token).join(frozen[index]!.path);
				}
			} catch (err) {
				return reply.code(inactiveContextError(err) ? 409 : 400).send({
					error: inactiveContextError(err) ? "session_context_inactive" : err instanceof Error ? err.message : String(err),
				});
			}
			try {
				return await withActiveSessionLifecycle(req.params.id, async () => {
					const session = await store.open(req.params.id);
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
					// Direct 窗口（§5.2）：绕过 manager relay，直派窗口成员 worker；
					// 窗口 pi session 只作消息流容器，不触发 manager 回合。
					if (teams && invoker) {
						// 气泡只展示用户正文 + 附件名；完整冻结路径块只进 worker 委托消息。
						const attachLine = stored.length ? `附件：${stored.map((item) => item.name).join("、")}` : "";
						const displayText = [content, attachLine].filter(Boolean).join("\n\n");
						const handled = await dispatchDirectMessage(
							{
								teams,
								sessions: store,
								invoker,
								workStates,
								onError: forwardError,
								log: (message) => app.log.info(message),
							},
							req.params.id,
							promptText,
							displayText,
						);
						if (handled) {
							if (isFirstMessage) generateTitle();
							return { accepted: true, attachments: stored.map(({ base64: _base64, ...item }) => item) };
						}
					}
					void session.prompt(promptText, images.length ? ({ images } as PromptOptions) : undefined).catch((err: unknown) => {
						app.log.error({ err, sessionId: req.params.id }, "prompt failed");
						forwardError(req.params.id, err instanceof Error ? err.message : String(err));
					});
					if (isFirstMessage) generateTitle();
					return { accepted: true, attachments: stored.map(({ base64: _base64, ...item }) => item) };
				});
			} catch (err) {
				return reply.code(inactiveContextError(err) ? 409 : 400).send({
					error: inactiveContextError(err) ? "session_context_inactive" : err instanceof Error ? err.message : String(err),
				});
			}
		},
	);

	app.post<{ Params: { id: string } }>("/api/sessions/:id/abort", async (req, reply) => {
		try {
			await requireActiveSessionContext(req.params.id);
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
				return { messages: session.messages, ...toolCallState };
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
						const payload = serializePiEvent(event);
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
