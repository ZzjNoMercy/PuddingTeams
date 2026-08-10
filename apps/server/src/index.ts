import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { config } from "./config.js";
import { PiSessionStore } from "./pi-bridge/session-store.js";
import { CredentialsStore } from "./store/credentials.js";
import { TeamsStore } from "./store/teams.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerProvidersRoutes } from "./routes/providers.js";
import { registerAgentsRoutes } from "./routes/agents.js";
import { registerRoomsRoutes } from "./routes/rooms.js";
import { registerInteractionsRoutes } from "./routes/interactions.js";
import { AgentRuntime } from "./agent-runtime/runtime.js";
import { DriverRegistry } from "./agent-runtime/driver-registry.js";
import { DelegationStore } from "./agent-runtime/delegation-store.js";
import { InteractionSecretStore } from "./agent-runtime/interaction-secret-store.js";
import { ArtifactStore } from "./agent-runtime/artifact-store.js";
import { AgentInvoker } from "./agent-runtime/invoker.js";
import { ExtensionCatalog } from "./agent-runtime/extensions.js";
import { ExtensionRegistry } from "./agent-runtime/extension-registry.js";
import { puddingClawConnectorManifest, puddingClawExtensionHooks } from "./agent-runtime/puddingclaw-extension.js";
import { piConnectorManifest, piExtensionHooks } from "./agent-runtime/pi-extension.js";
import { registerExtensionsRoutes } from "./routes/extensions.js";
import { registerArtifactsRoutes } from "./routes/artifacts.js";
import { registerWorkspacesRoutes } from "./routes/workspaces.js";
import { ProductSettingsStore } from "./store/product-settings.js";
import { WorkStateStore } from "./store/work-state.js";
import { registerWorkStateRoutes } from "./routes/work-state.js";
import { UploadStore } from "./store/uploads.js";

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

// Phase 1：Runtime/Driver 抽取。委托、交互与加密 provider state 独立存储。
const delegations = new DelegationStore(config.teamsDir);
await delegations.init();
const interactionSecrets = new InteractionSecretStore(config.secretsDir);
await interactionSecrets.init();
// §15.6 交付物登记：Runtime 完成时写入，API 可查。
const artifacts = new ArtifactStore(config.teamsDir);
await artifacts.init();
const workStates = new WorkStateStore(config.teamsDir);
await workStates.init();
const uploads = new UploadStore(config.teamsDir);
await uploads.init();
const drivers = new DriverRegistry();
// Phase 5：Extension 目录与安装。PuddingClaw 以 builtin Connector 进入目录；
// 上次安装的本地 Extension 在 init 时重新注册（capability→catalog，connector→drivers）。
const catalog = new ExtensionCatalog();
const productSettings = new ProductSettingsStore(config.teamsDir);
const extensionRegistry = new ExtensionRegistry(config.teamsDir, catalog, drivers);
extensionRegistry.registerBuiltin(puddingClawConnectorManifest, puddingClawExtensionHooks());
extensionRegistry.registerBuiltin(piConnectorManifest, piExtensionHooks());
await extensionRegistry.init({ developerMode: (await productSettings.get()).developerMode });
// P2（§9.5 双宿主包）：codex / claude-code Connector 本体在 extensions/connectors/*，
// 第一方预置 = 启动时按仓库内路径安装/更新，不再代码内嵌 builtin。
const REPO_CONNECTORS_DIR = fileURLToPath(new URL("../../../extensions/connectors", import.meta.url));
const REPO_CAPABILITIES_DIR = fileURLToPath(new URL("../../../extensions/capabilities", import.meta.url));
await extensionRegistry.installOrUpdateFromDir(path.join(REPO_CONNECTORS_DIR, "codex"));
await extensionRegistry.installOrUpdateFromDir(path.join(REPO_CONNECTORS_DIR, "claude-code"));
await extensionRegistry.installOrUpdateFromDir(path.join(REPO_CAPABILITIES_DIR, "minimal-tool"));
const runtime: AgentRuntime = new AgentRuntime(
	delegations,
	interactionSecrets,
	(agentId) => invoker.driverFor(agentId),
	{ ttlMs: 24 * 60 * 60 * 1000 },
	artifacts,
);
const invoker = new AgentInvoker(teams, runtime, drivers, credentials, config.agentCwd);

const store = new PiSessionStore(config.agentCwd, config.sessionDir, teams, invoker, catalog, workStates, artifacts);
invoker.setManagerSender((managerSessionId, message, options) =>
	store.sendCustomMessage(managerSessionId, message, options),
);
// §1/§2 产品模型：solo 窗口是置顶单例，服务端启动即保证存在。
await teams.ensureSoloWindow(
	async (workspaceId, cwdSnapshot) => {
		return store.create(undefined, {
			type: "solo",
			members: [],
			workspaceId,
			cwd: cwdSnapshot,
		});
	},
	async (id) => store.isOpen(id) || (await store.list()).some((s) => s.id === id),
);
await registerChatRoutes(app, store, teams, workStates, uploads);
await registerSettingsRoutes(app);
await registerProvidersRoutes(app, store);
await registerAgentsRoutes(app, teams, {
	credentials,
	runtime,
	invoker,
	extensions: extensionRegistry,
	sessions: store,
});
await registerExtensionsRoutes(app, { registry: extensionRegistry, teams, runtime, sessions: store, settings: productSettings });
registerWorkspacesRoutes(app, teams.workspaces);
await registerRoomsRoutes(app, store, teams, invoker, workStates);
await registerInteractionsRoutes(app, runtime, invoker, teams);
registerArtifactsRoutes(app, artifacts);
registerWorkStateRoutes(app, workStates, teams, store, runtime);

// §15.6 artifact.created 事件：与现有审批/任务结果同一通道——manager session
// 的 custom message（pi JSONL → 订阅中的 websocket 下发浏览器），不触发新轮次。
artifacts.onCreated((record) => {
	void (async () => {
		const delegation = await runtime.getDelegation(record.delegationId);
		if (!delegation?.managerSessionId) return;
		await store.sendCustomMessage(
			delegation.managerSessionId,
			{
				customType: "pudding:artifact_created",
				content: `worker「${record.producer}」产出交付物：${record.name}`,
				details: { artifact: record },
			},
			{ triggerTurn: false },
		);
	})().catch(() => undefined);
});

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
