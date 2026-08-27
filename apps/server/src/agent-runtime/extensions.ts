import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import semver from "semver";
import { agentDisplayName, type AgentConfig } from "../store/teams.js";
import type { AgentInvoker, AgentInvokeResult } from "./invoker.js";
import type { DriverCapabilities } from "./types.js";

/**
 * Phase 4：Extension 拆分（方案 §3.2/§3.3/§10.2，决策 13/14/15）。
 *
 * 数据结构与运行时通道：
 * - ExtensionManifest / ExtensionCatalog：Capability 模块的描述与目录。
 *   Phase 5 起增加 §10 的两类安装包 manifest（Connector/Capability，禁止
 *   混包）、AgentConnectorBinding / AgentCapabilityBinding（替换旧的
 *   AgentExtensionBinding）；安装与持久化目录见 extension-registry.ts；
 * - ScopedAgentInvoker：Extension 唯一可用的调用通道，创建时绑定 agentId，
 *   调用参数里没有 agent 字段，Extension 无法改投其他 Agent；
 * - 工具命名空间：agent_<agentId>__delegate、
 *   agent_<agentId>__<extensionId>__<toolName>，用不可变 ID，不用展示名。
 */

export type ExtensionKind = "connector" | "capability";

/** 工具激活策略（§3.3）：always 随窗口默认激活；searchable 预注册但 inactive。 */
export type ToolActivation = "always" | "searchable";

export interface ExtensionToolContribution {
	/** 裸工具名（命名空间前缀由平台统一加）。 */
	name: string;
	activation: ToolActivation;
	description?: string;
}

export interface ExtensionManifest {
	/** 不可变 Extension ID。 */
	id: string;
	kind: ExtensionKind;
	/** 展示名（界面友好标签，不进工具名）。 */
	name: string;
	version: string;
	description?: string;
	tools: ExtensionToolContribution[];
}

/**
 * Agent 的 Connector 绑定（§10）：指向已安装 Connector Extension 的
 * contribution。secret 明文只进 CredentialsStore，这里只存 secretRefs。
 */
export interface AgentConnectorBinding {
	/** 安装的扩展包 id。 */
	extensionId: string;
	/** ConnectorContribution.id。 */
	connectorId: string;
	/** 本 Agent 实例实际使用的 transport；必须属于 Connector supportedTransports。 */
	transport: import("./types.js").DriverTransport;
	config: Record<string, unknown>;
	secretRefs?: Record<string, string>;
	versionPin?: string;
}

/** Agent 的 Capability Extension 绑定（§10，替换 Phase 4 的 AgentExtensionBinding）。 */
export interface AgentCapabilityBinding {
	/** binding 实例 id。 */
	id: string;
	/** 安装的扩展包 id。 */
	extensionId: string;
	/** CapabilityContribution.id。 */
	capabilityId: string;
	enabled: boolean;
	config: Record<string, unknown>;
	secretRefs?: Record<string, string>;
	/** 覆盖模块声明的工具激活策略；缺省用模块 manifest 的 tool.activation。 */
	activation?: "always" | "searchable";
	versionPin?: string;
}

/** 给 Extension 的 Agent 安全投影（不含凭证、token、invoke 细节）。 */
export interface AgentSummary {
	id: string;
	name: string;
	description: string;
	capabilities: string[];
}

/** Extension 只能发命名空间内的可观测事件（§3.2）。 */
export interface ExtensionEventPublisher {
	publish(event: string, payload?: unknown): void;
}

export interface AgentExtensionContext<TConfig = unknown> {
	agent: Readonly<AgentSummary>;
	config: Readonly<TConfig>;
	/** 已绑定 agentId 的调用通道，Extension 不能改投其他 Agent。 */
	invoker: ScopedAgentInvoker;
	events: ExtensionEventPublisher;
}

/**
 * Capability Extension 的注册上下文：模块给裸工具定义，平台在 registerTool
 * 里统一加 agent_<agentId>__<extensionId>__ 前缀，命名空间无法被绕过。
 */
export interface CapabilityRegistration extends AgentExtensionContext {
	registerTool(tool: ToolDefinition): void;
}

export interface CapabilityRuntimeIssue {
	code: string;
	message: string;
	fixAction?: string;
}

/**
 * Capability 对目标 Pi Session 的资源贡献。业务 Capability 仍不能注册
 * Driver/Transport；这里只允许追加 Skill 路径和为该 Session 的 bash 子进程
 * 合成环境变量。宿主用 binding 级 stateDir 隔离 CLI 自管的认证状态。
 */
export interface CapabilitySessionRuntime {
	skillPaths?: string[];
	env?: NodeJS.ProcessEnv;
	details?: Record<string, unknown>;
	issues?: CapabilityRuntimeIssue[];
}

export interface CapabilityRuntimeContext {
	agent: Readonly<AgentSummary & { pinned: boolean; connectorId?: string }>;
	binding: Readonly<AgentCapabilityBinding>;
	config: Readonly<Record<string, unknown>>;
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** `<PUDDINGTEAMS_HOME>/secrets/capabilities/<extension>/<agent>/<binding>`。 */
	stateDir: string;
	/** 同一 Capability 所有绑定共享的运行依赖目录，不存放 binding 独占凭据。 */
	sharedStateDir: string;
}

export interface CapabilityRuntimeContribution {
	resolveSession(ctx: CapabilityRuntimeContext): CapabilitySessionRuntime | Promise<CapabilitySessionRuntime>;
	probe?(ctx: CapabilityRuntimeContext):
		| (CapabilitySessionRuntime & { authenticated?: boolean | "unknown" })
		| Promise<CapabilitySessionRuntime & { authenticated?: boolean | "unknown" }>;
}

export type ExtensionConnectionState = "connected" | "disconnected" | "unavailable" | "error";

/**
 * 扩展页“连接状态”的只读投影。不得包含 token、secret、认证目录或可复用的
 * 上游身份标识；不同插件只需返回用户可读的账号与诊断摘要。
 */
export interface ExtensionConnectionStatus {
	id: string;
	name: string;
	description?: string;
	state: ExtensionConnectionState;
	version?: string;
	accountName?: string;
	identity?: string;
	message?: string;
	actions?: ExtensionConnectionAction[];
	checkedAt: string;
}

export interface ExtensionConnectionAction {
	id: string;
	label: string;
	description?: string;
	confirmation?: {
		title: string;
		description: string;
		confirmLabel: string;
	};
}

export interface ExtensionConnectionContext {
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** `<PUDDINGTEAMS_HOME>/secrets/capabilities/<extension>/shared`。 */
	stateDir: string;
}

/** Capability Extension 运行时模块（当前进程内加载，隔离 Host 后迁入 Broker）。 */
export interface CapabilityExtensionModule {
	manifest: ExtensionManifest;
	register(ctx: CapabilityRegistration): void | Promise<void>;
	/** 可选：给绑定目标自身的 Pi Session 追加 Skills/CLI 环境与动态 probe。 */
	runtime?: CapabilityRuntimeContribution;
	/** 可选：向扩展页贡献只读连接状态；不依赖 Agent binding。 */
	listConnections?(ctx: ExtensionConnectionContext): ExtensionConnectionStatus[] | Promise<ExtensionConnectionStatus[]>;
	/** 可选：执行连接卡声明的显式动作；探测本身不得隐式调用。 */
	runConnectionAction?(
		connectionId: string,
		actionId: string,
		ctx: ExtensionConnectionContext,
	): void | Promise<void>;
}

/**
 * ExtensionCatalog：已装载 Capability Extension 的目录。Connector 扩展走
 * DriverRegistry（Phase 1），不在本目录；agent-delegation 基础 Extension 是
 * Runtime 生成的投影（§10.2），也不在目录里。
 */
export class ExtensionCatalog {
	private readonly modules = new Map<string, CapabilityExtensionModule>();

	register(module: CapabilityExtensionModule): void {
		if (module.manifest.kind !== "capability") {
			throw new Error(`extension "${module.manifest.id}": only capability modules join the pi catalog`);
		}
		this.modules.set(module.manifest.id, module);
	}

	get(extensionId: string): CapabilityExtensionModule | undefined {
		return this.modules.get(extensionId);
	}

	/** Unregister（Capability Extension 卸载/更新时由宿主调用）。 */
	unregister(extensionId: string): boolean {
		return this.modules.delete(extensionId);
	}

	list(): ExtensionManifest[] {
		return [...this.modules.values()].map((m) => m.manifest);
	}
}

export interface ResolvedCapabilityRuntime {
	activeBindings: number;
	skillPaths: string[];
	env: NodeJS.ProcessEnv;
	issues: CapabilityRuntimeIssue[];
	details: Record<string, Record<string, unknown>>;
}

export function capabilityBindingStateDir(
	stateRoot: string,
	extensionId: string,
	agentId: string,
	bindingId: string,
): string {
	return path.join(stateRoot, toolSafeId(extensionId), toolSafeId(agentId), toolSafeId(bindingId));
}

/**
 * 解析一个 Agent 的全部已启用 Capability Session 贡献。每个 binding 使用独立
 * stateDir；失败只形成诊断并跳过该贡献，不应让普通 Pi 会话无法创建。
 */
export async function resolveAgentCapabilityRuntime(input: {
	agent: AgentConfig;
	catalog: ExtensionCatalog;
	stateRoot: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
}): Promise<ResolvedCapabilityRuntime> {
	let env = { ...(input.env ?? process.env) };
	const skillPaths = new Set<string>();
	const issues: CapabilityRuntimeIssue[] = [];
	const details: Record<string, Record<string, unknown>> = {};
	let activeBindings = 0;
	for (const binding of input.agent.capabilityExtensions ?? []) {
		if (!binding.enabled) continue;
		const module = input.catalog.get(binding.extensionId);
		if (!module?.runtime) continue;
		activeBindings++;
		const key = `${binding.extensionId}:${binding.id}`;
		const stateDir = capabilityBindingStateDir(input.stateRoot, binding.extensionId, input.agent.name, binding.id);
		const sharedStateDir = path.join(input.stateRoot, binding.extensionId, "shared");
		try {
			const resolved = await module.runtime.resolveSession({
				agent: {
					id: input.agent.name,
					name: input.agent.name,
					description: input.agent.description,
					capabilities: input.agent.capabilities ?? [],
					pinned: input.agent.pinned === true,
					...(input.agent.connector?.connectorId ? { connectorId: input.agent.connector.connectorId } : {}),
				},
				binding,
				config: binding.config ?? {},
				cwd: input.cwd,
				env,
				stateDir,
				sharedStateDir,
			});
			for (const skillPath of resolved.skillPaths ?? []) {
				if (path.isAbsolute(skillPath)) skillPaths.add(skillPath);
				else issues.push({ code: "invalid_skill_path", message: `${key} 返回了非绝对 Skill 路径` });
			}
			if (resolved.env) env = { ...env, ...resolved.env };
			if (resolved.details) details[key] = resolved.details;
			for (const issue of resolved.issues ?? []) issues.push({ ...issue, code: `${key}:${issue.code}` });
		} catch (err) {
			issues.push({
				code: `${key}:runtime_failed`,
				message: `Capability「${binding.extensionId}」Session 资源解析失败：${err instanceof Error ? err.message : String(err)}`,
			});
		}
	}
	return { activeBindings, skillPaths: [...skillPaths], env, issues, details };
}

// ---- 工具命名空间（§3.3） ----

/** LLM 工具名只允许 [A-Za-z0-9_-]，Agent/Extension ID 先净化再拼接。 */
export function toolSafeId(id: string): string {
	return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** 基础委托工具：agent_<agentId>__delegate。 */
export function delegateToolName(agentId: string): string {
	return `agent_${toolSafeId(agentId)}__delegate`;
}

/** 专属 Extension 工具：agent_<agentId>__<extensionId>__<toolName>。 */
export function extensionToolName(agentId: string, extensionId: string, toolName: string): string {
	return `agent_${toolSafeId(agentId)}__${toolSafeId(extensionId)}__${toolName}`;
}

/** 反解受管工具名的 agentId 前缀（净化后的形式；与 toolSafeId(agent.name) 比较）。 */
export function agentPrefixFromToolName(toolName: string): string | undefined {
	const match = /^agent_([A-Za-z0-9_-]+?)__/.exec(toolName);
	return match?.[1];
}

/** 平台生成的基础 agent-delegation Extension 的保留 ID（§10.2：运行时投影）。 */
export const AGENT_DELEGATION_EXTENSION_ID = "agent-delegation";

/** 每个启用 Agent 自动生成的基础 Extension manifest（运行时投影，非安装包）。 */
export function delegationManifest(agent: AgentConfig): ExtensionManifest {
	const display = agentDisplayName(agent);
	return {
		id: AGENT_DELEGATION_EXTENSION_ID,
		kind: "capability",
		name: `${display} · 基础委托`,
		version: "1",
		description: `平台生成的基础委托能力：把任务委托给 worker「${display}」（id: ${agent.name}）并返回结果。`,
		tools: [{ name: "delegate", activation: "always", description: agent.description }],
	};
}

// ---- ScopedAgentInvoker（§3.2，决策 15） ----

export interface ScopedDelegateInput {
	windowId: string;
	managerSessionId: string;
	managerToolCallId?: string;
	goalId?: string;
	workPlanId?: string;
	workItemId?: string;
	attempt?: number;
	goalEpoch?: number;
	parentDelegationId?: string;
	handoffKind?: "request" | "followup";
	intent?: string;
	expectedOutcome?: string;
	evidenceRequirements?: string[];
	completionBoundary?: string;
	message: string;
	/** "run" 新开 worker session；"continue" 续接窗口记录的 session。 */
	mode: "run" | "continue";
	signal?: AbortSignal;
	onUpdate?: (content: string, details?: unknown) => void;
}

/**
 * Extension 拿到的窄接口。凭证仍由 Runtime 在调用 Driver/Transport 前注入；
 * worker token 明文、continuation token、spawn 能力都不经过这里，Extension
 * 即使被模型诱导也无法把密钥写进 tool result。
 */
export class ScopedAgentInvoker {
	constructor(
		readonly agentId: string,
		private readonly invoker: AgentInvoker,
	) {}

	capabilities(): Promise<DriverCapabilities | undefined> {
		return this.invoker.capabilitiesFor(this.agentId);
	}

	/**
	 * 发起一次委托（run/continue）。启用状态与窗口成员关系由 AgentInvoker
	 * 入口二次校验（§10.2 两层门控），陈旧 tool schema 无法越权调用。
	 */
	async delegate(input: ScopedDelegateInput): Promise<AgentInvokeResult> {
		const agent = await this.invoker.requireAgent(this.agentId);
		return this.invoker.delegate({ agent, ...input });
	}
}

/** ExtensionAPI 的工厂签名别名（避免各文件重复书写）。 */
export type PiExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

// ---- §10：两类 Extension manifest（Connector / Capability 禁止混包） ----

/** Extension 申请的能力权限（安装时向用户展示）。 */
export type ExtensionPermission = "spawn" | "network" | "workspace" | "secrets";

export const EXTENSION_PERMISSIONS: readonly ExtensionPermission[] = ["spawn", "network", "workspace", "secrets"];

// ---- 声明式 Connector（§10.3 两级模型第 1 级：无代码接入简单 CLI） ----

/** 声明式 Connector 的单次操作声明（run/continue）。 */
export interface DeclarativeOperationSpec {
	/** argv 模板，支持占位符 {message} {sessionHandle} {requestId} {packageDir}。 */
	args: string[];
	/** stdin framing：none 立即 EOF（默认）；json = 写 {message, sessionHandle, requestId} 后 EOF。 */
	stdin?: "none" | "json";
}

export interface DeclarativeConnectorSpec {
	/** 可执行文件名/路径。 */
	command: string;
	/** 探测：args 同样支持占位符；versionRegex 从 stdout 提取上游版本。 */
	probe?: { args: string[]; versionRegex?: string };
	operations: { run: DeclarativeOperationSpec; continue?: DeclarativeOperationSpec };
	output: {
		mode: "jsonl" | "single-json";
		/** 字段映射 DSL：`"$.<dot.path>@<eventType>[<filterPath>=<filterValue>]"`。 */
		mapping?: Record<string, string>;
	};
	capabilities: {
		operations: Array<"run" | "continue" | "respond" | "cancel">;
		interactionKinds: Array<"permission" | "question" | "confirmation">;
	};
}

/** mapping 允许的目标字段（只实现这个子集，不泛化）。 */
export const DECLARATIVE_MAPPING_KEYS: ReadonlySet<string> = new Set([
	"sessionHandle",
	"runHandle",
	"content",
	"progress",
	"error",
	"usage.inputTokens",
	"usage.outputTokens",
]);

/** mapping value 的解析结果（校验与 Driver 执行共用，单一事实源）。 */
export interface DeclarativeMappingRef {
	/** `$.` 之后的 dot.path 分段。 */
	path: string[];
	/** `@` 之后的事件类型（single-json 模式必须省略）。 */
	eventType?: string;
	/** `[filterPath=filterValue]` 过滤器。 */
	filterPath?: string[];
	filterValue?: string;
}

const MAPPING_VALUE_RE =
	/^\$\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)(?:@([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)(?:\[([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)=([^\]]+)\])?)?$/;

/** 解析 mapping value；格式非法返回 undefined（parse 校验与 Driver 共用）。 */
export function parseDeclarativeMappingRef(value: string): DeclarativeMappingRef | undefined {
	const m = MAPPING_VALUE_RE.exec(value);
	if (!m) return undefined;
	return {
		path: m[1]!.split("."),
		...(m[2] ? { eventType: m[2] } : {}),
		...(m[3] ? { filterPath: m[3].split("."), filterValue: m[4]! } : {}),
	};
}

const DECLARATIVE_OPERATIONS = new Set(["run", "continue", "respond", "cancel"]);

function validateDeclarativeOperation(value: unknown, field: string): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${field} 必须是对象`);
	}
	const op = value as Record<string, unknown>;
	if (!Array.isArray(op.args) || op.args.length === 0 || op.args.some((a) => typeof a !== "string" || !a)) {
		throw new Error(`${field}.args 必须是非空字符串数组`);
	}
	if (op.stdin !== undefined && op.stdin !== "none" && op.stdin !== "json") {
		throw new Error(`${field}.stdin 必须是 "none" | "json"`);
	}
}

/** 校验 connector.declarative 声明（含 capabilities 一致性，防虚标）。 */
function validateDeclarative(value: unknown): DeclarativeConnectorSpec {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("connector.declarative 必须是对象");
	}
	const d = value as Record<string, unknown>;
	requireString(d.command, "connector.declarative.command");
	if (d.probe !== undefined) {
		if (!d.probe || typeof d.probe !== "object" || Array.isArray(d.probe)) {
			throw new Error("connector.declarative.probe 必须是对象");
		}
		const probe = d.probe as Record<string, unknown>;
		if (!Array.isArray(probe.args) || probe.args.length === 0 || probe.args.some((a) => typeof a !== "string" || !a)) {
			throw new Error("connector.declarative.probe.args 必须是非空字符串数组");
		}
		if (probe.versionRegex !== undefined) {
			if (typeof probe.versionRegex !== "string") {
				throw new Error("connector.declarative.probe.versionRegex 必须是字符串");
			}
			try {
				new RegExp(probe.versionRegex);
			} catch {
				throw new Error("connector.declarative.probe.versionRegex 不是合法正则");
			}
		}
	}
	if (!d.operations || typeof d.operations !== "object" || Array.isArray(d.operations)) {
		throw new Error("connector.declarative.operations 必须是对象");
	}
	const ops = d.operations as Record<string, unknown>;
	validateDeclarativeOperation(ops.run, "connector.declarative.operations.run");
	if (ops.continue !== undefined) {
		validateDeclarativeOperation(ops.continue, "connector.declarative.operations.continue");
	}
	if (!d.output || typeof d.output !== "object" || Array.isArray(d.output)) {
		throw new Error("connector.declarative.output 必须是对象");
	}
	const output = d.output as Record<string, unknown>;
	if (output.mode !== "jsonl" && output.mode !== "single-json") {
		throw new Error('connector.declarative.output.mode 必须是 "jsonl" | "single-json"');
	}
	if (output.mapping !== undefined) {
		if (!output.mapping || typeof output.mapping !== "object" || Array.isArray(output.mapping)) {
			throw new Error("connector.declarative.output.mapping 必须是对象");
		}
		for (const [key, v] of Object.entries(output.mapping)) {
			if (!DECLARATIVE_MAPPING_KEYS.has(key)) {
				throw new Error(`connector.declarative.output.mapping 含非法 key：${key}`);
			}
			if (typeof v !== "string" || !parseDeclarativeMappingRef(v)) {
				throw new Error(`connector.declarative.output.mapping["${key}"] 格式非法：${String(v)}`);
			}
			// single-json 对整个 stdout JSON 对象取路径，@事件类型/过滤器必须省略。
			if (output.mode === "single-json" && v.includes("@")) {
				throw new Error(`connector.declarative.output.mapping["${key}"]：single-json 模式不允许 @事件类型`);
			}
		}
	}
	if (!d.capabilities || typeof d.capabilities !== "object" || Array.isArray(d.capabilities)) {
		throw new Error("connector.declarative.capabilities 必须是对象");
	}
	const caps = d.capabilities as Record<string, unknown>;
	if (!Array.isArray(caps.operations) || caps.operations.some((o) => !DECLARATIVE_OPERATIONS.has(o as string))) {
		throw new Error("connector.declarative.capabilities.operations 必须是 run/continue/respond/cancel 的数组");
	}
	const capOps = caps.operations as string[];
	if (!capOps.includes("run")) {
		throw new Error("connector.declarative.capabilities.operations 必须含 \"run\"");
	}
	// 声明式不支持 HITL：respond 与 interactionKinds 一律拒绝。
	if (capOps.includes("respond")) {
		throw new Error("connector.declarative 不支持 respond（capabilities.operations 不得含 \"respond\"）");
	}
	if (!Array.isArray(caps.interactionKinds) || caps.interactionKinds.length > 0) {
		throw new Error("connector.declarative.capabilities.interactionKinds 必须是空数组");
	}
	if (ops.continue === undefined && capOps.includes("continue")) {
		throw new Error("connector.declarative 未声明 operations.continue 时 capabilities.operations 不得含 \"continue\"");
	}
	// 校验通过，原样透传。
	return value as DeclarativeConnectorSpec;
}

export interface ConnectorContribution {
	id: string;
	displayName: string;
	apiVersion: "1";
	defaultTransport: "spawn" | "http" | "rpc" | "acp" | "sdk";
	supportedTransports: Array<"spawn" | "http" | "rpc" | "acp" | "sdk">;
	configSchema?: Record<string, unknown>;
	secretSchema?: Array<{ key: string; label: string; required: boolean }>;
	/** 声明式 Connector 声明（§10.3 第 1 级）；与顶层 entry 互斥。 */
	declarative?: DeclarativeConnectorSpec;
	/**
	 * Connector 默认头像：包内相对资源路径（如 "assets/avatar.svg"）。
	 * Agent 未上传头像时由平台回退展示；上传后上传优先，删除上传后回到默认。
	 */
	avatar?: string;
	supportedUpstreamVersions?: string;
	versionProbe?: Record<string, unknown>;
}

export interface CapabilityContribution {
	id: string;
	displayName: string;
	apiVersion: "1";
	configSchema?: Record<string, unknown>;
	secretSchema?: Array<{ key: string; label: string; required: boolean }>;
	/** 模块注册的工具（命名空间前缀由平台统一加）。 */
	tools: ExtensionToolContribution[];
	/** “添加 Extension”只展示与当前 connectorId 兼容的 Capability（§10.1）。 */
	compatibleConnectors?: string[];
}

export interface ExtensionManifestBase {
	id: string;
	publisher: string;
	displayName: string;
	version: string;
	source: "builtin" | "trusted" | "external";
	engines: { puddingteams: string };
	permissions?: ExtensionPermission[];
}

export interface ConnectorExtensionManifest extends ExtensionManifestBase {
	kind: "connector";
	connector: ConnectorContribution;
}

export interface CapabilityExtensionManifest extends ExtensionManifestBase {
	kind: "capability";
	capability: CapabilityContribution;
}

export type PuddingTeamsExtensionManifest = ConnectorExtensionManifest | CapabilityExtensionManifest;

/** 安装包的清单文件名（entry 字段指向模块入口，不在 §10 类型内）。 */
export const EXTENSION_MANIFEST_FILE = "pudding-extension.json";

/**
 * 从包目录读取并校验安装包 manifest（§9.5/§10）：
 * pudding-extension.json 优先，否则 package.json 的 puddingteams 折叠字段
 * （双宿主包）。ExtensionRegistry 安装流程与 `puddingteams extension validate`
 * 共用此函数，保证读取优先级与校验口径单一事实源。
 */
export async function readManifestFromDir(dirPath: string): Promise<PuddingTeamsExtensionManifest & { entry?: string }> {
	const dir = path.resolve(dirPath);
	let raw: string;
	try {
		// pudding-extension.json 优先（过渡期约定，§9.5）。
		raw = await readFile(path.join(dir, EXTENSION_MANIFEST_FILE), "utf-8");
	} catch {
		// 双宿主包：manifest 折叠在 package.json 的 puddingteams 字段。
		const pkgRaw = await readFile(path.join(dir, "package.json"), "utf-8").catch(() => {
			throw new Error(`找不到 manifest：${path.join(dir, EXTENSION_MANIFEST_FILE)} 或 package.json 的 puddingteams 字段`);
		});
		let pkg: Record<string, unknown>;
		try {
			pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
		} catch {
			throw new Error("package.json 不是合法 JSON");
		}
		if (!pkg.puddingteams || typeof pkg.puddingteams !== "object" || Array.isArray(pkg.puddingteams)) {
			throw new Error(`package.json 缺少 puddingteams 字段（${dir} 不是 PuddingTeams 扩展包）`);
		}
		raw = JSON.stringify(pkg.puddingteams);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("manifest 不是合法 JSON");
	}
	const manifest = parseExtensionManifest(parsed);
	if (manifest.entry && (manifest.entry.includes("..") || path.isAbsolute(manifest.entry))) {
		throw new Error("manifest.entry 必须是包内相对路径");
	}
	return manifest;
}

const TRANSPORTS = new Set(["spawn", "http", "rpc", "acp", "sdk"]);

function validateTransportConfigAnnotations(schema: unknown, supported: Set<string>): void {
	if (schema === undefined) return;
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
	const properties = (schema as Record<string, unknown>).properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) return;
	for (const [name, rawProp] of Object.entries(properties as Record<string, unknown>)) {
		if (!rawProp || typeof rawProp !== "object" || Array.isArray(rawProp)) continue;
		const transports = (rawProp as Record<string, unknown>)["x-puddingteams-transports"];
		if (transports === undefined) continue;
		if (!Array.isArray(transports) || transports.length === 0) {
			throw new Error(`connector.configSchema.properties.${name}.x-puddingteams-transports 必须是非空数组`);
		}
		for (const transport of transports) {
			if (typeof transport !== "string" || !supported.has(transport)) {
				throw new Error(`connector.configSchema.properties.${name} 声明了未支持的 transport：${String(transport)}`);
			}
		}
	}
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`manifest.${field} 必须是非空字符串`);
	return value;
}

function validateSecretSchema(value: unknown, field: string): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) throw new Error(`${field} 必须是数组`);
	for (const item of value) {
		if (!item || typeof item !== "object") throw new Error(`${field} 项必须是对象`);
		const s = item as Record<string, unknown>;
		requireString(s.key, `${field}.key`);
		requireString(s.label, `${field}.label`);
		if (typeof s.required !== "boolean") throw new Error(`${field}.required 必须是布尔值`);
	}
}

/** 包内资源路径（头像等）：相对、不越界、白名单扩展名。 */
const AVATAR_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"]);

function validateAvatarPath(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	const p = requireString(value, "connector.avatar").trim();
	if (p.startsWith("/") || p.includes("..") || p.includes("\\")) {
		throw new Error("connector.avatar 必须是包内相对路径（不允许绝对路径/.. /反斜杠）");
	}
	const ext = p.slice(p.lastIndexOf(".")).toLowerCase();
	if (!AVATAR_EXTENSIONS.has(ext)) {
		throw new Error(`connector.avatar 扩展名必须是 ${[...AVATAR_EXTENSIONS].join("/")} 之一`);
	}
	return p;
}

/**
 * 校验并归一化安装包 manifest（§10）：
 * - kind 判别 Connector/Capability，禁止一个 manifest 同时贡献两类；
 * - engines/permissions 声明必须存在且合法；宿主版本是否满足该范围由
 *   ExtensionRegistry 在安装与每次激活时强制校验。
 */
export function parseExtensionManifest(raw: unknown): PuddingTeamsExtensionManifest & { entry?: string } {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("manifest 必须是 JSON 对象");
	const m = raw as Record<string, unknown>;
	if (m.connector !== undefined && m.capability !== undefined) {
		throw new Error("禁止一个 manifest 同时贡献 Connector 与 Capability（§10）");
	}
	const id = requireString(m.id, "id");
	const publisher = requireString(m.publisher, "publisher");
	const displayName = requireString(m.displayName, "displayName");
	const version = requireString(m.version, "version");
	const source = m.source;
	if (source !== "builtin" && source !== "trusted" && source !== "external") {
		throw new Error('manifest.source 必须是 "builtin" | "trusted" | "external"');
	}
	const sourceLiteral: ExtensionManifestBase["source"] = source;
	const engines = m.engines as Record<string, unknown> | undefined;
	if (!engines || typeof engines !== "object" || typeof engines.puddingteams !== "string" || !engines.puddingteams.trim()) {
		throw new Error("manifest.engines.puddingteams 必须声明版本范围");
	}
	const engineRange = engines.puddingteams.trim();
	if (!semver.validRange(engineRange)) {
		throw new Error(`manifest.engines.puddingteams 不是合法 semver range：${engineRange}`);
	}
	const permissions = m.permissions;
	if (permissions !== undefined) {
		if (!Array.isArray(permissions)) throw new Error("manifest.permissions 必须是数组");
		for (const p of permissions) {
			if (!EXTENSION_PERMISSIONS.includes(p as ExtensionPermission)) {
				throw new Error(`manifest.permissions 含未知权限：${String(p)}`);
			}
		}
	}
	const entry = m.entry === undefined ? undefined : requireString(m.entry, "entry");
	const base = {
		id,
		publisher,
		displayName,
		version,
		source: sourceLiteral,
		engines: { puddingteams: engineRange },
		...(permissions ? { permissions: permissions as ExtensionPermission[] } : {}),
		...(entry ? { entry } : {}),
	};
	if (m.kind === "connector") {
		const c = m.connector as Record<string, unknown> | undefined;
		if (!c || typeof c !== "object") throw new Error('kind:"connector" 的 manifest 必须含 connector contribution');
		if (c.apiVersion !== "1") throw new Error('connector.apiVersion 只支持 "1"');
		if (!TRANSPORTS.has(c.defaultTransport as string)) throw new Error("connector.defaultTransport 非法");
		if (!Array.isArray(c.supportedTransports) || c.supportedTransports.length === 0) {
			throw new Error("connector.supportedTransports 必须是非空数组");
		}
		const supported = new Set<string>();
		for (const t of c.supportedTransports) {
			if (!TRANSPORTS.has(t as string)) throw new Error(`connector.supportedTransports 含非法 transport：${String(t)}`);
			if (supported.has(t as string)) throw new Error(`connector.supportedTransports 含重复 transport：${String(t)}`);
			supported.add(t as string);
		}
		if (!(c.supportedTransports as unknown[]).includes(c.defaultTransport)) {
			throw new Error("connector.defaultTransport 必须包含在 supportedTransports 中");
		}
		const permissionSet = new Set(Array.isArray(permissions) ? permissions as string[] : []);
		if (supported.has("spawn") && !permissionSet.has("spawn")) {
			throw new Error('Connector 支持 transport:"spawn" 时 manifest.permissions 必须声明 "spawn"');
		}
		if (["http", "rpc", "acp"].some((transport) => supported.has(transport)) && !permissionSet.has("network")) {
			throw new Error('Connector 支持 http/rpc/acp transport 时 manifest.permissions 必须声明 "network"');
		}
		validateTransportConfigAnnotations(c.configSchema, supported);
		validateSecretSchema(c.secretSchema, "connector.secretSchema");
		const avatar = validateAvatarPath(c.avatar);
		// 声明式与代码型互斥：有 entry 走代码型 Connector（§10.3 两级模型）。
		const declarative =
			c.declarative === undefined
				? undefined
				: (() => {
						if (entry) throw new Error("connector.declarative 与顶层 entry 互斥（有代码走代码型 Connector）");
						if (c.defaultTransport !== "spawn" || supported.size !== 1 || !supported.has("spawn")) {
							throw new Error('connector.declarative 当前只支持唯一 transport:"spawn"');
						}
						return validateDeclarative(c.declarative);
					})();
		return {
			...base,
			kind: "connector",
			connector: {
				id: requireString(c.id, "connector.id"),
				displayName: requireString(c.displayName, "connector.displayName"),
				apiVersion: "1",
				defaultTransport: c.defaultTransport as ConnectorContribution["defaultTransport"],
				supportedTransports: c.supportedTransports as ConnectorContribution["supportedTransports"],
				...(c.configSchema ? { configSchema: c.configSchema as Record<string, unknown> } : {}),
				...(c.secretSchema ? { secretSchema: c.secretSchema as ConnectorContribution["secretSchema"] } : {}),
				...(avatar ? { avatar } : {}),
				...(declarative ? { declarative } : {}),
				...(typeof c.supportedUpstreamVersions === "string" ? { supportedUpstreamVersions: c.supportedUpstreamVersions } : {}),
				...(c.versionProbe ? { versionProbe: c.versionProbe as Record<string, unknown> } : {}),
			},
		};
	}
	if (m.kind === "capability") {
		const c = m.capability as Record<string, unknown> | undefined;
		if (!c || typeof c !== "object") throw new Error('kind:"capability" 的 manifest 必须含 capability contribution');
		if (c.apiVersion !== "1") throw new Error('capability.apiVersion 只支持 "1"');
		if (!Array.isArray(c.tools)) throw new Error("capability.tools 必须是数组");
		const tools: ExtensionToolContribution[] = c.tools.map((t, i) => {
			if (!t || typeof t !== "object") throw new Error(`capability.tools[${i}] 必须是对象`);
			const tool = t as Record<string, unknown>;
			if (tool.activation !== "always" && tool.activation !== "searchable") {
				throw new Error(`capability.tools[${i}].activation 必须是 "always" | "searchable"`);
			}
			return {
				name: requireString(tool.name, `capability.tools[${i}].name`),
				activation: tool.activation,
				...(typeof tool.description === "string" ? { description: tool.description } : {}),
			};
		});
		validateSecretSchema(c.secretSchema, "capability.secretSchema");
		if (c.compatibleConnectors !== undefined && !Array.isArray(c.compatibleConnectors)) {
			throw new Error("capability.compatibleConnectors 必须是数组");
		}
		return {
			...base,
			kind: "capability",
			capability: {
				id: requireString(c.id, "capability.id"),
				displayName: requireString(c.displayName, "capability.displayName"),
				apiVersion: "1",
				...(c.configSchema ? { configSchema: c.configSchema as Record<string, unknown> } : {}),
				...(c.secretSchema ? { secretSchema: c.secretSchema as CapabilityContribution["secretSchema"] } : {}),
				tools,
				...(c.compatibleConnectors ? { compatibleConnectors: c.compatibleConnectors as string[] } : {}),
			},
		};
	}
	throw new Error('manifest.kind 必须是 "connector" | "capability"');
}
