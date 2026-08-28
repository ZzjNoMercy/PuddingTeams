import { randomUUID } from "node:crypto";
import path from "node:path";
import {
	createAgentSession,
	createBashToolDefinition,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type CreateAgentSessionOptions,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type {
	AgentDriver,
	AgentEvent,
	ContinueInput,
	DriverCapabilities,
	InvocationContext,
	ProbeResult,
	RespondInput,
	RunInput,
} from "./types.js";
import { sharedModelRuntime } from "../pi-bridge/model-runtime.js";
import type { PiResourceConfig } from "../store/teams.js";
import type { WorkspaceResourceAccess } from "../store/workspaces.js";
import { appendPiPrompts, piResourceLoaderOptions } from "../pi-bridge/pi-resources.js";
import {
	buildWorkspaceFffExtension,
	stripUnmanagedPiFff,
	type HarnessCodeSearchProvider,
	type WorkspaceCodeSearchScope,
} from "../pi-bridge/code-search.js";

export interface LocalPiDriverOptions {
	/** 模型引用：`${provider}/${modelId}` 或裸 modelId；留空用 pi 默认模型。 */
	model?: string;
	/** thinking 级别（off/minimal/low/medium/high/xhigh）。 */
	thinkingLevel?: string;
	/** Agent 级提示词与资源；不属于 Connector 运行参数。 */
	piResources?: PiResourceConfig;
	/**
	 * 信任门判定（迁移方案 §7.2）：按 workspaceId 计算三类资源放行，
	 * 与 piResources 的 Agent 开关取与；无 workspaceId（unscoped）= 全关（§6.3）。
	 * 未注入（独立使用）时维持只看 Agent 开关的旧语义。
	 */
	workspaceAccessFor?: (workspaceId?: string) => Promise<WorkspaceResourceAccess>;
	/** 平台解析后的有效搜索策略；FFF 必须同时带已信任 workspace scope。 */
	codeSearchFor?: (workspaceId?: string) => Promise<{
		provider: HarnessCodeSearchProvider;
		workspace?: WorkspaceCodeSearchScope;
	}>;
	fffStateRoot?: string;
	/** 已绑定 Capability 给目标 worker Session 追加 Skills 与 bash 环境。 */
	capabilityRuntimeFor?: (
		env: NodeJS.ProcessEnv,
		cwd: string,
	) => Promise<{ activeBindings: number; skillPaths: string[]; env: NodeJS.ProcessEnv; issues: Array<{ code: string; message: string }> }>;
	/** 会话存储目录；平台注入 `PUDDINGTEAMS_HOME/sessions/workers`，缺省（独立使用）派生 `<pi agentDir>/puddingteams-worker-sessions`。 */
	sessionDir?: string;
	/** 仅供运行时/测试调节；429/过载保持同一 Delegation 与 Session 冷却续跑。 */
	transientRecovery?: { maxAttempts?: number; rateLimitDelayMs?: number; overloadedDelayMs?: number };
}

type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;
type PiThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

/**
 * 能力诚实声明（v1）：pi worker 走 run/continue/cancel；HITL 审批外送
 * （input_required/respond）不支持——child pi 的权限确认在其会话内部消化，
 * 不上抛到房间审批卡。transport 是 "sdk"：进程内 SDK 调用，不是子进程。
 */
export const PI_CAPABILITIES: DriverCapabilities = {
	operations: ["run", "continue", "cancel"],
	interactionKinds: [],
	progress: "stream",
	transport: "sdk",
};

/**
 * 进程级共享状态：DriverRegistry.create 每次调用都 new 一个 Driver 实例
 * （invoker.resolveDriverFor），活跃 session 与 runHandle 索引必须跨实例
 * 共享，否则 continue/cancel 找不到 run 时创建的 AgentSession。
 */
const sessionsByHandle = new Map<string, AgentSession>();
const searchFingerprintByHandle = new Map<string, string>();
const runningByRunHandle = new Map<string, AgentSession>();

/** 执行过程可视化：按 sessionHandle 查驻留的 worker 会话（不在池里=未在跑/已被淘汰）。 */
export function liveWorkerSession(handle: string): AgentSession | undefined {
	return sessionsByHandle.get(handle);
}

function modelRuntime(): Promise<ModelRuntime> {
	return sharedModelRuntime();
}

/** 驻留上限：超出时淘汰最老的空闲 session（正在跑的不动）。 */
const MAX_RESIDENT_SESSIONS = 32;

function retainSession(session: AgentSession, searchFingerprint?: string): void {
	sessionsByHandle.set(session.sessionId, session);
	if (searchFingerprint) searchFingerprintByHandle.set(session.sessionId, searchFingerprint);
	if (sessionsByHandle.size <= MAX_RESIDENT_SESSIONS) return;
	for (const [id, s] of sessionsByHandle) {
		if (sessionsByHandle.size <= MAX_RESIDENT_SESSIONS) break;
		if ([...runningByRunHandle.values()].includes(s)) continue;
		sessionsByHandle.delete(id);
		searchFingerprintByHandle.delete(id);
		s.dispose();
	}
}

/** pi AssistantMessage 的结构化投影（content 是 block 数组）。 */
interface PiAssistantProjection {
	role?: string;
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: number | { total?: number };
	};
}

function lastAssistant(session: AgentSession): PiAssistantProjection | undefined {
	const messages = session.messages as unknown as PiAssistantProjection[];
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") return messages[i];
	}
	return undefined;
}

/**
 * 聚合本次 Run 新增 assistant 消息的 token 用量（多轮工具循环每轮一条
 * assistant 消息，只取末条会严重少算）。口径与 manager 统计条一致：
 * 输入 = 净输入 + 缓存读 + 缓存写；cost 取 pi 按价目表换算的总价。
 */
function aggregateRunUsage(
	messages: PiAssistantProjection[],
): { turns: number; inputTokens: number; outputTokens: number; cost?: number } | undefined {
	let turns = 0;
	let input = 0;
	let output = 0;
	let cost = 0;
	let hasCost = false;
	for (const m of messages) {
		if (m?.role !== "assistant" || !m.usage) continue;
		turns++;
		input += (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0);
		output += m.usage.output ?? 0;
		const c = typeof m.usage.cost === "number" ? m.usage.cost : m.usage.cost?.total;
		if (typeof c === "number") {
			cost += c;
			hasCost = true;
		}
	}
	return turns > 0 ? { turns, inputTokens: input, outputTokens: output, ...(hasCost ? { cost } : {}) } : undefined;
}

function assistantText(message: PiAssistantProjection | undefined): string {
	const content = message?.content;
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter(
				(b): b is { type: "text"; text: string } =>
					Boolean(b) && typeof b === "object" && (b as { type?: string }).type === "text",
			)
			.map((b) => b.text)
			.join("")
			.trim();
	}
	return "";
}

/** 把 pi 会话事件映射成 PWCP progress（只挑有信息量的，文本 delta 不上抛）。 */
function toProgress(event: AgentSessionEvent): AgentEvent | undefined {
	switch (event.type) {
		case "tool_execution_start":
			return { type: "progress", stage: "tool", message: `调用工具 ${event.toolName}` };
		case "auto_retry_start":
			return {
				type: "progress",
				stage: "retry",
				message: `请求失败，自动重试 ${event.attempt}/${event.maxAttempts}：${event.errorMessage}`,
			};
		case "compaction_start":
			return { type: "progress", stage: "compact", message: "上下文压缩中…" };
		default:
			return undefined;
	}
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function transientCooldownMs(error: string, options: LocalPiDriverOptions["transientRecovery"]): number | undefined {
	if (/\b429\b|rate.?limit|max rpm|too many requests/i.test(error)) {
		const retryAfter = error.match(/(?:retry|try again)\s+after\s+(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m)\b/i);
		if (retryAfter) {
			const value = Number(retryAfter[1]);
			const unit = retryAfter[2]?.toLowerCase() ?? "s";
			const multiplier = unit.startsWith("milli") || unit === "ms" ? 1 : unit.startsWith("m") ? 60_000 : 1_000;
			return Math.max(1_000, Math.ceil(value * multiplier));
		}
		return options?.rateLimitDelayMs ?? 60_000;
	}
	if (/overloaded|capacity/i.test(error)) return options?.overloadedDelayMs ?? 15_000;
	return undefined;
}

export function piSearchFingerprint(
	codeSearch?: Awaited<ReturnType<NonNullable<LocalPiDriverOptions["codeSearchFor"]>>>,
): string {
	return JSON.stringify([
		codeSearch?.provider ?? "sdk-default",
		codeSearch?.workspace?.id ?? null,
		codeSearch?.workspace?.canonicalPath ?? null,
		codeSearch?.workspace?.trusted ?? false,
	]);
}

async function waitForCooldown(ms: number, signal?: AbortSignal): Promise<boolean> {
	if (signal?.aborted) return false;
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => { cleanup(); resolve(true) }, ms);
		const abort = () => { clearTimeout(timer); cleanup(); resolve(false) };
		const cleanup = () => signal?.removeEventListener("abort", abort);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

/**
 * 本地 pi Connector Driver（§9.1 Pi 调 Pi）：child pi 以全新 AgentSession
 * 运行在 PuddingTeams 进程内，模型目录复用 pi 全局 agentDir，provider 凭证
 * 走平台共享 ModelRuntime（<home>/secrets/auth.json，与 pi CLI 解耦 §10.6）。
 *
 * - run      → SessionManager.create + createAgentSession + prompt
 * - continue → 内存命中复用；否则 SessionManager.open 从 JSONL 恢复后 prompt
 * - cancel   → 对 runHandle 对应的活跃 session 调 abort()
 * - respond  → 不支持（v1 不上抛 HITL；永远不会被 Runtime 调到，防御性返回）
 *
 * §9.1 铁律：child session 不注册团队委托工具（无 extensionFactories），
 * 默认不递归；sessionHandle 就是 pi 的 sessionId，与 manager 的会话存储
 * 目录隔离（默认派生目录，SessionManager 内部再按 cwd 分桶）。
 */
export class LocalPiDriver implements AgentDriver {
	readonly id = "pi";

	constructor(private readonly opts: LocalPiDriverOptions = {}) {}

	async capabilities(): Promise<DriverCapabilities> {
		return PI_CAPABILITIES;
	}

	private sessionDir(): string {
		return this.opts.sessionDir ?? path.join(getAgentDir(), "puddingteams-worker-sessions");
	}

	private async resolveModel(): Promise<PiModel | undefined> {
		const ref = this.opts.model?.trim();
		if (!ref) return undefined;
		const rt = await modelRuntime();
		// Model id 本身可能含 "/"（如 openrouter），按第一个 "/" 切。
		const slash = ref.indexOf("/");
		const model =
			slash > 0
				? rt.getModel(ref.slice(0, slash), ref.slice(slash + 1))
				: rt.getModels().find((m) => m.id === ref);
		if (!model) throw new Error(`未知模型：${ref}`);
		return model as PiModel;
	}

	private async newSession(
		sessionManager: SessionManager,
		cwd: string,
		workspaceAccess?: WorkspaceResourceAccess,
		codeSearch?: Awaited<ReturnType<NonNullable<LocalPiDriverOptions["codeSearchFor"]>>>,
		invocationEnv: NodeJS.ProcessEnv = process.env,
	): Promise<AgentSession> {
		const agentDir = getAgentDir();
		const capabilityRuntime = this.opts.capabilityRuntimeFor
			? await this.opts.capabilityRuntimeFor(invocationEnv, cwd)
			: undefined;
		const resources: PiResourceConfig | undefined = capabilityRuntime?.skillPaths.length
			? {
					...(this.opts.piResources ?? {}),
					skillPaths: [...new Set([...(this.opts.piResources?.skillPaths ?? []), ...capabilityRuntime.skillPaths])],
				}
			: this.opts.piResources;
		for (const issue of capabilityRuntime?.issues ?? []) {
			// Worker 的动态 probe 会给用户完整修复建议；会话装配仅保留可见进度，
			// 不因单个外部 Capability 不可用而阻断普通 Pi 工作。
			console.warn(`[pi worker capability] ${issue.message} (${issue.code})`);
		}
		const extensionFactories: InlineExtension[] = [];
		if (codeSearch?.provider === "fff" && codeSearch.workspace?.trusted && this.opts.fffStateRoot) {
			extensionFactories.push(await buildWorkspaceFffExtension({
				stateRoot: this.opts.fffStateRoot,
				workspace: codeSearch.workspace,
			}));
		}
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir),
			...piResourceLoaderOptions(resources, cwd, agentDir, workspaceAccess),
			...(extensionFactories.length ? { extensionFactories } : {}),
			extensionsOverride: stripUnmanagedPiFff,
			// 无 extensionFactories：child pi 不挂载团队委托工具（§9.1 默认不递归）。
			// append-only（§3）：worker 运行指令只追加，不覆盖 pi 内嵌默认提示词。
			appendSystemPromptOverride: (base) => appendPiPrompts(base, resources),
		});
		await loader.reload();
		const model = await this.resolveModel();
		const { session } = await createAgentSession({
			cwd,
			sessionManager,
			...(model ? { model } : {}),
			modelRuntime: await modelRuntime(),
			...(this.opts.thinkingLevel
				? { thinkingLevel: this.opts.thinkingLevel as PiThinkingLevel }
				: {}),
			resourceLoader: loader,
			...(capabilityRuntime && capabilityRuntime.activeBindings > 0
				? {
						customTools: [
							createBashToolDefinition(cwd, {
								spawnHook: (spawnCtx) => ({
									...spawnCtx,
									env: { ...spawnCtx.env, ...capabilityRuntime.env },
								}),
							}) as NonNullable<CreateAgentSessionOptions["customTools"]>[number],
						],
					}
					: {}),
		});
		// SDK embedding does not emit extension lifecycle events automatically.
		// Without this, pi-fff keeps its construction-time process.cwd() and can
		// index the server source tree instead of the selected Workspace.
		await session.bindExtensions({ mode: "rpc" });
		if (codeSearch?.provider === "builtin") {
			const active = session.getActiveToolNames();
			session.setActiveToolsByName([...new Set([...active, "grep", "find"])]);
		}
		return session;
	}

	/**
	 * 配置里的 model 与驻留/恢复会话的当前模型对齐：模型只在 createAgentSession
	 * 时生效，改配置后继续跑的旧会话（内存驻留或 JSONL 恢复）仍用旧模型，
	 * 需要显式 setModel 纠偏；相同则不动。未配置 model（用 pi 默认）时不干预。
	 */
	private async reconcileModel(session: AgentSession): Promise<void> {
		const model = await this.resolveModel();
		if (!model) return;
		const current = session.model as PiModel | undefined;
		if (current && current.provider === model.provider && current.id === model.id) return;
		await session.setModel(model);
	}

	/** run 开新会话；continue 先查内存驻留，miss 则从 JSONL 恢复。 */
	private async openSession(
		ctx: InvocationContext,
		sessionHandle?: string,
	): Promise<{ session: AgentSession; sessionHandle: string }> {
		// 信任门在会话装配时判定（不是构造时）：撤销信任后新开会话立即生效。
		const access = this.opts.workspaceAccessFor
			? await this.opts.workspaceAccessFor(ctx.workspaceId)
			: undefined;
		const codeSearch = this.opts.codeSearchFor ? await this.opts.codeSearchFor(ctx.workspaceId) : undefined;
		const searchFingerprint = piSearchFingerprint(codeSearch);
		if (sessionHandle) {
			const live = sessionsByHandle.get(sessionHandle);
			if (live && searchFingerprintByHandle.get(sessionHandle) === searchFingerprint) {
				await this.reconcileModel(live);
				return { session: live, sessionHandle };
			}
			if (live) {
				sessionsByHandle.delete(sessionHandle);
				searchFingerprintByHandle.delete(sessionHandle);
				live.dispose();
			}
			const info = (await SessionManager.list(ctx.cwd, this.sessionDir())).find((s) => s.id === sessionHandle);
			if (!info) throw new Error(`pi worker 会话不存在：${sessionHandle}`);
			const session = await this.newSession(SessionManager.open(info.path, this.sessionDir()), ctx.cwd, access, codeSearch, ctx.env);
			await this.reconcileModel(session);
			retainSession(session, searchFingerprint);
			return { session, sessionHandle: session.sessionId };
		}
		const session = await this.newSession(SessionManager.create(ctx.cwd, this.sessionDir()), ctx.cwd, access, codeSearch, ctx.env);
		retainSession(session, searchFingerprint);
		return { session, sessionHandle: session.sessionId };
	}

	async *run(input: RunInput, ctx: InvocationContext): AsyncIterable<AgentEvent> {
		const runHandle = ctx.delegationId ?? randomUUID();
		ctx.onUpdate?.("pi worker 正在启动…", { running: true });
		let opened: { session: AgentSession; sessionHandle: string };
		try {
			opened = await this.openSession(ctx);
		} catch (err) {
			yield {
				type: "failed",
				result: {
					agentId: this.id,
					status: "failed",
					errorCode: "session_create_failed",
					error: `pi worker 会话创建失败：${errMessage(err)}`,
					recoverable: true,
					runHandle,
				},
			};
			return;
		}
		yield { type: "started", sessionHandle: opened.sessionHandle, runHandle };
		yield* this.drive(opened.session, input.message, ctx, opened.sessionHandle, runHandle);
	}

	async *continue(input: ContinueInput, ctx: InvocationContext): AsyncIterable<AgentEvent> {
		const runHandle = ctx.delegationId ?? randomUUID();
		ctx.onUpdate?.("pi worker 正在续接会话…", { running: true });
		let opened: { session: AgentSession; sessionHandle: string };
		try {
			opened = await this.openSession(ctx, input.sessionHandle);
		} catch (err) {
			yield {
				type: "failed",
				result: {
					agentId: this.id,
					status: "failed",
					errorCode: "session_resume_failed",
					error: errMessage(err),
					recoverable: true,
					sessionHandle: input.sessionHandle,
					runHandle,
				},
			};
			return;
		}
		yield { type: "started", sessionHandle: opened.sessionHandle, runHandle };
		yield* this.drive(opened.session, input.message, ctx, opened.sessionHandle, runHandle);
	}

	/**
	 * 驱动一次 prompt 到边界：订阅 pi 事件流转 yield progress，prompt 的
	 * promise settle 后按最后一条 assistant 消息判定终态（pi SDK 语义：
	 * prompt() 在 agent_settled 后 resolve，含 auto-retry；LLM 错误不 reject，
	 * 而是 stopReason:"error" 的 assistant 消息；abort → stopReason:"aborted"）。
	 */
	private async *drive(
		session: AgentSession,
		message: string,
		ctx: InvocationContext,
		sessionHandle: string,
		runHandle: string,
		transientAttempt = 0,
		usageStart?: number,
	): AsyncIterable<AgentEvent> {
		const queue: AgentEvent[] = [];
		let wake: (() => void) | undefined;
		const push = (event: AgentEvent): void => {
			queue.push(event);
			wake?.();
		};
		const unsubscribe = session.subscribe((event) => {
			const progress = toProgress(event);
			if (progress) push(progress);
		});
		const onAbort = (): void => {
			void session.abort().catch(() => undefined);
		};
		ctx.signal?.addEventListener("abort", onAbort, { once: true });
		runningByRunHandle.set(runHandle, session);

		let promptError: unknown;
		let done = false;
		// 本次 Run 的用量聚合切片：worker 会话跨任务续接，只统计 prompt 之后
		// 新增的消息（含多轮工具循环的每一条 assistant）。
		const messageCountBefore = usageStart ?? session.messages.length;
		const promptPromise = session
			.prompt(message)
			.catch((err: unknown) => {
				promptError = err;
			})
			.finally(() => {
				done = true;
				wake?.();
			});
		try {
			for (;;) {
				while (queue.length > 0) yield queue.shift()!;
				if (done) break;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
			}
			await promptPromise;
		} finally {
			unsubscribe();
			ctx.signal?.removeEventListener("abort", onAbort);
			runningByRunHandle.delete(runHandle);
		}

		const base = { agentId: this.id, sessionHandle, runHandle };
		const last = lastAssistant(session);
		const usage = aggregateRunUsage(
			(session.messages as unknown as PiAssistantProjection[]).slice(messageCountBefore),
		);
		if (ctx.signal?.aborted || last?.stopReason === "aborted") {
			yield {
				type: "failed",
				result: {
					...base,
					status: "cancelled",
					errorCode: "cancelled",
					error: "任务已取消",
					recoverable: true,
					...(usage ? { usage } : {}),
				},
			};
			return;
		}
		if (promptError) {
			yield {
				type: "failed",
				result: {
					...base,
					status: "failed",
					errorCode: "prompt_error",
					error: errMessage(promptError),
					recoverable: true,
				},
			};
			return;
		}
		if (last?.stopReason === "error") {
			const error = last.errorMessage ?? "pi worker 执行失败";
			const cooldownMs = transientCooldownMs(error, this.opts.transientRecovery);
			const maxAttempts = this.opts.transientRecovery?.maxAttempts ?? 2;
			if (cooldownMs !== undefined && transientAttempt < maxAttempts) {
				yield {
					type: "progress",
					stage: "rate_limit_wait",
					message: `上游限流，保留当前任务与会话，${Math.ceil(cooldownMs / 1000)} 秒后自动继续（${transientAttempt + 1}/${maxAttempts}）`,
				};
				if (!(await waitForCooldown(cooldownMs, ctx.signal))) {
					yield { type: "failed", result: { ...base, status: "cancelled", errorCode: "cancelled", error: "任务已终止", recoverable: true, ...(usage ? { usage } : {}) } };
					return;
				}
				yield* this.drive(
					session,
					"刚才因上游限流中断。请从当前会话已有进度继续完成原任务，不要重复已经完成的检查或工具调用。",
					ctx,
					sessionHandle,
					runHandle,
					transientAttempt + 1,
					messageCountBefore,
				);
				return;
			}
			yield {
				type: "failed",
				result: {
					...base,
					status: "failed",
					errorCode: "worker_error",
					error,
					recoverable: true,
					...(usage ? { usage } : {}),
				},
			};
			return;
		}
		yield {
			type: "completed",
			result: {
				...base,
				status: "completed",
				content: assistantText(last),
				...(usage ? { usage } : {}),
			},
		};
	}

	/** v1 不上抛 HITL（interactionKinds 为空），Runtime 不会调到；防御性返回。 */
	async *respond(input: RespondInput, _ctx: InvocationContext): AsyncIterable<AgentEvent> {
		yield {
			type: "failed",
			result: {
				agentId: this.id,
				status: "failed",
				errorCode: "interaction_unsupported",
				error: "pi connector v1 不支持审批外送（respond）",
				recoverable: false,
				runHandle: input.runHandle,
			},
		};
	}

	async cancel(input: { runHandle: string }, _ctx: InvocationContext): Promise<void> {
		const session = runningByRunHandle.get(input.runHandle);
		if (session) await session.abort().catch(() => undefined);
	}

	/**
	 * pi 是进程内 SDK：detected/configured 恒 true（SDK 随 server 发布）；
	 * authenticated 看模型目录里有没有可用（凭证已配置）模型。
	 */
	async probe(_ctx: InvocationContext): Promise<ProbeResult> {
		let authenticated: boolean | "unknown" = "unknown";
		const issues: ProbeResult["issues"] = [];
		try {
			const rt = await modelRuntime();
			const available = await rt.getAvailable().catch(() => [] as unknown[]);
			authenticated = available.length > 0;
			if (!authenticated) {
				issues.push({
					code: "no_model",
					message: "pi 没有可用模型（未配置 Provider 凭证）",
					fixAction: "在「设置 → Providers」配置 API Key",
				});
			}
		} catch {
			authenticated = "unknown";
		}
		return {
			extensionInstalled: true,
			detected: true,
			configured: true,
			authenticated,
			enabled: true,
			compatibility: "supported",
			transport: "sdk",
			capabilities: PI_CAPABILITIES,
			issues,
		};
	}
}
