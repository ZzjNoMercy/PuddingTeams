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
import { LargeWorkerResultStore } from "./store/large-worker-result.js";
import { WorkStateStore } from "./store/work-state.js";
import { registerWorkStateRoutes } from "./routes/work-state.js";
import { registerWorkerProcessRoutes } from "./routes/worker-process.js";
import { WorkerProcessService } from "./agent-runtime/worker-process.js";
import { DelegationTimelineStore } from "./agent-runtime/delegation-timeline-store.js";
import { WorkspaceExecutionCoordinator } from "./agent-runtime/workspace-execution.js";
import { UploadStore } from "./store/uploads.js";
import { configureSharedModelRuntime } from "./pi-bridge/model-runtime.js";
import { registerWebStatic } from "./web-static.js";

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
// Provider key 与 pi CLI 解耦（§10.6）：平台凭证落到 <home>/secrets/auth.json，
// 不读写 pi 全局 agentDir 的 auth.json。必须先于任何 sharedModelRuntime 使用。
configureSharedModelRuntime({ authPath: path.join(paths.secrets, "auth.json") });
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
const runtime: AgentRuntime = new AgentRuntime(
	delegations,
	interactionSecrets,
	(agentId) => invoker.driverFor(agentId),
	{ ttlMs: 24 * 60 * 60 * 1000 },
	artifacts,
	delegationTimelines,
	workspaceExecution,
);
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
);
invoker.setManagerSender((managerSessionId, message, options) =>
	store.sendCustomMessage(managerSessionId, message, options),
);
invoker.setDurableManagerSender((managerSessionId, eventId, message, options) =>
	store.appendCustomMessageIfAbsent(managerSessionId, eventId, message, options).then(() => undefined),
);
invoker.setDelegationStateObserver(async () => {
	await workStates.reconcileDelegations(await runtime.listDelegations());
});
invoker.setReplacementWindowResolver(async (delegation, agent) => {
	const window = await teams.ensureDirectWindow(
		agent.name,
		delegation.workspaceId,
		() => store.create(undefined, {
			type: "direct",
			members: [agent.name],
			workspaceId: delegation.workspaceId,
			cwd: delegation.cwdSnapshot,
		}),
		{ cwdSnapshot: delegation.cwdSnapshot },
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
const reconciledOrphans = await runtime.reconcileOrphanedRuns(async (orphan, result) => {
	await workStates.reconcileDelegations(await runtime.listDelegations());
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
});
if (reconciledOrphans > 0) app.log.info({ reconciled: reconciledOrphans }, "reconciled orphaned delegations from previous process");
async function sweepExpiredAdmissions(): Promise<number> {
	const before = (await runtime.listInteractions())
		.filter((item) => item.source === "platform_policy" && item.status === "pending")
		.map((item) => item.delegationId);
	const expired = await runtime.expireAdmissionRequests();
	if (expired === 0) return 0;
	const delegations = await runtime.listDelegations();
	await workStates.reconcileDelegations(delegations);
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
const goalRecoverySettings = (await productSettings.get()).harness.goalRecovery;
for (const state of await workStates.listActive()) {
	if (state.execution.status !== "interrupted") continue;
	const owner = await teams.windowForSession(state.sessionId);
	if (!owner || owner.type === "direct" || goalRecoverySettings.mode !== "safe_auto") continue;
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
			if (event.kind === "goal_changed") {
				await store.appendCustomMessageProjectionIfAbsent(event.sessionId, event.id, {
					customType: "pudding:work_plan_update",
					content: "Goal 或 WorkPlan 权威状态已更新，请重新读取 work-state。",
					details: { goalId: event.goalId, ...event.payload },
				});
				await workStates.markOutboxDelivered(event.id);
				continue;
			}
			const owner = await teams.windowForSession(event.sessionId);
			const current = await workStates.getActive(event.sessionId);
			const belongsToCurrentGoal = current?.goalId === event.goalId;
			const triggerTurn = belongsToCurrentGoal && (event.kind === "decision_answered" || (event.kind === "goal_recovery" && owner?.type !== "direct"));
			const content = event.kind === "decision_answered"
				? "Human 已回答业务决策，请从同一 Goal 的安全点继续。"
				: event.kind === "goal_recovery"
					? "PuddingTeams 已完成重启对账。请保留已验收 WorkItem，从最近安全点创建新的 Delegation attempt；不要把旧 Run 当作仍在运行。"
					: "Goal 已暂停；历史 Delegation 保留为审计事实，等待安全恢复。";
			await store.appendCustomMessageIfAbsent(
				event.sessionId,
				event.id,
				{ customType: event.kind === "goal_recovery" ? "pudding:goal_recovery" : event.kind === "goal_interrupted" ? "pudding:goal_interrupted" : "pudding:decision_answered", content, details: { goalId: event.goalId, ...event.payload } },
				{ triggerTurn, deliverAs: triggerTurn ? "followUp" : undefined },
			);
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
await scheduleGoalOutboxDrain();
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
await registerChatRoutes(app, store, teams, workStates, uploads, invoker, {
	dataHomeId: puddingTeamsHomeId(paths.home),
});
registerIdentityRoutes(app);
await registerSettingsRoutes(app, defaultCwd, productSettings, workStates, (settings) => {
	store.markAllDirty();
	workspaceExecution.configure({ leaseTimeoutMs: settings.harness.workspaceExecution.leaseTimeoutMs });
});
await registerProvidersRoutes(app, store);
await registerAgentsRoutes(app, teams, {
	credentials,
	runtime,
	invoker,
	extensions: extensionRegistry,
	sessions: store,
	capabilityStateRoot,
});
await registerExtensionsRoutes(app, {
	registry: extensionRegistry,
	teams,
	runtime,
	sessions: store,
	settings: productSettings,
	capabilityStateRoot,
});
registerResourcesRoutes(app);
registerWorkspacesRoutes(app, teams.workspaces, undefined, store);
await registerRoomsRoutes(app, store, teams, invoker, workStates, {
	attachmentRoot: paths.uploads,
	productSettings,
});
await registerInteractionsRoutes(app, runtime, invoker, teams, workStates);
registerArtifactsRoutes(app, artifacts);
registerWorkStateRoutes(app, workStates, teams, store, runtime, productSettings);
registerWorkerProcessRoutes(app, new WorkerProcessService(delegations, teams, paths.workerSessions, delegationTimelines), {
	cancel: (delegationId, signal) => invoker.cancel(delegationId, signal),
	reconcile: async (delegationId) => {
		const record = await invoker.reconcileDelegation(delegationId, async () => {
			await workStates.reconcileDelegations(await runtime.listDelegations());
		});
		await workStates.reconcileDelegations(await runtime.listDelegations());
		return record;
	},
	takeover: async (delegationId, rationale) => {
		const record = await invoker.confirmObservationLostStopped(delegationId, rationale);
		await workStates.reconcileDelegations(await runtime.listDelegations());
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
