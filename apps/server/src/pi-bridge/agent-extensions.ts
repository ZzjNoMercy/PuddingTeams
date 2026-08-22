import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { agentDisplayName, type TeamsStore, type AgentConfig, type WindowConfig, type WindowType } from "../store/teams.js";
import { WorkStateConflictError, WorkStateOperationConflictError, goalCriterionRefs, type WorkStateStore } from "../store/work-state.js";
import type { AgentInvoker } from "../agent-runtime/invoker.js";
import {
	ScopedAgentInvoker,
	delegateToolName,
	extensionToolName,
	toolSafeId,
	type CapabilityRegistration,
	type ExtensionCatalog,
} from "../agent-runtime/extensions.js";
import type { PiSessionStore } from "./session-store.js";
import type { ArtifactStore } from "../agent-runtime/artifact-store.js";
import type { LargeWorkerResultStore } from "../store/large-worker-result.js";
import type { ProductSettingsStore } from "../store/product-settings.js";

/**
 * Phase 4：manager Session 的 Extension 装配（方案 §3.3）。
 *
 * - core Extension：`search_agent_tools` 工具 + roster 注入（成员名单是窗口
 *   绑定的静态事实，不做成工具，由 before_agent_start 每轮重读并写进 system
 *   prompt，成员/启用变化下一轮即生效）；另含窗口专属 core 工具——solo 的
 *   `create_group_window`（manager 自建群聊并下达首条任务）与 group 的
 *   `invite_to_group`（拉已启用 worker 进组）；
 * - 每个 roster Agent 一个平台生成的 agent-delegation Extension（基础委托工具
 *   `agent_<agentId>__delegate`，内部走 ScopedAgentInvoker → AgentInvoker）；
 * - 专属 Capability Extension 按 enabled binding 装配在基础 Extension 之后；
 * - 工具命名空间与 always/searchable 激活策略见 planManagerTools。
 */

const MAX_RESULT_CHARS = 30_000;

/**
 * How long solo task sync waits for the direct window's manager session to
 * become idle before giving up. sendCustomMessage during streaming degrades
 * to a steer injection (semantics change), so we never force it — 15s covers
 * normal relay runs while keeping the tool result timely; on timeout the
 * result is still returned with `synced: false`.
 */
const SYNC_IDLE_TIMEOUT_MS = 15_000;

export const CORE_TOOL_SEARCH = "search_agent_tools";
export const CORE_TOOL_UPDATE_WORK_STATE = "update_session_work_state";
export const CORE_TOOL_REQUEST_DECISION = "request_human_decision";
export const CORE_TOOL_CREATE_GOAL = "create_session_goal";
export const CORE_TOOL_UPDATE_WORK_PLAN = "update_work_plan";
export const CORE_TOOL_ADVANCE_MANAGER_WORK_ITEM = "advance_manager_work_item";
export const CORE_TOOL_REVIEW_WORK_ITEM = "review_work_item";
export const CORE_TOOL_READ_DELEGATION_RESULT = "read_delegation_result";
/** solo：manager 自建群聊并下达首条任务（房间即群聊 §manager 建房）。 */
export const CORE_TOOL_CREATE_GROUP = "create_group_window";
/** group：拉其他已启用 worker 进本群（成员变化走既有撤权/重建链）。 */
export const CORE_TOOL_INVITE = "invite_to_group";
const GOAL_ACTIVE_TOOLS = [CORE_TOOL_UPDATE_WORK_STATE, CORE_TOOL_REQUEST_DECISION, CORE_TOOL_UPDATE_WORK_PLAN, CORE_TOOL_ADVANCE_MANAGER_WORK_ITEM, CORE_TOOL_REVIEW_WORK_ITEM] as const;
const GOAL_CONTROLLED_TOOLS = [CORE_TOOL_CREATE_GOAL, ...GOAL_ACTIVE_TOOLS] as const;

/** manager Session 的窗口上下文（装配时解析，工具执行期按需重读）。 */
export interface ManagerWindowContext {
	type: WindowType;
	/** 成员的内部 id（AgentConfig.name）；提示词渲染用 displayNames 映射成显示名。 */
	members: string[];
	/** 成员 id → 显示名（装配时快照）；缺省时回退 id 本身。 */
	displayNames?: Record<string, string>;
	prompt?: string;
	workspaceId?: string;
	/** manager 与 worker 必须共享的项目 cwd。 */
	cwd?: string;
}

function truncate(text: string): string {
	if (text.length <= MAX_RESULT_CHARS) return text;
	return `${text.slice(0, MAX_RESULT_CHARS)}\n\n…(输出过长，已截断)`;
}

// ---- 工具集规划（命名空间 + always/searchable 激活策略） ----

export interface ManagedToolPlan {
	/** 本次装配注册的全部受管工具名（core + per-agent）。 */
	managed: Set<string>;
	/** 默认激活的受管工具子集。 */
	active: Set<string>;
	/** 参与装配的 roster Agent（启用 + 窗口成员过滤后）。 */
	agents: AgentConfig[];
}

/**
 * 计算一个窗口上下文的受管工具集（§3.3）：
 * - roster：solo 为全部启用 Agent；direct/group 仅启用的窗口成员；
 * - 命名空间：`agent_<agentId>__delegate`、`agent_<agentId>__<extId>__<tool>`；
 * - 激活：基础委托工具全窗口默认激活（省掉 search 激活轮次）；
 *   capability 扩展工具按绑定策略，always 随 direct 默认激活，
 *   其余预注册但 inactive，由 search_agent_tools 纯加法激活；
 * - roster 本身不进工具集，由 core Extension 的 before_agent_start 注入 prompt。
 */
export async function planManagerTools(
	store: TeamsStore,
	catalog: ExtensionCatalog,
	ctx: ManagerWindowContext | undefined,
): Promise<ManagedToolPlan> {
	// pinned 内置 manager 不是可委托的 worker（§10.5），不进 roster。
	const enabled = (await store.listAgents()).filter((a) => a.enabled !== false && !a.pinned);
	const solo = !ctx || ctx.type === "solo";
	const agents = solo ? enabled : enabled.filter((a) => ctx.members.includes(a.name));
	const managed = new Set<string>([
		CORE_TOOL_SEARCH,
		CORE_TOOL_UPDATE_WORK_STATE,
		CORE_TOOL_REQUEST_DECISION,
		CORE_TOOL_CREATE_GOAL,
		CORE_TOOL_UPDATE_WORK_PLAN,
		CORE_TOOL_ADVANCE_MANAGER_WORK_ITEM,
		CORE_TOOL_REVIEW_WORK_ITEM,
		CORE_TOOL_READ_DELEGATION_RESULT,
		CORE_TOOL_CREATE_GROUP,
		CORE_TOOL_INVITE,
	]);
	const active = new Set<string>([
		CORE_TOOL_SEARCH,
		CORE_TOOL_READ_DELEGATION_RESULT,
	]);
	if (!ctx || ctx.type !== "direct") active.add(CORE_TOOL_CREATE_GOAL);
	// 窗口专属 core 工具：建房仅 solo，拉人仅 group（execute 内还有第二道门禁）。
	if (solo) active.add(CORE_TOOL_CREATE_GROUP);
	if (ctx?.type === "group") active.add(CORE_TOOL_INVITE);
	for (const agent of agents) {
		const delegate = delegateToolName(agent.name);
		managed.add(delegate);
		// 委托工具全窗口默认激活：schema 常驻成本远低于「先 search 激活再调用」
		// 的整轮上下文重发；search 只留给数量不确定的 capability 扩展工具。
		active.add(delegate);
		for (const binding of agent.capabilityExtensions ?? []) {
			if (!binding.enabled) continue;
			const module = catalog.get(binding.extensionId);
			if (!module) continue;
			for (const tool of module.manifest.tools) {
				const name = extensionToolName(agent.name, module.manifest.id, tool.name);
				managed.add(name);
				// 绑定的 activation 覆盖模块声明的默认激活策略（§10）。
				const activation = binding.activation ?? tool.activation;
				if (activation === "always" && ctx?.type === "direct") active.add(name);
			}
		}
	}
	return { managed, active, agents };
}

// ---- 装配 ----

export interface ManagerExtensionDeps {
	store: TeamsStore;
	sessions: PiSessionStore;
	invoker: AgentInvoker;
	catalog: ExtensionCatalog;
	workStates?: WorkStateStore;
	artifacts?: ArtifactStore;
	largeResults?: LargeWorkerResultStore;
	productSettings?: ProductSettingsStore;
	/** 可变绑定：createAgentSession 内部生成 session id，工具执行期惰性读取。 */
	getSessionId: () => string;
	/** 装配时的窗口上下文（描述文案用；执行期一律经 resolveContext 重读）。 */
	ctx: ManagerWindowContext | undefined;
	/** 执行期重读最新窗口上下文（成员变化立即生效）。 */
	resolveContext: () => Promise<ManagerWindowContext | undefined>;
	log?: (msg: string) => void;
}

/** 按 plan 构造具名 extensionFactories：core 在前，per-agent 基础委托随后，专属最后。 */
export function buildManagerExtensionFactories(
	plan: ManagedToolPlan,
	deps: ManagerExtensionDeps,
): InlineExtension[] {
	const factories: InlineExtension[] = [{ name: "pudding-core-roster", factory: coreRosterFactory(deps) }];
	for (const agent of plan.agents) {
		factories.push({
			name: `agent-${toolSafeId(agent.name)}-delegation`,
			factory: agentDelegationFactory(agent, deps),
		});
		for (const binding of agent.capabilityExtensions ?? []) {
			if (!binding.enabled) continue;
			const module = deps.catalog.get(binding.extensionId);
			if (!module) continue;
			factories.push({
				name: `agent-${toolSafeId(agent.name)}-${toolSafeId(module.manifest.id)}`,
				factory: (pi) => {
					const scoped = new ScopedAgentInvoker(agent.name, deps.invoker);
					const registration: CapabilityRegistration = {
						agent: {
							id: agent.name,
							name: agent.name,
							description: agent.description,
							capabilities: agent.capabilities ?? [],
						},
						config: binding.config ?? {},
						invoker: scoped,
						events: {
							// 事件命名空间与工具一致，Extension 不能冒发其他 Agent 的事件。
							publish: (event, payload) =>
								pi.events.emit(`pudding:${toolSafeId(agent.name)}:${toolSafeId(module.manifest.id)}:${event}`, payload),
						},
						registerTool: (tool) =>
							pi.registerTool({
								...tool,
								name: extensionToolName(agent.name, module.manifest.id, tool.name),
							}),
					};
					return module.register(registration);
				},
			});
		}
	}
	return factories;
}

// ---- core Extension（roster prompt 注入 + search_agent_tools） ----

const SearchParams = Type.Object({
	query: Type.String({ description: "搜索关键词（空格分词，逐词匹配工具名或描述，如 worker 名、职责关键词）。" }),
});

const UpdateWorkStateParams = Type.Object({
	goalId: Type.String({ description: "系统提示中当前 Goal 的 goalId；用于阻止旧 Goal 的迟到调用。" }),
	revision: Type.Integer({ minimum: 0, description: "系统提示中当前工作状态的 revision。" }),
	currentBrief: Type.Optional(Type.String({ description: "截至目前已确认的事实、结果与进展摘要。" })),
	waitingOn: Type.Optional(Type.String({ description: "当前具体在等待谁或什么；空字符串表示清除。" })),
	nextAction: Type.Optional(Type.String({ description: "下一步最小可执行动作；空字符串表示清除。" })),
	status: Type.Optional(
		Type.Union([
			Type.Literal("active"),
			Type.Literal("resolved"),
			Type.Literal("cancelled"),
		]),
	),
	artifactIds: Type.Optional(Type.Array(Type.String(), { description: "支撑当前结论的稳定 Artifact ID。" })),
	completionCriteria: Type.Optional(Type.Array(Type.Object({
		criterion: Type.String({ description: "冻结 Goal 完成条件原文，必须逐条原样对应。" }),
		status: Type.Union([Type.Literal("satisfied"), Type.Literal("unsatisfied"), Type.Literal("uncertain")]),
		evidenceRefs: Type.Array(Type.String(), { minItems: 1, description: "至少引用一条消息、WorkItem、Delegation、Artifact 或接口证据。" }),
		explanation: Type.String(),
	}), { description: "manager 自审完成 Goal 时必填；逐条记录条件、证据与结论。" })),
});

const CreateGoalParams = Type.Object({
	goal: Type.String({ description: "用户已经明确表达、需要持续追踪的目标。" }),
	completionCriteria: Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		uniqueItems: true,
		description: "用户已明确表达的完成条件数组；每个元素是一条独立条件，不得合并、拆分或增加新标准。",
	}),
	completionReviewMode: Type.Optional(Type.Union([Type.Literal("manager"), Type.Literal("independent")])),
	activationReason: Type.String({ description: "为何该请求需要持续执行、追踪或多 Worker 协作。" }),
	criteriaOrigin: Type.Union([Type.Literal("user_input"), Type.Literal("manager_derived")]),
	sourceMessageIds: Type.Array(Type.String(), { minItems: 1, description: "目标与条件所依据的用户消息 id。" }),
});

const UpdateWorkPlanParams = Type.Object({
	goalId: Type.String({ description: "系统提示中当前 Goal 的 goalId。" }),
	expectedRevision: Type.Integer({ minimum: 0 }),
	title: Type.Optional(Type.String()),
	upsertItems: Type.Array(Type.Object({
		id: Type.Optional(Type.String()),
		title: Type.String(),
		description: Type.Optional(Type.String()),
		assignedAgentId: Type.Optional(Type.String()),
		dependsOn: Type.Optional(Type.Array(Type.String())),
		acceptanceCriteria: Type.Array(Type.String(), { minItems: 1 }),
		sourceGoalCriterionIndexes: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), {
			uniqueItems: true,
			description: "本 WorkItem 服务的 Goal 完成条件序号，只填写 context 中的 index（从 1 开始）；内部引用由后端生成。",
		})),
	})),
	removeItemIds: Type.Optional(Type.Array(Type.String())),
	cancelItemIds: Type.Optional(Type.Array(Type.String(), { description: "保留审计历史但取消的 WorkItem；活动委托必须先中断，非取消项不能继续依赖它。" })),
	reopenItemIds: Type.Optional(Type.Array(Type.String(), { description: "阻塞原因已解除后，把 blocked WorkItem 重新置为 revision 以便新 attempt。" })),
	reason: Type.String(),
});

const ReviewWorkItemParams = Type.Object({
	goalId: Type.String({ description: "系统提示中当前 Goal 的 goalId。" }),
	workItemId: Type.String(),
	expectedRevision: Type.Integer({ minimum: 0 }),
	verdict: Type.Union([Type.Literal("accepted"), Type.Literal("revision"), Type.Literal("blocked")]),
	summary: Type.String(),
	evidenceRefs: Type.Optional(Type.Array(Type.String())),
});
const AdvanceManagerWorkItemParams = Type.Object({
	goalId: Type.String({ description: "系统提示中当前 Goal 的 goalId。" }),
	workItemId: Type.String({ description: "assignedAgentId=manager 的 WorkItem id。" }),
	expectedRevision: Type.Integer({ minimum: 0 }),
	status: Type.Union([Type.Literal("in_progress"), Type.Literal("submitted")]),
	summary: Type.Optional(Type.String({ description: "submitted 时必填，说明 Manager 已完成的交付。" })),
	evidenceRefs: Type.Optional(Type.Array(Type.String(), { description: "submitted 时引用的消息、Delegation、Artifact 或接口证据。" })),
});
const ReadDelegationResultParams = Type.Object({
	delegationId: Type.String(),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "字符偏移，默认 0。" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 160_000, description: "本次读取字符数；省略时使用 Harness 设置。" })),
});

const RequestDecisionParams = Type.Object({
	goalId: Type.String({ description: "系统提示中当前 Goal 的 goalId。" }),
	revision: Type.Integer({ minimum: 0, description: "系统提示中当前工作状态的 revision。" }),
	question: Type.String({ description: "必须由人类作出的业务决定。" }),
	context: Type.String({ description: "做决定所需的最小充分背景。" }),
	options: Type.Optional(
		Type.Array(
			Type.Object({ id: Type.String(), label: Type.String() }),
			{ description: "互斥的推荐选项；开放问题可省略。" },
		),
	),
	blockedAction: Type.String({ description: "在答案到来前不得执行的动作。" }),
	resumeHint: Type.String({ description: "答案到来后应如何恢复工作。" }),
	authorizationScope: Type.Optional(Type.String({ description: "若决定同时授予权限，精确定义其范围。" })),
});

const CreateGroupParams = Type.Object({
	members: Type.Array(Type.String(), { description: "群聊成员：≥2 个已启用 worker，填内部 id 或显示名（roster 中括号标注的 id 为准）。" }),
	task: Type.String({ description: "下达给房间 manager 的首条整体任务（它会再拆分给成员）。" }),
	name: Type.Optional(Type.String({ description: "群聊名称（可选，留空由首条任务自动生成）。" })),
	prompt: Type.Optional(Type.String({ description: "群聊协作提示词：只给该房间 manager 的分工/交接/汇总规则（可选）。" })),
});

const InviteToGroupParams = Type.Object({
	members: Type.Array(Type.String(), { description: "要拉入本群的已启用 worker（≥1），填内部 id 或显示名。" }),
});

/**
 * 成员引用解析：manager 在 roster 里看到的是显示名，存储与窗口成员用内部
 * id。先按 id 精确命中，再按显示名唯一匹配（大小写不敏感）；多义或未命中
 * 返回 undefined，由调用方报错提示改用 id。
 */
async function resolveWorkerRef(store: TeamsStore, ref: string): Promise<AgentConfig | undefined> {
	const byId = await store.getAgent(ref);
	if (byId) return byId;
	const lower = ref.toLowerCase();
	const matches = (await store.listAgents()).filter((a) => agentDisplayName(a).toLowerCase() === lower);
	return matches.length === 1 ? matches[0] : undefined;
}

/**
 * roster 的 system prompt 段落（每轮由 before_agent_start 重算）。成员名单是
 * 窗口绑定的静态事实，不做成工具让模型多调一轮；执行期重读保证成员/启用
 * 变化下一轮即反映到 prompt，安全性仍由 AgentInvoker 入口校验兜底。
 */
export function rosterPromptSection(plan: ManagedToolPlan, ctx: ManagerWindowContext | undefined): string {
	if (plan.agents.length === 0) {
		return (
			"当前没有可委托的 worker。请先在智能体管理中启用 worker" +
			(ctx && ctx.type !== "solo" ? "，并确认它是本窗口成员。" : "。") +
			"不要承诺派活。"
		);
	}
	const lines = plan.agents.map((a) => {
		const tools = [...plan.managed].filter((n) => n.startsWith(`agent_${toolSafeId(a.name)}__`));
		const identity = a.responsibility?.identity ? `（${a.responsibility.identity}）` : "";
		const caps = a.capabilities?.length ? `｜能力：${a.capabilities.join("、")}` : "";
		const responsibility = a.responsibility
			? [
					`｜责任领域：${a.responsibility.domain}`,
					a.responsibility.owns.length ? `｜负责：${a.responsibility.owns.join("、")}` : "",
					a.responsibility.excludes.length ? `｜不负责：${a.responsibility.excludes.join("、")}` : "",
					a.responsibility.escalateWhen?.length ? `｜升级条件：${a.responsibility.escalateWhen.join("、")}` : "",
				].join("")
			: "";
		const toolList = tools.map((n) => (plan.active.has(n) ? `${n}（已激活）` : n)).join("、");
		const label = agentDisplayName(a);
		// 显示名与内部 id 不同则标注 id：create_group_window / invite_to_group
		// 的 members 以 id 为准，manager 必须能自己完成映射。
		const idNote = label !== a.name ? `（id：${a.name}）` : "";
		return `- ${label}${idNote}${identity}：${a.description || "（无描述）"}${caps}${responsibility}\n  工具：${toolList}`;
	});
	const soloCtx = !ctx || ctx.type === "solo";
	return [
		"当前可委托的 worker（按窗口成员与启用状态每轮刷新）：",
		lines.join("\n"),
		`委托工具默认全部已激活，按 roster 里的工具名直接调用，不要先搜索。标注「已激活」的扩展能力工具同样直接调用；只有未激活的扩展能力工具才先用 ${CORE_TOOL_SEARCH} 按名称激活后再调用。若调用返回工具不存在（Tool ... not found），说明它当前未激活（服务重启后会话重建会重置激活态）：用 ${CORE_TOOL_SEARCH} 激活后重试一次即可，不要当作 worker 不可用。只有搜索不到该 worker 的工具、或激活后调用仍被明确拒绝时，才说明该 worker 已不可用，不要继续重试。`,
		...(soloCtx
			? [
					`只要任务需要两个及以上 worker——包括串行交接（一个 worker 的产出是另一个的输入，如"先查数据再做 PPT"）——就用 ${CORE_TOOL_CREATE_GROUP} 建群聊并把整体任务下达给房间 manager，让 worker 在群里直接交接、用户全程旁观。不要在 solo 里逐个单聊派活、自己搬运中间结果。只有纯单 worker 任务才直接委托该 worker。`,
				]
			: []),
		...(ctx?.type === "group"
			? [`当前协作人手不够时，用 ${CORE_TOOL_INVITE} 把其他已启用 worker 拉进本群（新成员下一轮进入 worker 清单）。`]
			: []),
	].join("\n");
}

function coreRosterFactory(deps: ManagerExtensionDeps): (pi: ExtensionAPI) => void {
	return (pi) => {
		let latestUserSourceIds = new Set<string>();
		// Work state is request-scoped rather than a sticky system-prompt
		// override. pi's sendCustomMessage(triggerTurn) starts an agent turn
		// without emitting before_agent_start; keeping Goal state only in that
		// hook therefore leaves automated Decision/delegation follow-ups with
		// the previous turn's state. The context event runs before every model
		// request, including custom-message turns, and its injected message is
		// not persisted into the conversation history.
		pi.on("context", async (event) => {
			// display:false custom entries are UI/audit projections persisted in the
			// Session JSONL (for example pudding:task_assign while a delegate tool is
			// still running). pi's default convertToLlm maps every custom message to a
			// user message, even hidden ones. Keeping such an entry between an
			// assistant toolCall and its toolResult breaks OpenAI-compatible provider
			// ordering (`role=tool` must immediately answer `tool_calls`). Hidden
			// projections are not model facts; authoritative Goal state is injected
			// below on every request, so remove them before provider conversion.
			const modelMessages = event.messages.filter((message) =>
				message.role !== "custom" || !("display" in message) || message.display !== false,
			);
			const workState = deps.workStates ? await deps.workStates.getActive(deps.getSessionId()) : undefined;
			const latestGoal = workState ?? (deps.workStates ? await deps.workStates.get(deps.getSessionId()) : undefined);
			const contextWindow = await deps.resolveContext();
			const goalActivation = contextWindow && deps.productSettings
				? (await deps.productSettings.get()).harness.goalActivation
				: undefined;
			const activeWithoutGoalControls = pi.getActiveTools().filter((name) => !(GOAL_CONTROLLED_TOOLS as readonly string[]).includes(name));
			const controlled = workState
				? GOAL_ACTIVE_TOOLS
				: contextWindow && contextWindow.type !== "direct" && (goalActivation?.[contextWindow.type] ?? "manager_explicit") === "manager_explicit"
					? [CORE_TOOL_CREATE_GOAL]
					: [];
			pi.setActiveTools([...new Set([...activeWithoutGoalControls, ...controlled])]);
			const sourceMessageIds = modelMessages
				.filter((message) => message.role === "user")
				.slice(-5)
				.map((message, index) => {
					const timestamp = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : index;
					return `user:${timestamp}`;
				});
			latestUserSourceIds = new Set(sourceMessageIds);
			const planLines = workState?.plan
				? Object.values(workState.plan.items)
					.filter((item) => item.status !== "accepted" && item.status !== "cancelled")
					.slice(0, 24)
					.map((item) => {
						const submission = item.submissions.at(-1);
						return `- ${item.id} [${item.status}] dependsOn=${item.dependsOn.join(",") || "无"} active=${item.activeDelegationId ?? "无"}${submission?.summary ? `｜最近提交：${truncate(submission.summary).slice(0, 500)}` : ""}`;
					})
				: [];
			const workSection = workState
				? [
						"[PuddingTeams 当前工作上下文]",
						"当前 Session 是一个需要持续负责的 Goal。manager 是唯一可更新当前工作状态的责任主体。",
						"先判断本轮用户意图是否属于当前 Goal：相关追问、补充或约束变更才继续当前 Goal；无关的一次性问答正常回答且不得改写 Goal；若用户提出另一个需要持续执行的目标，不得静默覆盖当前 Goal，当前 Goal 未结束时先请用户选择继续、结束或另开 Session。Goal 终态后可在同一 Session 创建新的 Goal，旧 Goal 保留为历史。",
						`目标：${workState.goal}`,
						`完成边界：${workState.completionBoundary}`,
						`完成复核：${workState.reviewMode === "independent" ? `独立 reviewer${workState.reviewerModel ? `（${workState.reviewerModel}）` : "（自动选择模型）"}` : "manager 自审"}`,
						`状态：${workState.status}/${workState.execution.status}｜goalId：${workState.goalId}｜revision：${workState.revision}｜epoch：${workState.execution.epoch}`,
						`当前摘要：${workState.currentBrief || "（尚未记录）"}`,
						`等待：${workState.waitingOn || "无"}`,
						`下一步：${workState.nextAction || "尚未记录"}`,
						`冻结 Goal 完成条件（update_work_plan 的 sourceGoalCriterionIndexes 只填写 index）：\n${JSON.stringify(goalCriterionRefs(workState).map((item, index) => ({ index: index + 1, criterion: item.text })))}`,
						...(workState.plan ? [`Manager WorkPlan（覆盖 Goal r${workState.plan.coveredGoalRevision}${workState.plan.needsReconcile ? "，必须先对账当前 Goal 契约" : ""}）：\n${planLines.join("\n") || "（全部已验收）"}`] : ["Manager WorkPlan：尚未建立。多步骤、依赖或多 Worker 任务先调用 update_work_plan。"]),
						`Goal 状态写操作必须串行：一次只调用一个 ${CORE_TOOL_UPDATE_WORK_PLAN}/${CORE_TOOL_ADVANCE_MANAGER_WORK_ITEM}/${CORE_TOOL_REVIEW_WORK_ITEM}/${CORE_TOOL_UPDATE_WORK_STATE}，拿到新 revision 后再调用下一个，禁止在同一轮并行提交多个写操作。`,
						`assignedAgentId=manager 的 WorkItem 开始时调用 ${CORE_TOOL_ADVANCE_MANAGER_WORK_ITEM} 标记 in_progress，完成交付后再标记 submitted，然后调用 ${CORE_TOOL_REVIEW_WORK_ITEM} 验收；不得删除 Manager 工作项绕过提交和验收。worker 委托完成只代表 submitted，同样必须明确验收。`,
						`只有完成边界已满足且证据充分时才提交 status=resolved。manager 自审必须在 completionCriteria 中逐条原样回填全部冻结条件、证据和 satisfied 结论；独立复核 Goal 会启动隔离 reviewer。上游限流由 Runtime 在同一 Delegation/Session 内冷却续跑，不要因 429 立即重新委托。遇到产品/业务取舍时调用 ${CORE_TOOL_REQUEST_DECISION}。`,
					].join("\n")
				: contextWindow && goalActivation?.[contextWindow.type] === "manager_explicit"
					? `[PuddingTeams 当前工作上下文]\n当前 Session 没有正在进行的 Goal。${latestGoal ? `最近结束的 Goal（${latestGoal.status}）：${latestGoal.goal}\n最终摘要：${latestGoal.currentBrief || "（尚未记录）"}\n用户若在追问其结果，基于同一 Session 上下文正常回答；若提出新的持续工作，创建新的 Goal，不得改写历史 Goal。` : ""}仅当用户已明确给出需要持续执行的结果与可判定完成边界时调用 ${CORE_TOOL_CREATE_GOAL}；问候、闲聊、一次性解释不创建，边界含糊${goalActivation.confirmWhenAmbiguous ? "先询问" : "时保持普通会话，除非用户补充明确边界"}。创建时 sourceMessageIds 只能从这些最近用户消息引用中选择：${sourceMessageIds.join("、") || "（当前请求无可引用消息）"}。不要调用其他 Goal 工具。`
					: `[PuddingTeams 当前工作上下文]\n当前 Session 尚未设置 Goal，且 Harness 的 ${contextWindow?.type ?? "unknown"} 策略不允许 Manager 自动创建。保持普通会话；用户可通过 /goal/UI 显式创建（disabled 时界面请求也会被服务端拒绝）。不要调用 Goal 工具。`;
			return {
				messages: [
					...modelMessages,
					{
						role: "custom" as const,
						customType: "pudding:work_state_context",
						content: workSection,
						display: false,
						timestamp: Date.now(),
					},
				],
			};
		});

		pi.on("before_agent_start", async (event) => {
			const ctx = await deps.resolveContext();
			const plan = await planManagerTools(deps.store, deps.catalog, ctx);
			return { systemPrompt: `${event.systemPrompt}\n\n${rosterPromptSection(plan, ctx)}` };
		});

		pi.registerTool({
			name: CORE_TOOL_SEARCH,
			label: "Search Agent Tools",
			description:
				"按关键词搜索当前窗口内 Agent 的工具，并纯加法激活匹配项（setActiveTools）。找到后要先用返回的工具名发起调用。",
			promptGuidelines: [
				`委托工具默认已激活，直接按 roster 里的工具名调用；只有未激活的扩展能力工具才先用 ${CORE_TOOL_SEARCH} 搜索并激活，再发起调用。`,
			],
			parameters: SearchParams,
			async execute(_toolCallId, params: Static<typeof SearchParams>) {
				// 成员/启用状态每次重读：被禁用的 Agent 工具不会被重新激活（§3.3 撤权）。
				const ctx = await deps.resolveContext();
				const plan = await planManagerTools(deps.store, deps.catalog, ctx);
				const query = params.query.toLowerCase();
				// 匹配全量受管工具（含已激活的）：模型搜一个已激活的工具名时，
				// 要明确告诉它"已激活可直接调用"，而不是"没有匹配"把它绕晕。
				// 空格分词 AND：模型常搜「worker 名 + 职责关键词」（如
				// "puddingclaw 联网检索"），整串子串匹配必然落空；逐词命中工具名
				// 或描述（描述含责任边界/负责清单）才符合它的搜索习惯。
				const tokens = query.split(/\s+/).filter(Boolean);
				const matches = pi
					.getAllTools()
					.filter((t) => {
						if (!plan.managed.has(t.name)) return false;
						const haystack = `${t.name}\n${t.description}`.toLowerCase();
						return tokens.every((tok) => haystack.includes(tok));
					})
					.map((t) => t.name);
				if (matches.length === 0) {
					return {
						content: [{ type: "text", text: `没有匹配「${params.query}」的工具。当前窗口可用的 worker 与工具见系统提示中的 worker 清单（标注「已激活」的可直接调用）。` }],
						details: { matches: [], added: [] },
					};
				}
				const active = pi.getActiveTools();
				const added = matches.filter((n) => !active.includes(n));
				// 纯加法加载（§3.3）：不得在同一调用里移除现有工具。
				if (added.length > 0) pi.setActiveTools([...new Set([...active, ...added])]);
				return {
					content: [
						{
							type: "text",
							text:
								added.length > 0
									? `已激活工具：${added.join("、")}。现在可以直接调用它们。`
									: `匹配的工具已是激活状态，无需再激活，可直接调用：${matches.join("、")}。`,
						},
					],
					details: { matches, added },
				};
			},
		});

		pi.registerTool({
			name: CORE_TOOL_READ_DELEGATION_RESULT,
			label: "Read Delegation Result",
			description: "分页读取当前 manager Session 所拥有 Delegation 的完整归一化结果。超长结果不会只剩预览。",
			parameters: ReadDelegationResultParams,
			async execute(_toolCallId, params: Static<typeof ReadDelegationResultParams>) {
				const delegations = await deps.invoker.delegationsForManagerSession(deps.getSessionId());
				const delegation = delegations.find((item) => item.id === params.delegationId);
				if (!delegation) throw new Error("delegationId 不属于当前 manager Session");
				const offset = params.offset ?? 0;
				const configured = deps.productSettings ? (await deps.productSettings.get()).harness.workerResults.readChunkTokens * 4 : 32_000;
				const limit = params.limit ?? configured;
				let result: { content: string; offset: number; nextOffset?: number; totalChars: number };
				try {
					if (!deps.largeResults) throw new Error("large result store disabled");
					result = await deps.largeResults.read(params.delegationId, offset, limit);
				} catch {
					const content = delegation.result?.status === "completed" ? delegation.result.content : "";
					if (!content) throw new Error("该 Delegation 没有可读取的 completed 结果");
					const chunk = content.slice(offset, offset + limit);
					const next = offset + chunk.length;
					result = { content: chunk, offset, ...(next < content.length ? { nextOffset: next } : {}), totalChars: content.length };
				}
				return {
					content: [{ type: "text", text: result.content + (result.nextOffset === undefined ? "\n\n（已到结果末尾）" : `\n\n（nextOffset=${result.nextOffset}，totalChars=${result.totalChars}）`) }],
					details: { delegationId: params.delegationId, ...result },
				};
			},
		});

		pi.registerTool({
			name: CORE_TOOL_CREATE_GOAL,
			label: "Create Session Goal",
			description: "把目标明确、需要持续执行或多 Worker 协作的请求显式设为 Goal。只能规范化用户已表达的完成条件；含糊时先询问。",
			parameters: CreateGoalParams,
			async execute(toolCallId, params: Static<typeof CreateGoalParams>) {
				if (!deps.workStates) throw new Error("Session Work State 未启用");
				const sessionId = deps.getSessionId();
				const ctx = await deps.resolveContext();
				if (!ctx || ctx.type === "direct") throw new Error("direct Session 只能由用户通过 /goal 创建 Goal");
				const activation = deps.productSettings ? (await deps.productSettings.get()).harness.goalActivation[ctx.type] : "manager_explicit";
				if (activation !== "manager_explicit") throw new Error(`当前 Harness goalActivation.${ctx.type}=${activation}，Manager 无权自动创建 Goal`);
				const invalidSources = params.sourceMessageIds.filter((id) => !latestUserSourceIds.has(id));
				if (invalidSources.length) throw new Error(`sourceMessageIds 不是当前上下文中的真实用户消息引用：${invalidSources.join("、")}`);
				const completionCriteria = params.completionCriteria.map((criterion) => criterion.trim());
				if (completionCriteria.some((criterion) => !criterion)) throw new Error("completionCriteria 不能包含空条件");
				const state = await deps.workStates.create({
					sessionId,
					goal: params.goal,
					completionBoundary: completionCriteria.join("\n"),
					reviewMode: params.completionReviewMode,
					participantAgentIds: ctx.members,
					contractProvenance: {
						criteriaOrigin: params.criteriaOrigin,
						sourceMessageIds: params.sourceMessageIds,
						...(params.criteriaOrigin === "manager_derived" ? { authoredByAgentId: "manager" } : {}),
					},
					operationId: toolCallId,
				});
				const active = pi.getActiveTools().filter((name) => !(GOAL_CONTROLLED_TOOLS as readonly string[]).includes(name));
				pi.setActiveTools([...new Set([...active, ...GOAL_ACTIVE_TOOLS])]);
				return {
					content: [{ type: "text", text: `已创建 Session Goal（goalId ${state.goalId}，revision ${state.revision}，epoch ${state.execution.epoch}）。后续多步骤工作先建立 WorkPlan。` }],
					details: { workState: state, activationReason: params.activationReason },
				};
			},
		});

		pi.registerTool({
			name: CORE_TOOL_UPDATE_WORK_PLAN,
			label: "Update Work Plan",
			description: "创建或更新当前 Goal 的 WorkItem DAG。验收条件只能从冻结 Goal 条件、步骤产物和下游依赖派生。",
			parameters: UpdateWorkPlanParams,
			async execute(toolCallId, params: Static<typeof UpdateWorkPlanParams>) {
				if (!deps.workStates) throw new Error("Session Work State 未启用");
				const sessionId = deps.getSessionId();
				const current = await deps.workStates.getActive(sessionId);
				if (!current || current.goalId !== params.goalId) throw new Error("当前 Goal 已变化，请重新读取目标状态后再更新 WorkPlan");
				const criterionRefs = goalCriterionRefs(current);
				const upsertItems = params.upsertItems.map((item) => {
					const { sourceGoalCriterionIndexes = [], ...workItem } = item;
					const sourceGoalCriteria = sourceGoalCriterionIndexes.map((index) => {
						const criterion = criterionRefs[index - 1];
						if (!criterion) throw new Error(`Goal 只有 ${criterionRefs.length} 条完成条件，不能引用第 ${index} 条`);
						return criterion.id;
					});
					return { ...workItem, dependsOn: workItem.dependsOn ?? [], sourceGoalCriteria };
				});
				const state = await deps.workStates.updatePlan(
					sessionId,
					params.expectedRevision,
					{
						title: params.title,
						upsertItems,
						removeItemIds: params.removeItemIds,
						cancelItemIds: params.cancelItemIds,
						reopenItemIds: params.reopenItemIds,
						reason: params.reason,
					},
					toolCallId,
					undefined,
					params.goalId,
				);
				return { content: [{ type: "text", text: `WorkPlan 已更新（${Object.keys(state.plan?.items ?? {}).length} 项，revision ${state.revision}）。` }], details: { workState: state } };
			},
		});

		pi.registerTool({
			name: CORE_TOOL_ADVANCE_MANAGER_WORK_ITEM,
			label: "Advance Manager Work Item",
			description: "推进 Manager 自己负责的 WorkItem：开始时置为 in_progress，交付完成后生成正式 Submission。不能用于 worker 工作项。",
			parameters: AdvanceManagerWorkItemParams,
			async execute(toolCallId, params: Static<typeof AdvanceManagerWorkItemParams>) {
				if (!deps.workStates) throw new Error("Session Work State 未启用");
				const state = await deps.workStates.advanceManagerWorkItem(
					deps.getSessionId(), params.workItemId, params.expectedRevision,
					{ status: params.status, summary: params.summary, evidenceRefs: params.evidenceRefs },
					toolCallId, undefined, params.goalId,
				);
				return { content: [{ type: "text", text: params.status === "in_progress" ? `Manager 已开始 WorkItem ${params.workItemId}（revision ${state.revision}）。` : `Manager 已提交 WorkItem ${params.workItemId}，现在可以验收（revision ${state.revision}）。` }], details: { workState: state } };
			},
		});

		pi.registerTool({
			name: CORE_TOOL_REVIEW_WORK_ITEM,
			label: "Review Work Item",
			description: "验收最新 Submission。accepted 才会解锁依赖；revision/blocked 不会完成 Goal。",
			parameters: ReviewWorkItemParams,
			async execute(toolCallId, params: Static<typeof ReviewWorkItemParams>) {
				if (!deps.workStates) throw new Error("Session Work State 未启用");
				const state = await deps.workStates.reviewWorkItem(
					deps.getSessionId(), params.workItemId, params.expectedRevision,
					{ verdict: params.verdict, summary: params.summary, evidenceRefs: params.evidenceRefs },
					toolCallId,
					undefined,
					params.goalId,
				);
				return { content: [{ type: "text", text: `WorkItem ${params.workItemId} 已标记为 ${params.verdict}（revision ${state.revision}）。` }], details: { workState: state } };
			},
		});

		pi.registerTool({
			name: CORE_TOOL_UPDATE_WORK_STATE,
			label: "Update Session Work State",
			description: "更新当前 Goal 的权威工作摘要、等待项、下一步和完成状态；使用 revision 做乐观并发控制。",
			parameters: UpdateWorkStateParams,
			async execute(toolCallId, params: Static<typeof UpdateWorkStateParams>) {
				if (!deps.workStates) throw new Error("Session Work State 未启用");
				try {
					const { goalId, revision, completionCriteria, ...patch } = params;
					if (patch.status === "resolved") {
						const sessionId = deps.getSessionId();
						const current = await deps.workStates.getActive(sessionId);
						if (!current) throw new Error("Session Goal 不存在");
						if (current.goalId !== goalId) throw new Error("当前 Goal 已变化，请重新读取目标状态后再提交。");
						if (current.revision !== revision) throw new WorkStateConflictError(current);
						const delegations = (await deps.invoker.delegationsForManagerSession(sessionId)).filter((item) => item.goalId === current.goalId);
						const active = delegations.filter((item) => item.status === "running" || item.status === "waiting_input");
						if (active.length > 0) throw new Error(`仍有 ${active.length} 个委托正在执行或等待输入，不能完成 Goal`);
						const pendingDecisions = (await deps.workStates.listDecisions(sessionId, current.goalId)).filter((item) => item.status === "pending");
						if (pendingDecisions.length > 0) throw new Error(`仍有 ${pendingDecisions.length} 个待回答的人类决策，不能完成 Goal`);

						if (current.reviewMode === "independent") {
							const currentBrief = patch.currentBrief?.trim() || current.currentBrief;
							if (!currentBrief) throw new Error("提交独立复核前必须填写最终 currentBrief");
							const artifactIds = patch.artifactIds ?? current.artifactIds;
							const artifacts = deps.artifacts
								? (await Promise.all(artifactIds.map((id) => deps.artifacts!.get(id))))
								: [];
							const missingArtifactIds = artifactIds.filter((_id, index) => !artifacts[index]);
							if (missingArtifactIds.length > 0) throw new Error(`引用了不存在的 Artifact：${missingArtifactIds.join("、")}`);
							const review = await deps.sessions.reviewGoalCompletion(
								sessionId,
								{
									goal: current.goal,
									completionBoundary: current.completionBoundary,
									goalRevision: current.goalRevision,
									currentBrief,
									delegations: delegations.map((item) => ({
										id: item.id,
										agentId: item.agentId,
										status: item.status,
										intent: item.intent,
										expectedOutcome: item.expectedOutcome,
										completionBoundary: item.completionBoundary,
										result: item.result ? truncate(JSON.stringify(item.result)) : undefined,
									})),
									artifactIds,
									artifacts: artifacts.filter((item) => item !== undefined).map((item) => ({
										id: item.id,
										name: item.name,
										kind: item.kind,
										size: item.size,
										contentHash: item.contentHash,
										producer: item.producer,
										delegationId: item.delegationId,
									})),
									humanDecisions: (await deps.workStates.listDecisions(sessionId, current.goalId))
										.filter((item) => item.status === "answered")
										.map((item) => ({ id: item.id, question: item.question, answer: item.answer, authorizationScope: item.grantedAuthorizationScope })),
									managerEvidence: [],
								},
								current.reviewerModel,
							);
							const state = await deps.workStates.applyCompletionReview(sessionId, revision, {
								currentBrief,
								artifactIds: patch.artifactIds,
								review,
							}, `completion-review:${toolCallId}`, current.execution.epoch, goalId);
							const text = review.verdict === "satisfied"
								? `独立复核通过，Goal 已完成（revision ${state.revision}）。`
								: review.verdict === "needs_human"
									? `独立复核需要人类确认，Goal 保持 active。请根据复核结果调用 ${CORE_TOOL_REQUEST_DECISION}。`
									: `独立复核未通过，Goal 保持 active。缺口：${review.gaps.join("；") || "见逐项复核结果"}`;
							return { content: [{ type: "text", text }], details: { workState: state, completionReview: review } as Record<string, unknown> };
						}
						if (!completionCriteria) throw new Error("manager 自审完成 Goal 时必须逐条填写 completionCriteria");
						const state = await deps.workStates.applyManagerCompletion(sessionId, revision, {
							currentBrief: patch.currentBrief?.trim() || current.currentBrief,
							artifactIds: patch.artifactIds,
							criteria: completionCriteria,
						}, `manager-completion:${toolCallId}`, current.execution.epoch, goalId);
						return { content: [{ type: "text", text: `Manager 已逐项复核全部完成条件，Goal 已完成（revision ${state.revision}）。` }], details: { workState: state, completionReview: state.completionReviews.at(-1) } as Record<string, unknown> };
					}
					if (completionCriteria) throw new Error("completionCriteria 仅在 status=resolved 的 manager 自审中使用");
					const state = await deps.workStates.update(deps.getSessionId(), revision, patch, toolCallId, undefined, goalId);
					return {
						content: [{ type: "text", text: `当前工作已更新（${state.status}，revision ${state.revision}）。` }],
						details: { workState: state } as Record<string, unknown>,
					};
				} catch (err) {
					if (err instanceof WorkStateConflictError) {
						throw new Error(`当前工作已被更新，请按 revision ${err.current.revision} 的最新状态重新判断后再提交。`);
					}
					throw err;
				}
			},
		});

		pi.registerTool({
			name: CORE_TOOL_REQUEST_DECISION,
			label: "Request Human Decision",
			description: "创建业务级人类决策请求并暂停当前 Goal；它不替代 Connector 的 permission/confirmation 审批。",
			parameters: RequestDecisionParams,
			async execute(toolCallId, params: Static<typeof RequestDecisionParams>) {
				if (!deps.workStates) throw new Error("Session Work State 未启用");
				const sessionId = deps.getSessionId();
				const decision = await deps.workStates.createDecision({
					sessionId,
					requestedBy: "manager",
					question: params.question,
					context: params.context,
					options: params.options,
					blockedAction: params.blockedAction,
					resumeHint: params.resumeHint,
					authorizationScope: params.authorizationScope,
				}, toolCallId, params.revision, params.goalId);
				return {
					content: [{ type: "text", text: `已创建人类决策请求：${decision.question}。等待回答，不要执行被阻塞动作。` }],
					details: { decision },
				};
			},
		});

		pi.registerTool({
			name: CORE_TOOL_CREATE_GROUP,
			label: "Create Group Window",
			description:
				"创建多 worker 群聊房间，并把任务作为首条消息直接下达给房间 manager 开跑。需要拆分、并行、交接、裁决的多 worker 协作时使用；单 worker 任务请直接用该 worker 的 delegate 工具。仅 solo 对话可用。",
			parameters: CreateGroupParams,
			async execute(_toolCallId, params: Static<typeof CreateGroupParams>) {
				// 门禁双保险（激活策略已限定 solo；无窗口的 Session 不能建房）。
				const ctx = await deps.resolveContext();
				if (!ctx) throw new Error("当前 manager Session 不属于任何窗口，不能建群聊");
				if (ctx.type !== "solo") throw new Error(`${CORE_TOOL_CREATE_GROUP} 仅 solo 对话可用`);
				const refs = [...new Set(params.members.map((m) => m.trim()).filter(Boolean))];
				if (refs.length < 2) throw new Error("群聊至少需要 2 个 worker");
				const memberAgents: AgentConfig[] = [];
				for (const ref of refs) {
					const agent = await resolveWorkerRef(deps.store, ref);
					if (!agent || agent.pinned || agent.enabled === false) {
						throw new Error(`worker「${ref}」不存在、是内置 manager 或已被禁用，不能入群（members 请使用 roster 中括号标注的内部 id）`);
					}
					if (memberAgents.some((a) => a.name === agent.name)) {
						throw new Error(`worker「${ref}」与其他成员重复，不能入群`);
					}
					memberAgents.push(agent);
				}
				const members = memberAgents.map((a) => a.name);
				const memberLabels = memberAgents.map((a) => agentDisplayName(a));
				// 与 rooms.ts 建房链路一致：先建 manager Session，再落窗口记录。
				const owner = await deps.store.windowForSession(deps.getSessionId());
				const cwd = ctx.cwd ?? (owner ? await deps.store.workspaceFor(owner.id) : undefined);
				if (!cwd) throw new Error("无法解析当前窗口的运行目录，不能建群聊");
				const created = await deps.sessions.create(undefined, {
					type: "group",
					members,
					prompt: params.prompt,
					workspaceId: ctx.workspaceId,
					cwd,
				});
				const window = await deps.store.createWindow({
					type: "group",
					members,
					workspaceId: ctx.workspaceId,
					cwdSnapshot: cwd,
					name: params.name,
					prompt: params.prompt,
					sessionId: created.id,
				});
				// fire-and-forget 开跑（chat.ts 首发消息同款）：房间 manager 在自己
				// 窗口里干活，本工具不等执行结果；标题异步生成。
				void deps.sessions
					.open(created.id)
					.then((session) => session.prompt(params.task))
					.catch((err: unknown) =>
						deps.log?.(`create_group_window 首发任务失败: ${err instanceof Error ? err.message : String(err)}`),
					);
				void deps.sessions.generateSessionTitle(created.id, params.task).catch(() => undefined);
				const displayName = window.name ?? memberLabels.join("、");
				return {
					content: [
						{
							type: "text",
							text: `已创建群聊「${displayName}」（成员：${memberLabels.join("、")}），任务已下达，房间 manager 开始执行。用户可在左侧群聊区查看进度；如需追加指令，让用户直接在群聊窗口里发言。`,
						},
					],
					details: { windowId: window.id, members, ...(window.name ? { name: window.name } : {}), roomJump: true },
				};
			},
		});

		pi.registerTool({
			name: CORE_TOOL_INVITE,
			label: "Invite To Group",
			description:
				"把其他已启用 worker 拉进当前群聊。成员变化下一轮进入 worker 清单，其委托工具在会话装配刷新后可用。仅群聊窗口可用。",
			parameters: InviteToGroupParams,
			async execute(_toolCallId, params: Static<typeof InviteToGroupParams>) {
				const ctx = await deps.resolveContext();
				if (ctx?.type !== "group") throw new Error(`${CORE_TOOL_INVITE} 仅在群聊窗口可用`);
				const window = await deps.store.windowForSession(deps.getSessionId());
				if (!window || window.type !== "group") throw new Error("当前 Session 不属于群聊窗口");
				const requested = [...new Set(params.members.map((m) => m.trim()).filter(Boolean))];
				if (requested.length === 0) throw new Error("至少填写 1 个要拉入的 worker");
				const added: string[] = [];
				const addedLabels: string[] = [];
				const skipped: string[] = [];
				for (const ref of requested) {
					const agent = await resolveWorkerRef(deps.store, ref);
					if (!agent || agent.pinned || agent.enabled === false) {
						throw new Error(`worker「${ref}」不存在、是内置 manager 或已被禁用，不能入群（members 请使用 roster 中括号标注的内部 id）`);
					}
					if (window.members.includes(agent.name) || added.includes(agent.name)) {
						skipped.push(agentDisplayName(agent));
						continue;
					}
					added.push(agent.name);
					addedLabels.push(agentDisplayName(agent));
				}
				if (added.length === 0) {
					return {
						content: [{ type: "text", text: `${skipped.join("、")} 已在本群，无需重复拉人。` }],
						details: { windowId: window.id, members: window.members, added, skipped },
					};
				}
				// updateWindow 触发 emitChange → 撤权/空闲重建链（与 UI 改成员一致）。
				const updated = await deps.store.updateWindow(window.id, { members: [...window.members, ...added] });
				return {
					content: [
						{
							type: "text",
							text: `已把 ${addedLabels.join("、")} 拉进群聊${skipped.length ? `（${skipped.join("、")} 已在群内，跳过）` : ""}。新成员将进入 worker 清单，其委托工具在会话装配刷新后可用。`,
						},
					],
					details: { windowId: window.id, members: updated.members, added, skipped },
				};
			},
		});
	};
}

// ---- per-agent 基础 delegation Extension ----

const DelegateParams = Type.Object(
	{
		task: Type.String({ description: "委托给该 worker 的任务。" }),
		workItemId: Type.Optional(Type.String({ description: "当前 Goal WorkPlan 中要推进的 WorkItem id。" })),
		parentDelegationId: Type.Optional(
			Type.String({ description: "若这是接力/追问，填写上一次委托返回文本中给出的 delegationId。" }),
		),
		handoffKind: Type.Optional(
			Type.Union([Type.Literal("request"), Type.Literal("followup")], {
				description: "request=新的有返回义务的子任务；followup=沿 parentDelegationId 继续。",
			}),
		),
		intent: Type.Optional(Type.String({ description: "本次委托为何是实现 Session Goal 的必要步骤。" })),
		expectedOutcome: Type.Optional(Type.String({ description: "期望 worker 返回的可验证结果。" })),
		evidenceRequirements: Type.Optional(Type.Array(Type.String(), { description: "结果必须附带的证据。" })),
		completionBoundary: Type.Optional(Type.String({ description: "本次子任务何时算完成。" })),
		session: Type.Optional(
			Type.Union([Type.Literal("new"), Type.Literal("continue")], {
				description:
					'"continue"（默认）续接该窗口中该 worker 的会话；任务与现有会话无关时传 "new" 新开会话。',
			}),
		),
	},
	{ description: "把任务委托给这个 worker 并返回最终结果。" },
);

type DelegateInput = Static<typeof DelegateParams>;

/**
 * solo 派活的单聊解析（用户拍板「复用并原地切项目」）：同一 worker 优先
 * 只有一个单聊。当前项目有 exact 窗口直接用；否则找该 worker 的任一单聊，
 * 无进行中任务时原地切换到 solo 当前项目（switchWorkspaceInPlace 会取消
 * 窗口内活 Run，所以忙时绝不切换）；忙或切换失败则按项目新建兜底。
 */
async function resolveDirectWindowForDelegation(
	deps: ManagerExtensionDeps,
	agentName: string,
	workspaceId: string | undefined,
	cwd: string,
): Promise<WindowConfig> {
	const exact = await deps.store.findDirectWindow(agentName, workspaceId, cwd);
	if (exact) return exact;
	const candidate = (await deps.store.listWindows()).find((w) => w.type === "direct" && w.members[0] === agentName);
	if (candidate && (await deps.invoker.activeDelegations(candidate.id)).length === 0) {
		try {
			const switched = await deps.invoker.switchWorkspaceInPlace(
				candidate.id,
				workspaceId,
				(fresh, nextCwd) =>
					deps.sessions.create(undefined, {
						type: fresh.type,
						members: fresh.members,
						prompt: fresh.prompt,
						workspaceId,
						cwd: nextCwd,
					}),
				(id) => deps.sessions.remove(id),
			);
			return switched.window;
		} catch {
			// 切换失败（目录失效等）走新建兜底，不阻断派活。
		}
	}
	return deps.store.ensureDirectWindow(
		agentName,
		workspaceId,
		() => deps.sessions.create(undefined, { type: "direct", members: [agentName], workspaceId, cwd }),
		{ cwdSnapshot: cwd },
	);
}

/**
 * 平台生成的基础 agent-delegation Extension（§10.2）：每个 roster Agent 一个，
 * 只注册稳定的委托工具 `agent_<agentId>__delegate`。工具绑定 agentId，参数里
 * 没有 agent 字段，无法改投其他 Agent；启用状态与成员关系由 AgentInvoker
 * 入口二次校验。
 */
function agentDelegationFactory(agent: AgentConfig, deps: ManagerExtensionDeps): (pi: ExtensionAPI) => void {
	const solo = !deps.ctx || deps.ctx.type === "solo";
	let soloSummary = "";

	/** solo 摘要：该 worker 单聊窗口的现有会话，供 session: "new"|"continue" 选择。 */
	const refreshSoloSummary = async (): Promise<void> => {
		if (!solo) return;
		try {
			const workspaceId = deps.ctx?.workspaceId;
			// 与 resolveDirectWindowForDelegation 的复用策略一致：先看当前项目
			// exact 窗口，否则该 worker 的任一单聊（派活时会原地切到当前项目）。
			const exact = await deps.store.findDirectWindow(agent.name, workspaceId, deps.ctx?.cwd);
			const reused = exact
				? undefined
				: (await deps.store.listWindows()).find((w) => w.type === "direct" && w.members[0] === agent.name);
			const direct = exact ?? reused;
			let windowInfo = "单聊：无（首次派活时自动创建）";
			if (direct) {
				const byId = new Map((await deps.sessions.list()).map((s) => [s.id, s]));
				const infos = direct.sessions.map((id) => byId.get(id)).filter((s): s is NonNullable<typeof s> => Boolean(s));
				const suffix = reused ? "（绑定了其他项目，派活时自动切换到当前项目）" : "";
				windowInfo = infos.length
					? `单聊现有会话${suffix}：${infos
							.slice(0, 3)
							.map(
								(s) =>
									`「${s.firstMessage || "新对话"}」（最近活跃 ${s.modifiedAt.slice(0, 16).replace("T", " ")}）`,
							)
							.join("；")}`
					: `单聊：已有窗口${suffix}，暂无历史会话`;
			}
			soloSummary = windowInfo;
		} catch {
			// Best-effort: a stale/empty summary never blocks delegation.
		}
	};
	void refreshSoloSummary();

	const baseDescription = [
		`把任务委托给 worker「${agentDisplayName(agent)}」（${agent.responsibility?.identity ? `${agent.responsibility.identity}；` : ""}${agent.description || "无描述"}）并返回最终结果。`,
		agent.responsibility
			? `责任领域：${agent.responsibility.domain}；负责：${agent.responsibility.owns.join("、") || "未细分"}；不负责：${agent.responsibility.excludes.join("、") || "未声明"}。`
			: "",
		"当用户的请求属于这个 worker 的职责时使用，不要自己动手执行。",
		"当 worker 需要审批才能继续时，结果会报告一个待处理的审批；不要重试任务——审批卡会处理它。",
	].filter(Boolean).join(" ");

	return (pi) => {
		pi.registerTool({
			name: delegateToolName(agent.name),
			label: `${agentDisplayName(agent)} · 委托`,
			get description() {
				if (!solo) return baseDescription;
				return [
					baseDescription,
					"当前是 solo 对话：派活会自动路由到该 worker 的单聊窗口（没有则自动创建），并把任务与结果同步到该单聊的消息流。",
					'参数 `session`：默认 "continue" 续接该 worker 单聊中正在进行的会话；任务与现有会话无关时传 "new"。',
					`该 worker 的单聊现状：${soloSummary || "（摘要加载中）"}`,
				].join(" ");
			},
			parameters: DelegateParams,
			async execute(toolCallId, params: DelegateInput, signal, onUpdate) {
				const sessionId = deps.getSessionId();
				const goal = deps.workStates ? await deps.workStates.getActive(sessionId) : undefined;
				if (params.workItemId && !goal?.plan?.items[params.workItemId]) throw new Error("workItemId 不属于当前 Goal WorkPlan");
				if (goal?.plan && !params.workItemId) throw new Error("当前 Goal 已有 WorkPlan，委托必须绑定 workItemId");
				const workItem = params.workItemId ? goal?.plan?.items[params.workItemId] : undefined;
				if (workItem && !["ready", "revision", "in_progress"].includes(workItem.status)) {
					throw new Error(`WorkItem ${workItem.id} 当前状态 ${workItem.status}，依赖尚未验收或正在等待处理`);
				}
				if (goal && (!params.intent?.trim() || !params.expectedOutcome?.trim() || !params.completionBoundary?.trim())) {
					throw new Error("Goal Session 的委托必须声明 intent、expectedOutcome 与 completionBoundary，避免无因果派活。");
				}
				if (params.handoffKind === "followup" && !params.parentDelegationId) {
					throw new Error("followup 委托必须填写 parentDelegationId");
				}
				// 撤权前置校验（执行期重读，AgentInvoker 入口还有第二道）：
				// 禁用/删除的 Agent 不能发起新委托，也不为它自动创建单聊窗口。
				const fresh = await deps.store.getAgent(agent.name);
				if (!fresh || fresh.enabled === false) {
					throw new Error(`worker「${agent.name}」不存在或已被禁用，委托被拒绝。`);
				}
				const window = await deps.store.windowForSession(sessionId);
				// Sessions outside any window behave like solo: the task routes to
				// the worker's direct window (auto-created if missing).
				const isSoloContext = !window || window.type === "solo";
				if (!isSoloContext && !window.members.includes(agent.name)) {
					throw new Error(`worker「${agent.name}」不在当前窗口的成员中，委托被拒绝。`);
				}

				// §4.1: solo tasks run inside the worker's direct window, so the
				// worker session continuity lives where the user can see it.
				let targetWindow = window;
				if (isSoloContext) {
					if (!window) throw new Error("当前 manager Session 不属于任何窗口，不能派活");
					const workspaceId = window.workspaceId;
					const cwd = await deps.store.workspaceFor(window.id);
					targetWindow = await resolveDirectWindowForDelegation(deps, agent.name, workspaceId, cwd);
				}

				deps.log?.(`${delegateToolName(agent.name)}: ${sessionId} → ${agent.name} (task len ${params.task.length})`);

				const taskId = toolCallId || randomUUID();
				// §4.4 派活即镜像：delegate 阻塞期间 direct 窗口先出现 running 态
				// 指派卡；结果/审批卡由 syncToWindow 在 outcome 后补写。
				if (isSoloContext && targetWindow) {
					await announceToWindow(deps, targetWindow, taskId, agent.name, params.task);
				}
				let mirroredDelegation = false;
				let mirroredProcess = false;
				let projectedRunning = false;
				const scoped = new ScopedAgentInvoker(agent.name, deps.invoker);
				const result = await scoped.delegate({
					message: params.task,
					windowId: targetWindow?.id ?? "",
					managerSessionId: sessionId,
					managerToolCallId: taskId,
					goalId: goal?.goalId,
					workPlanId: goal?.plan?.id,
					workItemId: params.workItemId,
					attempt: workItem ? workItem.delegationIds.length + 1 : undefined,
					goalEpoch: goal?.execution.epoch,
					parentDelegationId: params.parentDelegationId,
					handoffKind: params.handoffKind ?? (params.parentDelegationId ? "followup" : "request"),
					intent: params.intent,
					expectedOutcome: params.expectedOutcome,
					evidenceRequirements: params.evidenceRequirements,
					completionBoundary: params.completionBoundary,
					mode: params.session === "new" ? "run" : "continue",
					signal,
					onUpdate: (content, details) => {
						const updateDetails = details as { delegationId?: string; sessionHandle?: string } | undefined;
						if (!projectedRunning && params.workItemId && goal && updateDetails?.delegationId && deps.workStates) {
							projectedRunning = true;
							void deps.workStates.noteDelegation(sessionId, {
								goalId: goal.goalId,
								workItemId: params.workItemId,
								delegationId: updateDetails.delegationId,
								delegationStatus: "running",
								goalEpoch: goal.execution.epoch,
							}, `delegation-created:${updateDetails.delegationId}`).catch(() => undefined);
						}
						const processView = true;
						onUpdate?.({ content: [{ type: "text", text: content }], details: { processView, ...(goal ? { goalId: goal.goalId } : {}), ...updateDetails } });
						if (!targetWindow || !updateDetails?.delegationId) return;
						const addsProcess = processView && Boolean(updateDetails.sessionHandle);
						if (mirroredDelegation && (!addsProcess || mirroredProcess)) return;
						mirroredDelegation = true;
						if (addsProcess) mirroredProcess = true;
						const runningDetails = {
							delegationId: updateDetails.delegationId,
							...(goal ? { goalId: goal.goalId } : {}),
							...(params.workItemId ? { workItemId: params.workItemId } : {}),
							...(updateDetails.sessionHandle ? { sessionHandle: updateDetails.sessionHandle } : {}),
							processView,
						};
						void announceToWindow(
							deps,
							targetWindow,
							taskId,
							agent.name,
							params.task,
							runningDetails,
							isSoloContext ? "solo" : "group",
						);
						if (isSoloContext) {
							// The visible mirror belongs to the worker direct window, but the
							// originating solo manager tool card also needs durable process
							// metadata so a session switch does not erase its drawer entry.
							void appendManagerRunningProjection(
								deps,
								sessionId,
								targetWindow.id,
								taskId,
								agent.name,
								params.task,
								runningDetails,
							);
						}
					},
				});

				const meta: Record<string, unknown> = {
					worker: result.details.worker ?? agent.name,
					status: result.status,
					delegationId: result.delegationId,
					interactionId: result.interactionId,
					// 执行过程入口：pi 展示完整会话，spawn worker 展示追加式时间线。
					sessionHandle: result.sessionHandle,
					processView: true,
					goalId: goal?.goalId,
					workPlanId: goal?.plan?.id,
					workItemId: params.workItemId,
					goalEpoch: goal?.execution.epoch,
				};
				const picked = result.details;
				if (params.workItemId && goal && result.delegationId && deps.workStates) {
					const boundaryStatus = result.status === "needs_input" || result.status === "conflict"
						? "waiting_input"
						: result.status === "completed"
							? "completed"
							: "failed";
					try {
						await deps.workStates.noteDelegation(sessionId, {
							goalId: goal.goalId,
							workItemId: params.workItemId,
							delegationId: result.delegationId,
							delegationStatus: boundaryStatus,
							goalEpoch: goal.execution.epoch,
							artifactIds: (picked as { artifacts?: Array<{ id?: string }> }).artifacts?.map((item) => item.id).filter((id): id is string => Boolean(id)) ?? [],
							summary: result.status === "completed" ? truncate(result.content).slice(0, 2_000) : undefined,
						}, `delegation-boundary:${result.delegationId}:${boundaryStatus}`);
					} catch (error) {
						// An interrupt advances the Goal epoch. A late worker callback remains in
						// Delegation history, but must neither mutate the new epoch nor turn an
						// otherwise valid worker result into a manager tool failure.
						if (!(error instanceof WorkStateOperationConflictError) || error.code !== "stale_goal_state") throw error;
						deps.log?.(`ignored stale Goal epoch callback for Delegation ${result.delegationId}`);
					}
				}

				// §4.4: mirror into the direct window's message stream. Best-effort —
				// a busy target session yields synced:false instead of blocking.
				const sync = async (
					status: string,
					text: string,
					interaction?: { interactionId: string; revision?: number; requests?: unknown[] },
					extraDetails?: Record<string, unknown>,
				): Promise<boolean> => {
					if (!isSoloContext || !targetWindow) return false;
					const ok = await syncToWindow(
						deps,
						targetWindow,
						taskId,
						agent.name,
						status,
						text,
						interaction,
						{
							delegationId: result.delegationId,
							sessionHandle: result.sessionHandle,
							processView: true,
							...extraDetails,
						},
					);
					void refreshSoloSummary();
					return ok;
				};
				const soloMeta = async (
					status: string,
					text: string,
					interaction?: { interactionId: string; revision?: number; requests?: unknown[] },
					extraDetails?: Record<string, unknown>,
				) => {
					if (!isSoloContext || !targetWindow) return {};
					const synced = await sync(status, text, interaction, extraDetails);
					return { taskId, windowId: targetWindow.id, synced };
				};
				const syncNote = (synced: boolean | undefined) =>
					synced === undefined
						? ""
						: synced
							? `\n\n（已同步到与 ${agent.name} 的单聊）`
							: `\n\n（未能同步到与 ${agent.name} 的单聊：对方会话忙碌）`;

				// HITL（§6.2）：needs_input 时保存待处理 Interaction，返回“等待审批”
				// 结构，manager 本轮正常结束，绝不指导它重跑任务。
				if (result.status === "needs_input" || result.status === "conflict") {
					const text = result.content;
					const interaction =
						result.interactionId && result.status === "needs_input"
							? {
									interactionId: result.interactionId,
									revision: (picked as { revision?: number }).revision,
									requests: (picked as { requests?: unknown[] }).requests,
								}
							: undefined;
					const extra = await soloMeta(result.status, text, interaction);
					return {
						content: [{ type: "text", text: `${text}${syncNote(extra.synced as boolean | undefined)}` }],
						details: { ...meta, ...picked, ...extra },
					};
				}

				if (result.status === "failed") {
					const text = result.content;
					await soloMeta("failed", text);
					throw new Error(text);
				}

				const projection = result.delegationId && deps.largeResults && deps.productSettings
					? await deps.largeResults.project(result.delegationId, result.content, (await deps.productSettings.get()).harness.workerResults)
					: {
							text: truncate(result.content),
							offloaded: result.content.length > MAX_RESULT_CHARS,
							originalChars: result.content.length,
							estimatedTokens: Math.ceil(result.content.length / 4),
							delegationId: result.delegationId ?? "",
							estimation: "ceil(chars/4)" as const,
						};
				const text = projection.text;
				// §15.6 接力：交付物清单附在结果文本末尾（传路径不传内容），
				// details 里已有结构化 artifacts（invoker 投影），供 manager 在
				// 接力任务文本中按路径引用。
				const artifacts = (picked as { artifacts?: Array<{ name: string; path: string }> }).artifacts;
				const artifactNote = artifacts?.length
					? `\n\n交付物（可在接力任务中按路径引用）：\n${artifacts.map((a) => `- ${a.name}：${a.path}`).join("\n")}`
					: "";
				// delegationId 必须进正文：details 只给 UI，模型看不到，没有它
				// followup 只能瞎填（实测填过工具名）。
				const delegationNote = result.delegationId
					? `\n\n（delegationId：${result.delegationId}——需要该 worker 接力/追问时，用 handoffKind="followup" 并把它填进 parentDelegationId）`
					: "";
				const extra = await soloMeta(result.status, projection.text, undefined, picked.usage ? { usage: picked.usage } : undefined);
				return {
					content: [{ type: "text", text: `${text}${artifactNote}${delegationNote}${syncNote(extra.synced as boolean | undefined)}` }],
					details: { ...meta, ...picked, ...extra, largeResult: projection },
				};
			},
		});
	};
}

/** Mirror the running-state assign card before the delegate blocks (§4.4). */
async function announceToWindow(
	deps: Pick<ManagerExtensionDeps, "store" | "sessions">,
	window: WindowConfig,
	taskId: string,
	workerName: string,
	task: string,
	extraDetails?: Record<string, unknown>,
	from: "solo" | "group" = "solo",
): Promise<void> {
	try {
		const fresh = await deps.store.getWindow(window.id);
		const activeSession = fresh?.activeSession ?? window.activeSession;
		const message = {
			customType: "pudding:task_assign",
			content: task,
			details: { taskId, worker: workerName, windowId: window.id, from, status: "running", ...(extraDetails ?? {}) },
		};
		if (from === "group") {
			// The group manager is currently blocked inside this delegate tool.
			// Persist a hidden projection immediately; the web reducer folds it
			// back into the original tool card after refresh/WS reconnect.
			await deps.sessions.appendCustomMessageProjection(activeSession, message);
		} else {
			await deps.sessions.sendCustomMessage(activeSession, message, { triggerTurn: false });
		}
		// 全新窗口的 session 文件可能还没落盘，先把 running 卡刷进去。
		await deps.sessions.ensureSessionFile(activeSession);
	} catch {
		// best-effort：镜像失败不影响派活
	}
}

/** Persist the solo manager's own running delegate projection without adding a second card. */
async function appendManagerRunningProjection(
	deps: Pick<ManagerExtensionDeps, "sessions">,
	managerSessionId: string,
	targetWindowId: string,
	taskId: string,
	workerName: string,
	task: string,
	extraDetails: Record<string, unknown>,
): Promise<void> {
	try {
		await deps.sessions.appendCustomMessageProjection(managerSessionId, {
			customType: "pudding:task_assign",
			content: task,
			details: {
				taskId,
				worker: workerName,
				windowId: targetWindowId,
				from: "solo",
				status: "running",
				...extraDetails,
			},
		});
	} catch {
		// Recovery metadata is best-effort and must never fail the worker run.
	}
}

/** Mirror the outcome (result / approval card) into the direct window's message stream (§4.4). */
async function syncToWindow(
	deps: Pick<ManagerExtensionDeps, "store" | "sessions">,
	window: WindowConfig,
	taskId: string,
	workerName: string,
	status: string,
	resultText: string,
	interaction?: { interactionId: string; revision?: number; requests?: unknown[] },
	/** 额外 details（如本任务 token 消耗 usage），并入结果卡。 */
	extraDetails?: Record<string, unknown>,
): Promise<boolean> {
	try {
		// Re-read the window: the active session may have moved since the
		// delegation started.
		const fresh = await deps.store.getWindow(window.id);
		const activeSession = fresh?.activeSession ?? window.activeSession;
		const target = await deps.sessions.open(activeSession);
		if (!target.isIdle) {
			await Promise.race([
				target.waitForIdle(),
				new Promise<void>((_resolve, reject) =>
					setTimeout(() => reject(new Error("waitForIdle timeout")), SYNC_IDLE_TIMEOUT_MS),
				),
			]);
		}
		if (!target.isIdle) return false;
		// SDK _persist writes nothing until the first assistant message
		// exists, so on a freshly auto-created window the sync would stay
		// memory-only (lost on restart, and the fileless session makes
		// ensureWindowAlive mint replacements). Flush the session file first
		// so the cards below land on disk.
		await deps.sessions.ensureSessionFile(activeSession);
		if (interaction) {
			// §6.5：等待审批时，把安全投影的审批卡镜像进对方单聊窗口，用户可在
			// 该窗口直接允许/拒绝（H2：409「去处理」跳转过去后可操作）。
			await target.sendCustomMessage(
				{
					customType: "pudding:interaction_required",
					content: resultText,
					display: true,
					details: {
						taskId,
						worker: workerName,
						windowId: window.id,
						interactionId: interaction.interactionId,
						delegationId: typeof extraDetails?.delegationId === "string" ? extraDetails.delegationId : taskId,
						status: "pending",
						revision: interaction.revision,
						requests: interaction.requests,
					},
				},
				{ triggerTurn: false },
			);
			return true;
		}
		await target.sendCustomMessage(
			{
				customType: "pudding:task_result",
				content: resultText,
				display: true,
				details: { taskId, worker: workerName, status, windowId: window.id, ...(extraDetails ?? {}) },
			},
			{ triggerTurn: false },
		);
		return true;
	} catch {
		return false;
	}
}
