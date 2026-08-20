import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { config } from "./config.js";
import { acquireLease, ensurePaths, resolvePuddingTeamsPaths } from "./paths.js";
import { PiSessionStore } from "./pi-bridge/session-store.js";
import { CredentialsStore } from "./store/credentials.js";
import { TeamsStore } from "./store/teams.js";
import { registerChatRoutes } from "./routes/chat.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerIdentityRoutes } from "./routes/identity.js";
import { registerProvidersRoutes } from "./routes/providers.js";
import { registerAgentsRoutes } from "./routes/agents.js";
import { registerResourcesRoutes } from "./routes/resources.js";
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
import { registerWorkerProcessRoutes } from "./routes/worker-process.js";
import { WorkerProcessService } from "./agent-runtime/worker-process.js";
import { DelegationTimelineStore } from "./agent-runtime/delegation-timeline-store.js";
import { UploadStore } from "./store/uploads.js";
import { configureSharedModelRuntime } from "./pi-bridge/model-runtime.js";
import { registerWebStatic } from "./web-static.js";

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

// 用户数据目录（文档 §4）：一切平台状态落在 PUDDINGTEAMS_HOME（缺省
// ~/.puddingteams）下；单写者 Lease 保证同一数据目录只有一个后端实例。
const paths = resolvePuddingTeamsPaths();
await ensurePaths(paths);
const releaseLease = await acquireLease(paths).catch((err: unknown) => {
	app.log.error(err, "failed to acquire backend lease — exiting");
	process.exit(1);
});
app.log.info({ home: paths.home }, "puddingteams home resolved");

// 无项目 Window 的中立 cwd：缺省 <home>/workspaces/unscoped（天然无 .pi/*、
// 无 AGENTS.md）；config.agentCwd 仅作显式诊断覆盖。
const defaultCwd = config.agentCwd ?? paths.unscopedWorkspace;

// Extension manifest 明确声明的密钥加密存于 <home>/secrets，不进 agents.json。
const credentials = new CredentialsStore(paths.secrets);
await credentials.init();
// Provider key 与 pi CLI 解耦（§10.6）：平台凭证落到 <home>/secrets/auth.json，
// 不读写 pi 全局 agentDir 的 auth.json。必须先于任何 sharedModelRuntime 使用。
configureSharedModelRuntime({ authPath: path.join(paths.secrets, "auth.json") });
const teams = new TeamsStore(
	{ state: paths.state, assets: paths.assets, managedWorkspaces: paths.managedWorkspaces },
	defaultCwd,
	config.workerTimeoutMs,
	credentials,
);
await teams.init();

// Phase 1：Runtime/Driver 抽取。委托、交互与加密 provider state 独立存储。
const delegations = new DelegationStore(paths.state);
await delegations.init();
const delegationTimelines = new DelegationTimelineStore(path.join(paths.state, "delegation-timelines"));
await delegationTimelines.init();
const interactionSecrets = new InteractionSecretStore(paths.secrets);
await interactionSecrets.init();
// §15.6 交付物登记：Runtime 完成时写入，API 可查。
const artifacts = new ArtifactStore(paths.state, paths.artifactBlobs);
await artifacts.init();
const workStates = new WorkStateStore(paths.state);
await workStates.init();
const uploads = new UploadStore(paths.uploads);
await uploads.init();
const drivers = new DriverRegistry();
// Phase 5：Extension 目录与安装。PuddingClaw 以 builtin Connector 进入目录；
// 上次安装的本地 Extension 在 init 时重新注册（capability→catalog，connector→drivers）。
const catalog = new ExtensionCatalog();
const productSettings = new ProductSettingsStore(paths.config);
const extensionRegistry = new ExtensionRegistry(paths.extensions, catalog, drivers);
extensionRegistry.registerBuiltin(puddingClawConnectorManifest, puddingClawExtensionHooks(), {
	// PuddingClaw 默认头像（布丁狗）随 server 包发布。
	assetsDir: fileURLToPath(new URL("../assets", import.meta.url)),
});
extensionRegistry.registerBuiltin(piConnectorManifest, piExtensionHooks({ sessionDir: paths.workerSessions }), {
	// pi Connector 的默认头像（lobehub Pi 图标）随 server 包发布。
	assetsDir: fileURLToPath(new URL("../assets", import.meta.url)),
});
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
	delegationTimelines,
);
const invoker = new AgentInvoker(teams, runtime, drivers, credentials, defaultCwd);

const store = new PiSessionStore(defaultCwd, paths.sessions, teams, invoker, catalog, workStates, artifacts);
invoker.setManagerSender((managerSessionId, message, options) =>
	store.sendCustomMessage(managerSessionId, message, options),
);
// 启动收割（server_restart）：上次进程退出留下的 running/waiting_input 孤儿
// 委托统一转 failed，并补写 manager 会话——有真实工具调用的补合成 toolResult
// （manager 下次运行能看到失败原因并重新决策）；direct 直派链路（
// managerToolCallId 是 taskId、会话里没有 toolCall）改补一张失败结果卡。
const reapedOrphans = await runtime.reapOrphanedRuns(async (orphan) => {
	if (!orphan.managerToolCallId) return;
	const text =
		`PuddingTeams 服务重启，该任务运行中断（server_restart）。worker「${orphan.agentId}」的执行已终止；` +
		`交接目录 ${orphan.cwdSnapshot}/.pudding/handoff/${orphan.id} 中可能保留了部分进展。如需继续，请重新委派并说明可复用的进展。`;
	const wrote = await store.appendToolResultIfPending(orphan.managerSessionId, {
		toolCallId: orphan.managerToolCallId,
		toolName: `agent_${orphan.agentId}__delegate`,
		text,
		details: { status: "failed", errorCode: "server_restart", delegationId: orphan.id },
	});
	if (!wrote) {
		await store.sendCustomMessage(
			orphan.managerSessionId,
			{
				customType: "pudding:task_result",
				content: text,
				details: { taskId: orphan.managerToolCallId, worker: orphan.agentId, windowId: orphan.windowId, status: "failed" },
			},
			{ triggerTurn: false },
		);
	}
});
if (reapedOrphans > 0) app.log.info({ reaped: reapedOrphans }, "reaped orphaned delegations from previous process");
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
await registerChatRoutes(app, store, teams, workStates, uploads, invoker);
registerIdentityRoutes(app);
await registerSettingsRoutes(app, defaultCwd);
await registerProvidersRoutes(app, store);
await registerAgentsRoutes(app, teams, {
	credentials,
	runtime,
	invoker,
	extensions: extensionRegistry,
	sessions: store,
});
await registerExtensionsRoutes(app, { registry: extensionRegistry, teams, runtime, sessions: store, settings: productSettings });
registerResourcesRoutes(app);
registerWorkspacesRoutes(app, teams.workspaces, undefined, store);
await registerRoomsRoutes(app, store, teams, invoker, workStates, {
	additionalRoots: [paths.uploads],
});
await registerInteractionsRoutes(app, runtime, invoker, teams);
registerArtifactsRoutes(app, artifacts);
registerWorkStateRoutes(app, workStates, teams, store, runtime);
registerWorkerProcessRoutes(app, new WorkerProcessService(delegations, teams, paths.workerSessions, delegationTimelines), {
	cancel: (delegationId, signal) => invoker.cancel(delegationId, signal),
});

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
		cwd: defaultCwd,
		sessionManager: SessionManager.inMemory(defaultCwd),
	});
	session.dispose();
	app.log.info({ home: paths.home, sessions: paths.sessions, agentCwd: defaultCwd }, "pi SDK smoke check passed");
} catch (err) {
	app.log.error(err, "pi SDK smoke check failed — exiting");
	process.exit(1);
}

async function shutdown(): Promise<void> {
	app.log.info("shutting down");
	await store.disposeAll();
	await app.close();
	await releaseLease();
}

process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

try {
	// 发行态：web 静态产物存在时同源托管（dev 下 out/ 不存在则跳过）。
	if (registerWebStatic(app)) {
		app.log.info("serving web static bundle (apps/web/out)");
	}
	await app.listen({ host: config.host, port: config.port });
} catch (err) {
	app.log.error(err, "failed to start server");
	process.exit(1);
}
