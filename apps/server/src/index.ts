import { directConversationHistory } from "./agent-runtime/direct-history.js";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { config } from "./config.js";
import { acquireLease, ensurePaths, puddingTeamsHomeId, resolvePuddingTeamsPaths } from "./paths.js";
import { PiSessionStore } from "./pi-bridge/session-store.js";
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
import { registerResourcesRoutes } from "./routes/resources.js";
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
import { ProductSettingsStore } from "./store/product-settings.js";
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
);
store.setKnowledgeRuntime(knowledgeRuntime);
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
const readLaterPromoter = new ReadLaterPromoter({ store: readLaterStore, capture: readLaterCapture, sources: knowledgeSources, curator: wikiCurator, bindings: knowledgeRegistry, teams });
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
store.setWebResearchExtension(agentId => webResearch.extension(agentId));
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
	return agent.builtinId === "wiki" ? curatedSurface : withReadLater(curatedSurface, localViewerIdentity().user.id, readLaterStore, readLaterCapture);
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
invoker.setReplacementWindowResolver(async (delegation, agent) => {
	const window = await teams.ensureDirectWindow(
		agent.name,
		delegation.workspaceId,
		(reservedId) => store.create(undefined, {
			type: "direct",
			members: [agent.name],
			workspaceId: delegation.workspaceId,
			cwd: delegation.cwdSnapshot,
		}, reservedId),
		{ cwdSnapshot: delegation.cwdSnapshot, requireEnabledMember: true, rollbackSession: (id) => store.remove(id), journalSession: true },
	);
	return window.id;
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
const reconciledOrphans = await runtime.reconcileOrphanedRuns(async (orphan, result) => {
	await reconcileWorkAndScheduleVerification();
	if (!orphan.managerToolCallId) return;
	const errorCode = result.status === "failed" ? result.errorCode : undefined;
	const text = result.status === "completed"
		? `PuddingTeams 启动对账确认 worker「${orphan.agentId}」的远端 Run 已完成，已按原 Delegation 封存 Receipt。`
		: errorCode === "observation_lost"
			? `PuddingTeams 无法继续观察 worker「${orphan.agentId}」的远端 Run；执行效果未知，相关写 scope 已 fence。请先人工对账，禁止直接重试副作用任务。`
			: `PuddingTeams 服务重启，该任务运行中断（${errorCode ?? "server_restart"}）。worker「${orphan.agentId}」的本地执行已终止；交接目录 ${orphan.cwdSnapshot}/.pudding/handoff/${orphan.id} 中可能保留了部分进展。`;
	const wrote = await store.appendToolResultIfPending(orphan.managerSessionId, {
		toolCallId: orphan.managerToolCallId,
		toolName: `agent_${orphan.agentId}__delegate`,
		text,
		details: { status: result.status, ...(errorCode ? { errorCode } : {}), delegationId: orphan.id, executionState: orphan.executionState },
	});
	if (!wrote) {
		await store.sendCustomMessage(
			orphan.managerSessionId,
			{
				customType: "pudding:task_result",
				content: text,
				details: { taskId: orphan.managerToolCallId, worker: orphan.agentId, windowId: orphan.windowId, status: result.status, executionState: orphan.executionState },
			},
			{ triggerTurn: false },
		);
	}
	// A Solo delegation is also visible in the Worker direct window. Startup
	// reconciliation must close that mirror as well; otherwise its durable
	// running card keeps the composer disabled even though the Delegation is
	// already terminal.
	const executionWindow = await teams.getWindow(orphan.windowId);
	if (executionWindow?.activeSession && executionWindow.activeSession !== orphan.managerSessionId) {
		await store.appendCustomMessageIfAbsent(
			executionWindow.activeSession,
			`startup-worker-result:${orphan.id}:${orphan.revision}`,
			{
				customType: "pudding:task_result",
				content: text,
				details: { taskId: orphan.managerToolCallId, delegationId: orphan.id, worker: orphan.agentId, windowId: orphan.windowId, status: result.status, executionState: orphan.executionState },
			},
			{ triggerTurn: false },
		);
	}
});
if (reconciledOrphans > 0) app.log.info({ reconciled: reconciledOrphans }, "reconciled orphaned delegations from previous process");
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
		const owner = await teams.windowForSession(delegation.managerSessionId);
		await store.appendCustomMessageIfAbsent(
			delegation.managerSessionId,
			`admission-expired:${delegation.id}:${delegation.revision}`,
			{
				customType: "pudding:task_result",
				content: `Teams 准入请求已过期，worker「${delegation.agentId}」未启动，任务已取消。`,
				details: { delegationId: delegation.id, worker: delegation.agentId, status: "cancelled", errorCode: "admission_expired", workerStarted: false },
			},
			owner?.type === "direct" ? { triggerTurn: false } : { triggerTurn: true, deliverAs: "followUp" },
		);
	}
	return expired;
}
const expiredAdmissions = await sweepExpiredAdmissions();
if (expiredAdmissions > 0) app.log.info({ expiredAdmissions }, "expired stale Teams admission requests");
const reconciledAdmissions = await runtime.reconcileAdmissionApplications();
if (reconciledAdmissions > 0) app.log.info({ reconciledAdmissions }, "reconciled Teams admission application journals");
async function projectDurableReplacementOutcomes(): Promise<number> {
	let projected = 0;
	const [delegations, interactions] = await Promise.all([runtime.listDelegations(), runtime.listInteractions()]);
	for (const delegation of delegations) {
		if (!delegation.parentDelegationId || !["reported_completed", "reported_failed", "cancelled", "observation_lost"].includes(delegation.executionState)) continue;
		const interaction = interactions.find((item) =>
			item.delegationId === delegation.parentDelegationId
			&& item.source === "platform_policy"
			&& item.decision?.chosenAction === "select_another_worker"
			&& item.application?.replacementDelegationId === delegation.id,
		);
		if (!interaction) continue;
		const owner = await teams.windowForSession(delegation.managerSessionId);
		const executionWindow = await teams.getWindow(delegation.windowId).catch(() => undefined);
		const directSessionId = executionWindow?.activeSession && executionWindow.activeSession !== delegation.managerSessionId
			? executionWindow.activeSession
			: undefined;
		const completed = delegation.executionState === "reported_completed";
		const content = completed
			? delegation.result?.status === "completed" ? delegation.result.content ?? "改派后的 Worker 已完成任务。" : "改派后的 Worker 已完成任务。"
			: delegation.result && "error" in delegation.result ? `改派后的 worker「${delegation.agentId}」执行失败：${delegation.result.error}` : `改派后的 worker「${delegation.agentId}」未完成任务。`;
		await store.appendCustomMessageIfAbsent(
			delegation.managerSessionId,
			`replacement-result:${delegation.id}:${delegation.revision}`,
			{ customType: "pudding:task_result", content, details: { interactionId: interaction.id, delegationId: delegation.id, worker: delegation.agentId, status: completed ? "completed" : "failed", replacement: true } },
			owner?.type === "direct" ? { triggerTurn: false } : { triggerTurn: true, deliverAs: "followUp" },
		);
		if (directSessionId) {
			await store.appendCustomMessageIfAbsent(
				directSessionId,
				`replacement-result:${delegation.id}:${delegation.revision}`,
				{ customType: "pudding:task_result", content, details: { interactionId: interaction.id, delegationId: delegation.id, worker: delegation.agentId, status: completed ? "completed" : "failed", replacement: true } },
				{ triggerTurn: false },
			);
		}
		projected++;
	}
	return projected;
}
const recoveredReplacementResults = await projectDurableReplacementOutcomes();
if (recoveredReplacementResults > 0) app.log.info({ recoveredReplacementResults }, "recovered durable replacement outcomes");
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
const replacementOutcomeTimer = setInterval(() => {
	void projectDurableReplacementOutcomes().catch((error) => app.log.warn({ error }, "failed to project replacement outcomes"));
}, 5_000);
replacementOutcomeTimer.unref();
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
}, providerDeletion, new MessageSubmissionOperations(path.join(paths.state, "message-submission-operations")), chatKnowledgeIntakes);
registerIdentityRoutes(app, localViewerIdentity, paths);
registerWebResearchSettingsRoutes(app, webResearch);
registerCalendarRoutes(app, new CalendarStore(paths.calendarState));
registerCalendarProviderRoutes(app, new CalendarProviderRegistry([createFeishuCalendarProvider(feishuConnection)]));
await registerSettingsRoutes(app, defaultCwd, productSettings, workStates, (settings) => {
	store.markAllDirty();
	workspaceExecution.configure({ leaseTimeoutMs: settings.harness.workspaceExecution.leaseTimeoutMs });
}, async (name) => {
	const agent = await teams.getAgent(name);
	return !!agent && !agent.pinned && agent.enabled !== false;
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
registerContactsRoutes(app, new ContactsProjection({ bindings: knowledgeRegistry, objects: knowledgeObjects, acceptance: knowledgeAcceptance, observation: knowledgeObservation, searchIndex: knowledgeSearchIndex }));
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
await registerRoomsRoutes(app, store, teams, invoker, workStates, {
	attachmentRoot: paths.uploads,
	uploads,
	productSettings,
	activityStatePath: path.join(paths.state, "room-activity.json"),
	sessionCreationStatePath: path.join(paths.state, "session-creation-operations.json"),
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
	clearInterval(replacementOutcomeTimer);
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
