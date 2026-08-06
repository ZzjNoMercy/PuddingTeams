import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { config } from "./config.js";
import { PiSessionStore } from "./pi-bridge/session-store.js";
import { CredentialsStore } from "./store/credentials.js";
import { TeamsStore } from "./store/teams.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerAgentsRoutes } from "./routes/agents.js";
import { registerRoomsRoutes } from "./routes/rooms.js";

const app = Fastify({ logger: { level: "warn" } });

// Browser UI runs on a different origin (Next dev on :8934), so cross-origin
// requests and WebSocket upgrades to this server must be allowed. DELETE must
// be listed explicitly: the plugin's default methods are GET,HEAD,POST, and a
// preflight without DELETE makes the browser silently drop the real request.
// Origins are restricted to the local app so a random website on the user's
// machine can't drive the management API (CSRF / localhost port attack).
await app.register(cors, {
	origin: config.allowedOrigins,
	methods: ["GET", "HEAD", "POST", "DELETE", "PUT", "PATCH"],
});
await app.register(websocket);

// Worker 密钥（如 PUDDINGCLAW_TOKEN）加密存于 ~/.puddingteams，不进 teams.json。
const credentials = new CredentialsStore(config.secretsDir);
await credentials.init();
const teams = new TeamsStore(config.teamsDir, config.agentCwd, config.workerTimeoutMs, credentials);
await teams.init();
const store = new PiSessionStore(config.agentCwd, config.sessionDir, teams);
// §1/§2 产品模型：solo 窗口是置顶单例，服务端启动即保证存在。
await teams.ensureSoloWindow(
	() => store.create(),
	async (id) => (await store.list()).some((s) => s.id === id),
);
await registerChatRoutes(app, store, teams);
await registerSettingsRoutes(app);
await registerAgentsRoutes(app, teams, credentials);
await registerRoomsRoutes(app, store, teams);

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
