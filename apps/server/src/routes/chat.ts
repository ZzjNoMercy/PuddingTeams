import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import { serializePiEvent } from "../pi-bridge/bridge.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";
import type { TeamsStore } from "../store/teams.js";
import { config } from "../config.js";

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
): Promise<void> {
	app.get("/api/health", async () => ({ ok: true, service: "puddingteams-server", piVersion }));

	app.get("/api/models", async () => ({ models: await store.listModels() }));

	app.get("/api/providers", async () => ({ providers: await store.listProviders() }));

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
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
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

	app.post<{ Body: { model?: string } }>("/api/sessions", async (req, reply) => {
		try {
			return { session: await store.create(req.body?.model) };
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
		const removed = await store.remove(req.params.id);
		// A fresh room may only exist as a config (pi writes the session file
		// lazily) — clean the room store regardless, and only 404 when nothing
		// existed at all.
		const hadRoom = teams ? await teams.hasRoomConfig(req.params.id) : false;
		await teams?.removeSessionFromRooms(req.params.id);
		if (!removed && !hadRoom) return reply.code(404).send({ error: "session not found" });
		return reply.code(204).send();
	});

	app.post<{ Params: { id: string }; Body: { model?: string } }>(
		"/api/sessions/:id/model",
		async (req, reply) => {
			const model = req.body?.model?.trim();
			if (!model) {
				return reply.code(400).send({ error: "model is required" });
			}
			try {
				return { model: await store.setModel(req.params.id, model) };
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	);

	app.post<{ Params: { id: string }; Body: { content?: string } }>(
		"/api/sessions/:id/messages",
		async (req, reply) => {
			const content = req.body?.content?.trim();
			if (!content) {
				return reply.code(400).send({ error: "content is required" });
			}
			const session = await store.open(req.params.id);
			void session.prompt(content).catch((err: unknown) => {
				app.log.error({ err, sessionId: req.params.id }, "prompt failed");
				forwardError(req.params.id, err instanceof Error ? err.message : String(err));
			});
			return { accepted: true };
		},
	);

	app.post<{ Params: { id: string } }>("/api/sessions/:id/abort", async (req) => {
		const aborted = await store.abort(req.params.id);
		return { aborted };
	});

	app.get<{ Params: { id: string } }>("/api/sessions/:id/messages", async (req) => {
		const session = await store.open(req.params.id);
		return { messages: session.messages };
	});

	app.get<WsHandlerParams>(
		"/api/sessions/:id/ws",
		{ websocket: true },
		async (socket, req) => {
			const sessionId = req.params.id;
			// Browsers always send Origin on cross-origin upgrades; native
			// clients (curl/node) may omit it — allow those, block foreign pages.
			const origin = req.headers.origin;
			if (origin && !config.allowedOrigins.includes(origin)) {
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
				const session = await store.open(sessionId);
				socket.send(JSON.stringify({ type: "session_ready", sessionId }));
				const unsubscribe = session.subscribe((event) => {
					const payload = serializePiEvent(event);
					if (payload && socket.readyState === socket.OPEN) socket.send(payload);
				});
				socket.on("close", () => {
					unsubscribe();
					sockets?.delete(socket);
				});
				socket.on("error", () => {
					unsubscribe();
					sockets?.delete(socket);
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				socket.send(JSON.stringify({ type: "error", message }));
				socket.close();
				sockets.delete(socket);
			}
		},
	);
}
