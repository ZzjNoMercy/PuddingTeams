import { registerLegacyDataDiagnostics } from "./routes/legacy-data-diagnostics.js";
import { registerLogDiagnostics } from "./routes/diagnostics-log.js";
import { NativeInput } from "./pi-bridge/native-input.js";
import { SessionForks } from "./agent-runtime/session-forks.js";
import { ForkOperations } from "./store/fork-operations.js";
import { ConversationSnapshots } from "./store/conversation-snapshots.js";
import { registerSessionForkRoutes } from "./routes/session-forks.js";
import { DelegationDeliveryStore } from "./store/delegation-delivery.js";
import { DelegationDelivery } from "./agent-runtime/delegation-delivery.js";
import { NativeToolExecution } from "./pi-bridge/native-tool-execution.js";
import { directConversationHistory } from "./agent-runtime/direct-history.js";
import Fastify, { LogController } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { config } from "./config.js";
import { acquireLease, ensurePaths, puddingTeamsHomeId, resolvePuddingTeamsPaths } from "./paths.js";
import { PiSessionStore } from "./pi-bridge/session-store.js";
import { SessionReadService } from "./pi-bridge/session-read.js";
import { CredentialsStore } from "./store/credentials.js";
import { mkdir } from "node:fs/promises";
import QRCode from "qrcode";
import { LarkConnection } from "@puddingteams/capability-lark-cli/connection";
import { registerFeishuRoutes, startFeishuBroker } from "./network/feishu.js";
import { WebResearchSettings, registerWebResearchSettingsRoutes, webResearchTarget } from "./network/web-research.js";
import { TeamsStore } from "./store/teams.js";
import { ExtensionMutationJournal } from "./store/extension-mutation-journal.js";
import { registerChatRoutes } from "./routes/chat.js";
import { ProviderDeletionCoordinator } from "./pi-bridge/provider-deletion.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { readViewerIdentity, registerIdentityRoutes } from "./routes/identity.js";
import { registerProvidersRoutes } from "./routes/providers.js";
import { registerAgentsRoutes } from "./routes/agents.js";
import { registerToolPreviewRoutes } from "./routes/tool-preview.js";
import { registerResourcesRoutes } from "./routes/resources.js";
import { registerChatNavigationRoutes } from "./routes/chat-navigation.js";
import { registerRoomsRoutes } from "./routes/rooms.js";
import { registerInteractionsRoutes } from "./routes/interactions.js";
import { isWorkspaceOwnerClosed } from "./agent-runtime/workspace-owner-lifecycle.js";
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
import { ProductSettingsStore, effectiveLogLevel, readLoggingSettings } from "./store/product-settings.js";
import { LogRing, accessLoggingEnabled, applyLoggingSettings, logStream } from "./logging.js";
import { LargeWorkerResultStore } from "./store/large-worker-result.js";
import { WorkStateStore } from "./store/work-state.js";
import { registerWorkStateRoutes } from "./routes/work-state.js";
import { registerWorkerProcessRoutes } from "./routes/worker-process.js";
import { registerRuntimeFilesRoutes } from "./routes/runtime-files.js";
import { WorkerProcessService } from "./agent-runtime/worker-process.js";
import { DelegationTimelineStore } from "./agent-runtime/delegation-timeline-store.js";
import { WorkspaceExecutionCoordinator } from "./agent-runtime/workspace-execution.js";
import { UploadStore } from "./store/uploads.js";
import { configureSharedModelRuntime } from "./pi-bridge/model-runtime.js";
import { applyThinkingCapabilityOverrides } from "./pi-bridge/custom-providers.js";
import { toModelOverrideEntries } from "./pi-bridge/thinking-capabilities.js";
import { verifyWorkItemSubmission } from "./pi-bridge/agent-extensions.js";
import { registerWebStatic } from "./web-static.js";
import { McpServerStore } from "./store/mcp-servers.js";
import { MessageSubmissionOperations } from "./store/message-submission-operations.js";
import { KnowledgeBindingRegistry } from "./knowledge/bindings.js";
import { KnowledgeAcceptanceStore } from "./knowledge/acceptance.js";
import { KnowledgeObjectStore } from "./knowledge/objects.js";
import { KnowledgeObservationService } from "./knowledge/observation.js";
import { KnowledgeSearchIndex } from "./knowledge/search-index.js";
import { KnowledgeProbeStore } from "./knowledge/probes.js";
import { KnowledgePlanStore } from "./knowledge/plans.js";
import { CompileJobStore } from "./knowledge/compile-jobs.js";
import { createCompileAdmission } from "./knowledge/compile-admission.js";
import { syncCandidateBatches } from "./knowledge/wiki/candidate-sync.js";
import { ReviewStore } from "./knowledge/wiki/review-store.js";
import { PublishJournal } from "./knowledge/wiki/publish-journal.js";
import { MarkdownWikiPublisher } from "./knowledge/wiki/publisher-markdown.js";
import { ContactsProjection } from "./knowledge/contacts.js";
import { registerContactsRoutes } from "./routes/contacts.js";
import { registerKnowledgeRoutes } from "./routes/knowledge.js";
import { MemorySetupService } from "./knowledge/memory-setup.js";
import { registerCalendarRoutes } from "./routes/calendar.js";
import { registerCalendarProviderRoutes } from "./routes/calendar-providers.js";
import { CalendarProviderRegistry } from "./calendar/providers.js";
import { createFeishuCalendarProvider } from "./calendar/feishu.js";
import { CalendarStore } from "./calendar/store.js";
import { CalendarService } from "./calendar/service.js";
import { calendarExtension, calendarTools } from "./calendar/tools.js";
import { setInteractionStatus, type InteractionStatusDeps } from "./knowledge/interaction-status.js";
import { registerWikiRoutes, resolveCodexCompileCommand } from "./routes/wiki.js";
import { localViewerIdentity } from "./routes/identity.js";
import { KnowledgeSelectionStore } from "./knowledge/selections.js";
import { KnowledgeRuntimeService } from "./knowledge/runtime-service.js";
import { CuratorJobStore, WikiCuratorService, curatorJobFeedback } from "./knowledge/curator-jobs.js";
import { KnowledgeSourceStore } from "./knowledge/sources.js";
import { ChatKnowledgeIntake } from "./knowledge/chat-intake.js";
import { directTaskId } from "./agent-runtime/direct-dispatch.js";
import { registerWikiCuratorRoutes } from "./routes/wiki-curator.js";
import { ReadLaterStore } from "./read-later/store.js";
import { ReadLaterCaptureService } from "./read-later/capture-service.js";
import { ReadLaterPromoter } from "./read-later/promote.js";
import { withReadLater } from "./read-later/tool.js";
import { registerReadLaterRoutes } from "./routes/read-later.js";
import { WikiRevisionService } from "./knowledge/wiki/revision-service.js";
import { KnowledgeHistoryStore } from "./knowledge/history-store.js";

// Electron 只需要该变量让自身二进制以 Node 模式启动 server。进入 server 后
// 立即删除，避免 Connector/Worker 子进程继续继承 Electron 专用开关。
if (process.env.PUDDINGTEAMS_DESKTOP === "1") delete process.env.ELECTRON_RUN_AS_NODE;

// 日志级别取持久化设置（设置 → 日志）：必须在构造 Fastify 之前读取，否则首屏
// 启动日志会先按引导默认输出。文件缺失/损坏一律回退默认（info）。
const paths = resolvePuddingTeamsPaths();
const bootLogging = await readLoggingSettings(paths.config);
// 内存环形缓冲与 pino 输出流：既写 stdout（发行态被启动器重定向进文件），
// 也留一份最近日志，供开发态/无文件场景导出诊断包。
const logRing = new LogRing();
const app = Fastify({
	// 访问日志只在有日志文件的运行态输出（见 accessLoggingEnabled）：源码开发态
	// 每个请求两行 JSON 会把终端刷屏，且环形缓冲本就已过滤掉它们。
	logController: new LogController({ disableRequestLogging: !accessLoggingEnabled() }),
	logger: { level: effectiveLogLevel(bootLogging), stream: logStream(logRing) },
});
// console 兜底策略同时生效：pi SDK / Extension / Capability 的 console 输出也受
// 同一开关与级别约束，否则「关闭日志」只是关掉了平台自己那一半。
applyLoggingSettings(app.log, bootLogging);
/** 超过这个耗时的工具调用即使不是错误也要在默认级别可见。 */
const SLOW_TOOL_MS = 10_000;

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
const mcpCredentials = new CredentialsStore(path.join(paths.secrets, "mcp"));
await mcpCredentials.init();
const mcpServers = new McpServerStore(paths.config, mcpCredentials);
await mcpServers.recoverSecretTransaction();
// Provider key 与 pi CLI 解耦（§10.6）：平台凭证落到 <home>/secrets/auth.json，
// 不读写 pi 全局 agentDir 的 auth.json。必须先于任何 sharedModelRuntime 使用。
configureSharedModelRuntime({ authPath: path.join(paths.secrets, "auth.json") });
// 思考强度能力补丁：把平台声明的 modelOverrides 合入 pi 的 models.json 顶层覆盖层，
// 修正上游目录与官方 API 文档不一致的模型（见 thinking-capabilities.ts）。必须先于
// 任何 sharedModelRuntime 使用。写入失败不阻断启动——退回上游目录行为仍是可用的。
try {
	const patched = await applyThinkingCapabilityOverrides(toModelOverrideEntries());
	if (patched.changed > 0) {
		console.warn(`[thinking] 已按平台能力声明修正 ${patched.changed} 个模型的思考强度目录项`);
	}
} catch (error) {
	console.warn(`[thinking] 思考强度能力补丁未生效，将使用 pi 上游目录：${error instanceof Error ? error.message : String(error)}`);
}
const teams = new TeamsStore(
	{
		state: paths.state,
		assets: paths.assets,
		managedWorkspaces: paths.managedWorkspaces,
		bundledAssets: fileURLToPath(new URL("../assets", import.meta.url)),
	},
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
const largeWorkerResults = new LargeWorkerResultStore(paths.state);
const initialProductSettings = await productSettings.get();
workStates.configureOperationLedger(initialProductSettings.harness.goalRecovery);
workStates.configureVerificationDefaults({
	minimumWorkItemMode: initialProductSettings.harness.verification.defaultWorkItemMode,
	finalGoalMode: initialProductSettings.harness.verification.defaultFinalGoalMode,
	trigger: initialProductSettings.harness.verification.trigger,
	workspaceExecution: {
		readOnlyMode: initialProductSettings.harness.workspaceExecution.readOnlyDefault,
		gitWriteMode: initialProductSettings.harness.workspaceExecution.gitWriteDefault,
		nonGitWriteMode: initialProductSettings.harness.workspaceExecution.nonGitWriteDefault,
	},
});
const workspaceExecution = new WorkspaceExecutionCoordinator(paths.state, {
	worktreeRoot: path.join(paths.runtime, "worktrees"),
	leaseTimeoutMs: initialProductSettings.harness.workspaceExecution.leaseTimeoutMs,
});
await workspaceExecution.init();
const extensionRegistry = new ExtensionRegistry(paths.extensions, catalog, drivers);
extensionRegistry.registerBuiltin(puddingClawConnectorManifest, puddingClawExtensionHooks(), {
	// PuddingClaw 默认头像（布丁狗）随 server 包发布。
	assetsDir: fileURLToPath(new URL("../assets", import.meta.url)),
});
const fffStateRoot = path.join(paths.runtime, "fff", "workspaces");
extensionRegistry.registerBuiltin(piConnectorManifest, piExtensionHooks({ sessionDir: paths.workerSessions, fffStateRoot }), {
	// pi Connector 的默认头像（lobehub Pi 图标）随 server 包发布。
	assetsDir: fileURLToPath(new URL("../assets", import.meta.url)),
});
await extensionRegistry.init({
	developerMode: initialProductSettings.developerMode,
	bundledIds: ["codex", "claude-code", "lark-cli"],
});
// P2（§9.5 双宿主包）：codex / claude-code Connector 本体在 extensions/connectors/*，
// 第一方预置 = 启动时按仓库内路径安装/更新，不再代码内嵌 builtin。
const REPO_CONNECTORS_DIR = fileURLToPath(new URL("../../../extensions/connectors", import.meta.url));
const REPO_CAPABILITIES_DIR = fileURLToPath(new URL("../../../extensions/capabilities", import.meta.url));
await extensionRegistry.installOrUpdateFromDir(path.join(REPO_CONNECTORS_DIR, "codex"));
await extensionRegistry.installOrUpdateFromDir(path.join(REPO_CONNECTORS_DIR, "claude-code"));
await extensionRegistry.installOrUpdateFromDir(path.join(REPO_CAPABILITIES_DIR, "lark-cli"));
const capabilityStateRoot = path.join(paths.secrets, "capabilities");
// One encrypted record for the application and user; bindings only reference it.
const feishuVaultDir = path.join(paths.secrets, "connections", "feishu");
await mkdir(feishuVaultDir, { recursive: true, mode: 0o700 });
const feishuVault = new CredentialsStore(feishuVaultDir);
await feishuVault.init();
const feishuConnection = new LarkConnection({
	read: async () => (await feishuVault.getSecrets("default")).connection,
	write: async value => { await feishuVault.setSecrets("default", { connection: value }); },
}, { qr: url => QRCode.toDataURL(url, { width: 224, margin: 2, color: { dark: "#000000", light: "#ffffff" } }) });
const feishuBroker = await startFeishuBroker(feishuConnection);
catalog.setConnection("lark-cli", feishuBroker.service);
registerFeishuRoutes(app, feishuConnection);
app.addHook("onClose", async () => { await feishuBroker.close(); });
const compileJobs = new CompileJobStore(paths.knowledgeState);
const reviewStore = new ReviewStore(paths.knowledgeReviews);
const knowledgeRegistry = new KnowledgeBindingRegistry(paths.knowledgeState);
const knowledgeObjects = new KnowledgeObjectStore(paths.knowledgeObjects);
const knowledgeHistory = new KnowledgeHistoryStore(paths.knowledgeState);
const knowledgeAcceptance = new KnowledgeAcceptanceStore(paths.knowledgeAcceptance, knowledgeHistory);
await knowledgeAcceptance.recoverHistory();
const publishJournal = new PublishJournal(paths.knowledgeOperations);
const knowledgeSearchIndex = new KnowledgeSearchIndex(paths.knowledgeCache, knowledgeObjects);
const knowledgeObservation = new KnowledgeObservationService(knowledgeAcceptance, { objects: knowledgeObjects, journal: publishJournal, searchIndex: knowledgeSearchIndex });
const knowledgeProbes = new KnowledgeProbeStore();
const knowledgePlans = new KnowledgePlanStore(paths.knowledgePlans);
const memorySetup = new MemorySetupService(paths.knowledgeState, { registry: knowledgeRegistry,
	probes: knowledgeProbes, plans: knowledgePlans, acceptance: knowledgeAcceptance, objects: knowledgeObjects });
const knowledgeSelections = new KnowledgeSelectionStore(paths.knowledgeState, knowledgeRegistry);
const knowledgeRuntime = new KnowledgeRuntimeService({ bindings: knowledgeRegistry, acceptance: knowledgeAcceptance,
	objects: knowledgeObjects, observation: knowledgeObservation, selections: knowledgeSelections, teams, stateDir: paths.knowledgeState, cacheDir: paths.knowledgeCache });
const curatorJobs = new CuratorJobStore(paths.knowledgeState);
const knowledgeSources = new KnowledgeSourceStore({ stateDir: paths.knowledgeState, objects: knowledgeObjects });
const contactsProjection = new ContactsProjection({ bindings: knowledgeRegistry, objects: knowledgeObjects, acceptance: knowledgeAcceptance, observation: knowledgeObservation, searchIndex: knowledgeSearchIndex });
const calendarService = new CalendarService(new CalendarStore(paths.calendarState), { contacts: contactsProjection, bindings: knowledgeRegistry, acceptance: knowledgeAcceptance, observation: knowledgeObservation, objects: knowledgeObjects, sources: knowledgeSources, reviews: reviewStore });
// 往来/日程统一状态：wiki 侧直写经 calendar 适配器一跳同步日程；日程侧经反向回调一跳同步 wiki，source 标记保证不递归。
const interactionStatusDeps: InteractionStatusDeps = { bindings: knowledgeRegistry, observation: knowledgeObservation, acceptance: knowledgeAcceptance,
	calendar: {
		get: async (ownerId, eventId) => { const event = await calendarService.store.get(ownerId, eventId); return { revision: event.revision, status: event.status }; },
		setStatus: (ownerId, eventId, operationId, expectedRevision, status) => calendarService.setStatus(ownerId, eventId, operationId, expectedRevision, status, { source: "wiki" }),
	} };
const interactionStatusHandler = (input: Parameters<typeof setInteractionStatus>[1]) => setInteractionStatus(interactionStatusDeps, input);
calendarService.setInteractionStatusSync((args) => setInteractionStatus(interactionStatusDeps, args, { source: "calendar" }));
knowledgeRuntime.setInteractionStatusHandler(interactionStatusHandler);
const chatKnowledgeIntakes = new ChatKnowledgeIntake({ stateDir: paths.knowledgeState, sources: knowledgeSources });
const wikiCurator = new WikiCuratorService({ jobs: curatorJobs, bindings: knowledgeRegistry, acceptance: knowledgeAcceptance,
	objects: knowledgeObjects, reviews: reviewStore, runtime: knowledgeRuntime, teams, cacheDir: paths.knowledgeCache, sources: knowledgeSources,
	notify: async (job) => {
		if (!job.origin || !await teams.contextForSession(job.origin.sessionId)) return;
		await store.appendCustomMessageIfAbsent(job.origin.sessionId, `wiki-curator:${job.id}:${job.status}:${job.recoveryRevision ?? 0}`, {
			customType: "pudding:knowledge_job",
			content: curatorJobFeedback(job).message,
			details: { ...curatorJobFeedback(job), bindingId: job.targetBindingId, batchId: job.candidateBatchId },
		}, { triggerTurn: false });
	} });
knowledgeRuntime.setCurationStatusReader((ownerId, jobId) => wikiCurator.readStatus(ownerId, jobId));
const wikiRevisions = new WikiRevisionService({ curator: wikiCurator, jobs: curatorJobs, reviews: reviewStore, bindings: knowledgeRegistry, objects: knowledgeObjects, publications: publishJournal });
// T40/T42/T44：发布操作日志 + Markdown 发布器（检索索引为派生缓存，提前构造供发布回写后重建）。
const wikiPublisher = new MarkdownWikiPublisher({
	bindings: knowledgeRegistry,
	reviews: reviewStore,
	journal: publishJournal,
	acceptance: knowledgeAcceptance,
	observation: knowledgeObservation,
	objects: knowledgeObjects,
	searchIndex: knowledgeSearchIndex,
	operationsDir: paths.knowledgeOperations,
	assertSourceCurrent: batch => calendarService.assertPublicationCurrent(batch),
});
const runtime: AgentRuntime = new AgentRuntime(
	delegations,
	interactionSecrets,
	(agentId) => invoker.driverFor(agentId),
	{ ttlMs: 24 * 60 * 60 * 1000 },
	artifacts,
	delegationTimelines,
	workspaceExecution,
	createCompileAdmission({ jobs: compileJobs, bindings: knowledgeRegistry, acceptance: knowledgeAcceptance,
		observation: knowledgeObservation, objects: knowledgeObjects, teams, extensions: extensionRegistry }),
);
runtime.setWorkspaceOwnerClosedResolver((owner) => isWorkspaceOwnerClosed(workStates, owner));
const invoker = new AgentInvoker(
	teams,
	runtime,
	drivers,
	credentials,
	defaultCwd,
	catalog,
	capabilityStateRoot,
	productSettings,
	fffStateRoot,
	mcpServers,
);

const nativeExecutions = new NativeToolExecution(paths.state, workspaceExecution, teams, workStates);
await nativeExecutions.init();
invoker.setNativeExecutionGuard((sessionId) => nativeExecutions.assertDelegationReady(sessionId));
const store = new PiSessionStore(
	defaultCwd,
	paths.sessions,
	teams,
	invoker,
	catalog,
	workStates,
	artifacts,
	largeWorkerResults,
	productSettings,
	capabilityStateRoot,
	fffStateRoot,
	mcpServers,
	nativeExecutions,
);
// 会话深链（docs/2026-10-16-会话深链交接方案.md）：manager/worker 单聊由
// PiSessionStore 自行装配，Worker 委派执行会话经 invoker 注入。
invoker.setSessionRead(new SessionReadService(teams, paths.sessions, (msg) => app.log.warn({ component: "session-read" }, msg)));
store.setKnowledgeRuntime(knowledgeRuntime);
// 诊断与运行时活动的出口。`setDebugLog` 此前只有埋点、没有调用方（11 处写进空气）；
// 那些消息都是降级/失败（能力装配失败、模型自愈失败、投递失败），按 warn 落地。
store.setDebugLog((message) => app.log.warn({ component: "pi-session" }, message));
// 轮次/工具耗时、自动重试、上下文压缩：平台此前完全没有这类数据（定位停止超时与
// 慢轮次时只能靠时间戳反推）。工具调用量大，只在出错或明显偏慢时提到 warn。
store.setActivityLog(({ sessionId, kind, ...fields }) => {
	const slowTool = kind === "tool" && (fields.isError === true || (fields.durationMs ?? 0) >= SLOW_TOOL_MS);
	if (kind === "retry") app.log.warn({ sessionId, ...fields }, "模型调用自动重试");
	else if (kind === "tool") app.log[slowTool ? "warn" : "debug"]({ sessionId, ...fields }, "工具执行完成");
	else if (kind === "compaction") app.log.info({ sessionId, ...fields }, "上下文压缩");
	else app.log.info({ sessionId, ...fields }, "会话轮次完成");
});
// Manager 即知识整理负责人（无知识管家委派）：完整知识面 + 候选管线直接挂到
// manager 会话，素材解析与 direct 直派共用 chatKnowledgeIntakes 链路。
knowledgeRuntime.setManagerCuration((surface, scope) => wikiCurator.workerSurface(surface, {
	ownerId: scope.ownerId, windowId: scope.windowId, sessionId: scope.sessionId,
	operationId: `native:${scope.sessionId}:manager`,
	listSourceMessages: async () => chatKnowledgeIntakes.messages(await store.open(scope.sessionId), scope.ownerId),
	resolveSources: async (toolCallId, ids) => ids
		? chatKnowledgeIntakes.resolveMessages(await store.open(scope.sessionId), scope.ownerId, ids)
		: chatKnowledgeIntakes.resolve(await store.open(scope.sessionId), scope.ownerId, { toolCallId }),
}, "wiki"));
const messageOperations = new MessageSubmissionOperations(path.join(paths.state, "message-submission-operations"));
const nativeInputController = new NativeInput(store,messageOperations,chatKnowledgeIntakes);
const calendarScope = async (sessionId: string) => {
 const scope = await knowledgeRuntime.scopeForSession(sessionId);
 if (!scope) throw new Error("当前聊天上下文不可用");
 const selection = await knowledgeSelections.effective(scope.ownerId, scope.contextKey);
 return { ownerId: scope.ownerId, bindingIds: selection.selectedBindingIds, assertCurrent: async () => {
  const next = await knowledgeSelections.effective(scope.ownerId, scope.contextKey);
  if (next.revision !== selection.revision || JSON.stringify(next.selectedBindingIds) !== JSON.stringify(selection.selectedBindingIds)) throw new Error("本轮知识库选择已变化，请重试");
 } };
};
store.setCalendarExtension((getSessionId, opts) => calendarExtension(calendarService, () => calendarScope(getSessionId()), opts));
invoker.setConversationHistory(async (agent, ctx) => {
	const delegation = ctx.delegationId ? await runtime.getDelegation(ctx.delegationId) : undefined;
	if (!delegation?.operationId) return [];
	const context = await teams.contextForSession(delegation.managerSessionId);
	if (context?.window.type !== "direct") return [];
	if (!context.active || context.window.id !== delegation.windowId || !context.window.members.includes(agent.name) ||
		context.workspaceId !== ctx.workspaceId || context.cwdSnapshot !== ctx.cwd)
		throw new Error("聊天上下文不属于当前执行窗口和项目");
	const session = await store.open(delegation.managerSessionId);
	return directConversationHistory(session.sessionManager.getBranch(), delegation.operationId);
});

const readLaterStore = new ReadLaterStore(path.join(paths.state, "read-later"));
const readLaterCapture = new ReadLaterCaptureService(readLaterStore);
const readLaterPromoter = new ReadLaterPromoter({ store: readLaterStore, capture: readLaterCapture, sources: knowledgeSources, curator: wikiCurator, bindings: knowledgeRegistry });
knowledgeRuntime.setChatIntake(async (session) => { await store.ensureSessionFile(session.sessionId); await chatKnowledgeIntakes.admitManager(session); },
	(sessionId, prompt, images) => chatKnowledgeIntakes.observeExecution(sessionId, prompt, images));
const webResearchCredentials = new CredentialsStore(path.join(paths.secrets, "web-research"));
await webResearchCredentials.init();
const webResearch = new WebResearchSettings(webResearchCredentials, async (provider) => {
	const credential = await store.snapshotProviderCredential(provider === "grok" ? "xai" : provider) as { type?: string; key?: string } | undefined;
	return credential?.type === "api_key" ? credential.key : undefined;
}, undefined, {
  targets: async () => (await teams.listAgents()).map(webResearchTarget),
  onAccessChanged: () => store.markAllDirty(),
});
store.setWebResearchExtension((agentId, opts) => webResearch.extension(agentId, opts));
invoker.setWebResearchExtension(agentId => webResearch.extension(agentId), agentId => webResearch.accessFingerprint(agentId), agentId => webResearch.tools(agentId));
invoker.setKnowledgeRuntime(async (agent, ctx, _message) => {
	const delegation = ctx.delegationId ? await runtime.getDelegation(ctx.delegationId) : undefined;
	const sessionId = delegation?.managerSessionId;
	const surface = await knowledgeRuntime.forSession(sessionId ?? "");
	const scope = sessionId ? await knowledgeRuntime.scopeForSession(sessionId) : undefined;
	const memory = await memorySetup.status(localViewerIdentity().user.id);
	const defaultMemory = memory.status === "configured" ? { bindingId: memory.binding.id, assertCurrent: async () => {
		const current = await memorySetup.status(localViewerIdentity().user.id);
		if (current.status !== "configured" || current.binding.id !== memory.binding.id) throw new Error("默认 memory 已变化，请重新开始本轮");
	} } : undefined;
	const direct = Boolean(delegation?.operationId && delegation.managerToolCallId === directTaskId(delegation.operationId));
	const curatedSurface = scope ? wikiCurator.workerSurface(surface, { ...scope, operationId: ctx.operationId ?? ctx.delegationId ?? scope.sessionId,
		...(direct ? { listSourceMessages: async () => chatKnowledgeIntakes.messages(await store.open(scope.sessionId), scope.ownerId) } : {}),
		resolveSources: async (_toolCallId, sourceMessageIds) => {
			const session = await store.open(scope.sessionId);
			if (sourceMessageIds) {
				if (!direct) throw new Error("历史消息素材选择只属于当前单聊");
				return chatKnowledgeIntakes.resolveMessages(session, scope.ownerId, sourceMessageIds);
			}
			return chatKnowledgeIntakes.resolve(session, scope.ownerId, direct ? { operationId: delegation!.operationId } : { toolCallId: delegation?.managerToolCallId });
		} }, agent.builtinId, defaultMemory) : surface;
	if (agent.builtinId === "wiki") return curatedSurface;
	const ordinary = withReadLater(curatedSurface, localViewerIdentity().user.id, readLaterStore, readLaterCapture);
	return { ...ordinary, tools: [...ordinary.tools, ...calendarTools(calendarService, () => calendarScope(sessionId ?? ""))] };
});
store.setNativeKnowledgeSurface(async(sessionId,agent,operationId)=>{
 const surface=await knowledgeRuntime.forSession(sessionId),scope=await knowledgeRuntime.scopeForSession(sessionId);
 if(!scope)return surface;
 const memory=await memorySetup.status(scope.ownerId);
 const defaultMemory=memory.status==="configured"?{bindingId:memory.binding.id,assertCurrent:async()=>{const current=await memorySetup.status(scope.ownerId);if(current.status!=="configured"||current.binding.id!==memory.binding.id)throw new Error("默认 memory 已变化，请重新开始本轮");}}:undefined;
 const curated=wikiCurator.workerSurface(surface,{...scope,operationId,
  listSourceMessages:async()=>chatKnowledgeIntakes.messages(await store.open(sessionId),scope.ownerId),
  resolveSources:async(toolCallId,ids)=>ids?chatKnowledgeIntakes.resolveMessages(await store.open(sessionId),scope.ownerId,ids):chatKnowledgeIntakes.resolve(await store.open(sessionId),scope.ownerId,{toolCallId})},agent.builtinId,defaultMemory);
 return agent.builtinId==="wiki"?curated:withReadLater(curated,scope.ownerId,readLaterStore,readLaterCapture);
});
const extensionMutationJournal = new ExtensionMutationJournal(path.join(paths.state, "extension-mutation-pending.json"));
const recoveredExtensionAgents = await extensionMutationJournal.recover(async (name) => {
	if (await teams.getAgent(name)) await teams.bumpAgentRevision(name);
}, async () => { await store.syncAgentConfigChange(); });
if (recoveredExtensionAgents.length > 0) app.log.warn({ agents: recoveredExtensionAgents }, "reconciled interrupted Extension mutation before opening routes");
const mcpMutationJournal = new ExtensionMutationJournal(path.join(paths.state, "mcp-mutation-pending.json"), "MCP");
const recoveredMcpAgents = await mcpMutationJournal.recover(async (name) => {
	if (await teams.getAgent(name)) await teams.bumpAgentRevision(name);
}, async () => { await store.syncAgentConfigChange(); });
if (recoveredMcpAgents.length > 0) app.log.warn({ agents: recoveredMcpAgents }, "reconciled interrupted MCP mutation before opening routes");
const recoveredRoomCreations = await teams.reconcileRoomCreations((id) => store.remove(id));
if (recoveredRoomCreations.kept || recoveredRoomCreations.removed) {
	app.log.info(recoveredRoomCreations, "reconciled pending room Session creations before opening routes");
}
invoker.setManagerSender((managerSessionId, message, options) =>
	store.sendCustomMessage(managerSessionId, message, options),
);
invoker.setDurableManagerSender((managerSessionId, eventId, message, options) =>
	store.appendCustomMessageIfAbsent(managerSessionId, eventId, message, options).then(() => undefined),
);
let automaticVerificationQueue: Promise<void> = Promise.resolve();
async function reconcileWorkAndScheduleVerification(): Promise<void> {
	await workStates.reconcileDelegations(await runtime.listDelegations());
	const run = automaticVerificationQueue.then(async () => {
		for (const snapshot of await workStates.listActive()) {
			for (const snapshotItem of Object.values(snapshot.plan?.items ?? {})) {
				if (snapshotItem.status !== "submitted"
					|| snapshotItem.verificationPolicy.trigger !== "auto_on_submission"
					|| snapshotItem.verificationPolicy.mode === "manager_review") continue;
				const snapshotSubmission = [...snapshotItem.submissions].reverse().find((entry) => !entry.review);
				if (!snapshotSubmission || snapshotSubmission.verifications.length > 0) continue;
				// Re-read immediately before the state-changing call because another
				// completed Delegation may have advanced the same Goal revision.
				const current = await workStates.getActive(snapshot.sessionId);
				const item = current?.plan?.items[snapshotItem.id];
				const submission = item ? [...item.submissions].reverse().find((entry) => !entry.review) : undefined;
				if (!current || !item || item.status !== "submitted" || !submission || submission.verifications.length > 0) continue;
				try {
					const verificationResult = await verifyWorkItemSubmission({
						store: teams,
						sessions: store,
						invoker,
						catalog,
						workStates,
						artifacts,
						largeResults: largeWorkerResults,
						productSettings,
						getSessionId: () => current.sessionId,
						ctx: undefined,
						resolveContext: async () => undefined,
						log: (message) => app.log.warn(message),
					}, `auto-verification:${submission.id}`, {
						goalId: current.goalId,
						workItemId: item.id,
						expectedRevision: current.revision,
					}, { trigger: "auto_on_submission" });
					const verification = verificationResult.details.verification as { id?: string; status?: string } | undefined;
					if (verification?.id && verification.status && verification.status !== "running") {
						await store.appendCustomMessageIfAbsent(
							current.sessionId,
							`auto-verification-ready:${verification.id}`,
							{
								customType: "pudding:work_plan_update",
								content: `平台自动复验已完成（${verification.status}）。请读取最新 WorkState，按 VerificationRecord 验收并汇总三轴状态；不要再调用手工复验工具。`,
								details: { goalId: current.goalId, workItemId: item.id, verificationId: verification.id, status: verification.status, trigger: "auto_on_submission" },
							},
							{ triggerTurn: true, deliverAs: "followUp" },
						);
					}
				} catch (error) {
					app.log.warn({ error, sessionId: current.sessionId, workItemId: item.id }, "automatic WorkItem verification could not start");
				}
			}
		}
	});
	automaticVerificationQueue = run.catch(() => undefined);
	await run;
}
invoker.setDelegationStateObserver(reconcileWorkAndScheduleVerification);
invoker.setReplacementWindowResolver(async (delegation) => {
	const owner = await teams.windowForSession(delegation.managerSessionId);
	if (!owner) throw new Error("replacement owner Session missing");
	return owner.id;
});
invoker.setReplacementStateGuard(async (original, replacement, agent, replacementWindowId) => {
	const [owner, target] = await Promise.all([
		teams.windowForSession(original.managerSessionId),
		teams.getWindow(replacementWindowId),
	]);
	if (!owner || !target || target.workspaceId !== original.workspaceId || target.cwdSnapshot !== original.cwdSnapshot) {
		throw new Error("改派期间房间或 Workspace 已变化");
	}
	if (owner.type === "solo") {
		if (target.type !== "direct" || target.members[0] !== agent.name || owner.workspaceId !== original.workspaceId || owner.cwdSnapshot !== original.cwdSnapshot) {
			throw new Error("改派目标已不属于当前 Solo Workspace");
		}
	} else if (owner.id !== original.windowId || target.id !== owner.id || !target.members.includes(agent.name)) {
		throw new Error("改派期间群成员或房间归属已变化");
	}
	if (!original.goalId || !original.workItemId || original.goalEpoch === undefined) return;
	await workStates.reserveReplacementDelegation({
		sessionId: original.managerSessionId,
		goalId: original.goalId!,
		workItemId: original.workItemId!,
		goalEpoch: original.goalEpoch!,
		goalRevision: original.goalRevision,
		workItemRevision: original.workItemRevision,
		originalDelegationId: original.id,
		replacementDelegationId: replacement.id,
	});
});
// 启动对账：本地生命周期绑定进程按已确认消失结算；远端 Run 按 Driver 能力
// 查询/重挂，无法确认的副作用进入 observation_lost/effect_unknown。
// 已确认的本地中断补写 manager 会话——有真实工具调用的补合成 toolResult
// （manager 下次运行能看到失败原因并重新决策）；direct 直派链路（
// managerToolCallId 是 taskId、会话里没有 toolCall）改补一张失败结果卡。
// A local compiler from a previous process must never retain authority to
// promote its staging tree. Fence the durable Job before normal Run recovery.
const interruptedCompileJobs = await compileJobs.failInterrupted();
if (interruptedCompileJobs.length > 0) app.log.warn({ count: interruptedCompileJobs.length }, "fenced interrupted knowledge compile jobs");
const syncedWikiCandidates = await syncCandidateBatches({ jobs: compileJobs, reviews: reviewStore });
if (syncedWikiCandidates.unavailable.length > 0) app.log.warn(syncedWikiCandidates, "wiki candidate promotion requires repair");
// 发布对账包含 approve 落账后、journal 创建前的崩溃空窗。
const reconciledPublications = await wikiPublisher.reconcileInterrupted();
if (reconciledPublications.length > 0) app.log.warn({ count: reconciledPublications.length }, "reconciled interrupted wiki publish operations");
const delegationDelivery = new DelegationDelivery(new DelegationDeliveryStore(path.join(paths.state, "delegation-delivery.json")), runtime, store, teams, largeWorkerResults, productSettings);
invoker.setTerminalPublisher(record => delegationDelivery.publish(record));
const reconciledOrphans = await runtime.reconcileOrphanedRuns(async () => { await reconcileWorkAndScheduleVerification(); });
if (reconciledOrphans > 0) app.log.info({ reconciled: reconciledOrphans }, "reconciled orphaned delegations");
async function sweepExpiredAdmissions(): Promise<number> {
	const before = (await runtime.listInteractions())
		.filter((item) => item.source === "platform_policy" && item.status === "pending")
		.map((item) => item.delegationId);
	const expired = await runtime.expireAdmissionRequests();
	if (expired === 0) return 0;
	const delegations = await runtime.listDelegations();
	await reconcileWorkAndScheduleVerification();
	for (const delegation of delegations) {
		if (!before.includes(delegation.id) || delegation.executionState !== "cancelled") continue;
		if (!delegation.result || !("errorCode" in delegation.result) || delegation.result.errorCode !== "admission_expired") continue;
		await delegationDelivery.publish(delegation);
	}
	return expired;
}
const expiredAdmissions = await sweepExpiredAdmissions();
if (expiredAdmissions > 0) app.log.info({ expiredAdmissions }, "expired stale Teams admission requests");
const reconciledAdmissions = await runtime.reconcileAdmissionApplications();
if (reconciledAdmissions > 0) app.log.info({ reconciledAdmissions }, "reconciled Teams admission application journals");
await delegationDelivery.recover(false);
const deliveryTimer = setInterval(() => { void delegationDelivery.recover().catch(error => app.log.warn({ error }, "delegation delivery pending")); }, 2_000);
deliveryTimer.unref();
app.addHook("onClose", async () => { clearInterval(deliveryTimer); });
// Crash window repair: a Delegation/Interaction boundary may already be durable
// while the manager JSONL still lacks its single delegate toolResult. Repair both
// terminal outcomes and waiting_admission (needs_input) before HTTP opens.
const recoverableManagerSessions = new Set(
	(await runtime.listDelegations())
		.filter((item) => Boolean(item.managerToolCallId) && ["waiting_admission", "reported_completed", "reported_failed", "cancelled", "observation_lost"].includes(item.executionState))
		.map((item) => item.managerSessionId),
);
let recoveredManagerSessions = 0;
for (const sessionId of recoverableManagerSessions) {
	try {
		if (!(await teams.contextForSession(sessionId))?.active) continue;
		const recovered = await store.recoverToolCallState(sessionId);
		if (recovered.recoveredToolResults.length > 0) recoveredManagerSessions++;
	} catch (error) {
		app.log.warn({ error, sessionId }, "failed to repair manager tool results during startup");
	}
}
if (recoveredManagerSessions > 0) app.log.info({ recoveredManagerSessions }, "repaired manager delegate tool results during startup");
// Goal recovery runs after Runtime has reconciled/sealed Runs and before HTTP
// opens. Terminal Delegations are projected into WorkItem submissions exactly
// once; restart orphans advance one Goal epoch and never resurrect the old Run.
const reconciledGoals = await workStates.reconcileDelegations(await runtime.listDelegations());
if (reconciledGoals.projected || reconciledGoals.interrupted) {
	app.log.info(reconciledGoals, "reconciled Goal checkpoints");
}
await reconcileWorkAndScheduleVerification();
const goalRecoverySettings = (await productSettings.get()).harness.goalRecovery;
for (const state of await workStates.listActive()) {
	if (state.execution.status !== "interrupted") continue;
	const context = await teams.contextForSession(state.sessionId);
	if (!context?.active || context.window.type === "direct" || goalRecoverySettings.mode !== "safe_auto") continue;
	await workStates.resumeGoal(
		state.sessionId,
		state.revision,
		{ ownerId: "startup-recovery", leaseMs: goalRecoverySettings.resumeLeaseMs },
		`startup-resume:${state.goalId}:${state.execution.epoch}`,
		state.goalId,
	).catch(() => undefined);
}
let goalOutboxDrain: Promise<void> = Promise.resolve();
async function drainGoalOutbox(): Promise<void> {
	for (const event of await workStates.pendingOutbox()) {
		try {
			const context = await teams.contextForSession(event.sessionId);
			// Keep the durable event pending. The periodic drain will deliver it
			// after the user activates this project context again.
			if (!context?.active) continue;
			if (event.kind === "goal_changed") {
				await store.appendCustomMessageProjectionIfAbsent(event.sessionId, event.id, {
					customType: "pudding:work_plan_update",
					content: "Goal 或 WorkPlan 权威状态已更新，请重新读取 work-state。",
					details: { goalId: event.goalId, ...event.payload },
				});
				await workStates.markOutboxDelivered(event.id);
				continue;
			}
			const owner = context.window;
			const current = await workStates.getActive(event.sessionId);
			const belongsToCurrentGoal = current?.goalId === event.goalId;
			const triggerTurn = belongsToCurrentGoal && (event.kind === "decision_answered" || (event.kind === "goal_recovery" && owner?.type !== "direct"));
			const content = event.kind === "decision_answered"
				? "Human 已回答业务决策，请从同一 Goal 的安全点继续。"
				: event.kind === "goal_recovery"
					? "PuddingTeams 已完成重启对账。请保留已验收 WorkItem，从最近安全点创建新的 Delegation attempt；不要把旧 Run 当作仍在运行。"
					: "Goal 已暂停；历史 Delegation 保留为审计事实，等待安全恢复。";
			const disposition = await store.appendCustomMessageIfAbsent(
				event.sessionId,
				event.id,
				{ customType: event.kind === "goal_recovery" ? "pudding:goal_recovery" : event.kind === "goal_interrupted" ? "pudding:goal_interrupted" : "pudding:decision_answered", content, details: { goalId: event.goalId, ...event.payload } },
				{ triggerTurn, deliverAs: triggerTurn ? "followUp" : undefined },
			);
			// The workspace may have switched after the active pre-check. A deferred
			// wake-up is intentionally not acknowledged; it will be retried after the
			// owning context is active again.
			if (disposition === "deferred") continue;
			// A delivered recovery event advances execution only after the receiver
			// has durably accepted it. If the process dies before acknowledgement,
			// receiver-side eventId dedupe makes the retry harmless.
			if (event.kind === "goal_recovery" && triggerTurn) {
				if (current?.execution.status === "recovering") {
					await workStates.update(
						event.sessionId,
						current.revision,
						{ executionStatus: "running" },
						`recovery-delivered:${event.id}`,
						current.execution.epoch,
						current.goalId,
					);
				}
			}
			await workStates.markOutboxDelivered(event.id);
		} catch (error) {
			app.log.warn({ err: error, eventId: event.id }, "Goal outbox delivery failed; will retry");
		}
	}
}
function scheduleGoalOutboxDrain(): Promise<void> {
	const run = goalOutboxDrain.then(drainGoalOutbox, drainGoalOutbox);
	goalOutboxDrain = run.catch(() => undefined);
	return run;
}
// Start draining immediately, but never hold server startup behind a recovery
// turn. A pending follow-up may legitimately wait for an AgentSession event;
// awaiting it before app.listen leaves Node with an unsettled top-level await
// and no live server handle, so the process can exit before health/routes exist.
void scheduleGoalOutboxDrain().catch((error) => app.log.warn({ error }, "initial Goal outbox delivery failed; will retry"));
const goalOutboxTimer = setInterval(() => void scheduleGoalOutboxDrain(), 2_500);
goalOutboxTimer.unref();
const admissionExpiryTimer = setInterval(() => {
	void sweepExpiredAdmissions().catch((error) => app.log.warn({ error }, "failed to sweep expired Teams admission requests"));
}, 5_000);
admissionExpiryTimer.unref();
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
const providerDeletion = new ProviderDeletionCoordinator(path.join(paths.secrets, "provider-deletion-journal.json"), store);
await registerChatRoutes(app, store, teams, workStates, uploads, invoker, {
	dataHomeId: puddingTeamsHomeId(paths.home),
	...(process.env.PUDDINGTEAMS_RUN_ID ? { runId: process.env.PUDDINGTEAMS_RUN_ID } : {}),
}, providerDeletion, messageOperations, chatKnowledgeIntakes, {
	delegations,
}, nativeInputController);
registerIdentityRoutes(app, localViewerIdentity, paths);
registerLegacyDataDiagnostics(app, paths.state);
registerLogDiagnostics(app, {
	logFile: process.env.PUDDINGTEAMS_LOG_FILE,
	home: paths.home,
	readLogging: async () => (await productSettings.get()).logging,
	recentLog: () => logRing.snapshot(),
	version: process.env.PUDDINGTEAMS_VERSION,
	runId: process.env.PUDDINGTEAMS_RUN_ID,
});
registerWebResearchSettingsRoutes(app, webResearch);
registerCalendarRoutes(app, calendarService.store, () => localViewerIdentity().user.id, calendarService);
registerCalendarProviderRoutes(app, new CalendarProviderRegistry([createFeishuCalendarProvider(feishuConnection)]));
await registerSettingsRoutes(app, defaultCwd, productSettings, workStates, (settings) => {
	store.markAllDirty();
	workspaceExecution.configure({ leaseTimeoutMs: settings.harness.workspaceExecution.leaseTimeoutMs });
}, async (name) => {
	const agent = await teams.getAgent(name);
	return !!agent && !agent.pinned && agent.enabled !== false;
}, {
	logFile: process.env.PUDDINGTEAMS_LOG_FILE,
	// 级别改动无需重启：pino 支持运行时改级，`silent`（开关关闭）同样即时生效。
	onLoggingChange: (logging) => { applyLoggingSettings(app.log, logging); },
});
await registerProvidersRoutes(app, store, providerDeletion);
await registerAgentsRoutes(app, teams, {
	credentials,
	runtime,
	invoker,
	extensions: extensionRegistry,
	sessions: store,
	capabilityStateRoot,
	mcpServers,
	agentCreationStatePath: path.join(paths.state, "agent-creation-operations.json"),
});
registerToolPreviewRoutes(app, teams, { memorySetup, webResearch, mcpServers, catalog });
await registerExtensionsRoutes(app, {
	registry: extensionRegistry,
	teams,
	runtime,
	sessions: store,
	settings: productSettings,
	capabilityStateRoot,
	mcpServers,
	mutationJournal: extensionMutationJournal,
	mcpMutationJournal,
});
registerResourcesRoutes(app);
registerWorkspacesRoutes(app, teams.workspaces, undefined, store);
// Teams 2.0 知识库 M2：绑定注册表 + 采纳账本 + 内容寻址快照库 + 观察服务 + 检索索引 + 接入探测/计划。
registerContactsRoutes(app, contactsProjection);
registerKnowledgeRoutes(app, knowledgeRegistry, {
	viewerIdentity: () => readViewerIdentity(localViewerIdentity, paths),
	memorySetup,
	reviews: reviewStore,
	objects: knowledgeObjects,
	acceptance: knowledgeAcceptance,
	observation: knowledgeObservation,
	searchIndex: knowledgeSearchIndex,
	probes: knowledgeProbes,
	plans: knowledgePlans,
	selections: knowledgeSelections,
	history: knowledgeHistory,
	setInteractionStatus: interactionStatusHandler,
});
// T30/T31 W1：知识库编译生产入口。取消复用 Runtime 的 Delegation 取消机制。
registerWikiRoutes(app, {
	jobs: compileJobs,
	bindings: knowledgeRegistry,
	acceptance: knowledgeAcceptance,
	observation: knowledgeObservation,
	objects: knowledgeObjects,
	teams,
	resolveDriver: (agentId) => invoker.driverFor(agentId),
	attestCompiler: (driver) => extensionRegistry.attestBundledDriver("codex", driver),
	resolveCommand: () => resolveCodexCompileCommand(),
	runCompileJob: async (jobId) => {
		const result = await runtime.runCompileJob(jobId);
		const sync = await syncCandidateBatches({ jobs: compileJobs, reviews: reviewStore });
		if (sync.unavailable.length > 0) app.log.warn(sync, "wiki candidate promotion requires repair");
		return result;
	},
	cancelDelegation: (delegationId, ctx) => runtime.cancel(delegationId, ctx),
	compileRoot: path.join(paths.knowledgeCache, "compile"),
	reviews: reviewStore,
	// T40/T42/T44：真发布挂载点（按 binding 串行，组提交后回写账本并重建索引）。
	publisher: wikiPublisher,
	publications: publishJournal,
	revisions: wikiRevisions,
});
await knowledgeObservation.startAll(knowledgeRegistry, localViewerIdentity().user.id);
registerWikiCuratorRoutes(app, { service: wikiCurator, jobs: curatorJobs, reviews: reviewStore, objects: knowledgeObjects, bindings: knowledgeRegistry, teams, revisions: wikiRevisions, publications: publishJournal });
registerReadLaterRoutes(app, { store: readLaterStore, capture: readLaterCapture, promoter: readLaterPromoter });
app.addHook("onClose", async () => { await readLaterCapture.close(); });
readLaterCapture.start();
await wikiCurator.recover();
await wikiRevisions.recover();
const conversationSnapshots = new ConversationSnapshots(path.join(paths.state, "conversation-snapshots"));
const sessionForks = new SessionForks(teams, store, invoker, conversationSnapshots, new ForkOperations(path.join(paths.state,"fork-operations.json")), [paths.uploads,path.join(paths.state,"large-worker-results"),conversationSnapshots.root]);
await sessionForks.recover();
registerSessionForkRoutes(app,sessionForks);
registerChatNavigationRoutes(app, { teams, sessions: store, statePath: path.join(paths.state, "chat-navigation.json") });
await registerRoomsRoutes(app, store, teams, invoker, workStates, {
	attachmentRoot: paths.uploads,
 snapshotAssetRoot:conversationSnapshots.root,
	uploads,
	productSettings,
	activityStatePath: path.join(paths.state, "room-activity.json"),
	sessionCreationStatePath: path.join(paths.state, "session-creation-operations.json"),
	chatNavigationStatePath: path.join(paths.state, "chat-navigation.json"),
});
await registerInteractionsRoutes(app, runtime, invoker, teams, workStates);
registerArtifactsRoutes(app, artifacts);
registerRuntimeFilesRoutes(app, delegations, workspaceExecution);
registerWorkStateRoutes(app, workStates, teams, store, runtime, productSettings);
registerWorkerProcessRoutes(app, new WorkerProcessService(delegations, teams, paths.workerSessions, delegationTimelines), {
	cancel: (delegationId, signal) => invoker.cancel(delegationId, signal),
	isSessionOwner: (sessionHandle, delegationId) => runtime.isSessionOwnedByDelegation(sessionHandle, delegationId),
	reconcile: async (delegationId) => {
		const record = await invoker.reconcileDelegation(delegationId, async () => {
			await reconcileWorkAndScheduleVerification();
		});
		await reconcileWorkAndScheduleVerification();
		return record;
	},
	takeover: async (delegationId, rationale) => {
		const record = await invoker.confirmObservationLostStopped(delegationId, rationale);
		await reconcileWorkAndScheduleVerification();
		return record;
	},
}, workStates);

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
	clearInterval(goalOutboxTimer);
	clearInterval(admissionExpiryTimer);
	knowledgeObservation.stop();
	await goalOutboxDrain;
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
