import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { config } from "./config.js";
import { PiSessionStore } from "./pi-bridge/session-store.js";
import { registerChatRoutes } from "./routes/chat.js";

const app = Fastify({ logger: true });

// Browser UI runs on a different origin (Next dev on :8934), so cross-origin
// requests and WebSocket upgrades to this server must be allowed. DELETE must
// be listed explicitly: the plugin's default methods are GET,HEAD,POST, and a
// preflight without DELETE makes the browser silently drop the real request.
await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "DELETE"] });
await app.register(websocket);

const store = new PiSessionStore(config.agentCwd, config.sessionDir);
await registerChatRoutes(app, store);

// §4 health: startup smoke check — create + destroy an in-memory session.
// Validates pi SDK wiring (packages load, resource loader resolves). Model
// auth is checked lazily at first prompt and surfaced to the browser as an
// error event, per the "cheap, event-driven" health strategy.
try {
	const { session } = await createAgentSession({
		cwd: config.agentCwd,
		sessionManager: SessionManager.inMemory(config.agentCwd),
	});
	session.dispose();
	app.log.info({ sessionDir: config.sessionDir, agentCwd: config.agentCwd }, "pi SDK smoke check passed");
} catch (err) {
	app.log.error(err, "pi SDK smoke check failed — exiting");
	process.exit(1);
}

async function shutdown(): Promise<void> {
	app.log.info("shutting down");
	await store.disposeAll();
	await app.close();
}

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

try {
	await app.listen({ host: config.host, port: config.port });
} catch (err) {
	app.log.error(err, "failed to start server");
	process.exit(1);
}
