import type {
	AgentDriver,
	AgentEvent,
	ContinueInput,
	DriverConfigOption,
	DriverCapabilities,
	InvocationContext,
	ProbeResult,
	RespondInput,
	RunInput,
} from "@puddingteams/pwcp/types";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { createInterface } from "node:readline";
import { gitBaseline, observeGitArtifacts } from "@puddingteams/pwcp/observe";
import { spawnWorker, type SpawnResult } from "@puddingteams/pwcp/spawn";
import { JsonlLineParser } from "@puddingteams/pwcp/jsonl-lines";
import { CodexEventReducer, CODEX_CAPABILITIES } from "../core/codex-normalize.js";

export interface CodexDriverOptions {
	/** 可执行文件名/路径（默认 "codex"）。 */
	command?: string;
	/** 模型（-m）；留空用 codex 默认。 */
	model?: string;
	effort?: string;
	/** 沙箱模式（-s），默认 workspace-write。 */
	sandbox?: "read-only" | "workspace-write" | "danger-full-access";
	/** 单次 run/continue 超时。 */
	timeoutMs?: number;
}

export function codexExecutionPolicyArgs(
	configuredSandbox: CodexDriverOptions["sandbox"],
	ctx: Pick<InvocationContext, "verificationProfile" | "workspaceBoundary" | "protectedCompile">,
): string[] {
	if (ctx.protectedCompile) {
		const channel = ctx.protectedCompile.modelChannel;
		if (channel && (!Number.isSafeInteger(channel.port) || channel.port < 1 || channel.port > 65535)) {
			throw new Error("invalid protected compile model channel");
		}
		return [
			// macOS sandbox-exec already encloses the entire native CLI process tree.
			// A second Codex workspace sandbox cannot be applied inside it, which
			// would prevent every compile tool call from running.
			"-s", "danger-full-access",
			"-c", 'approval_policy="never"',
			"--ignore-user-config", "--ignore-rules",
			...(channel ? [
				"-c", 'model_provider="puddingteams_compile"',
				"-c", 'model_providers.puddingteams_compile.name="PuddingTeams Compile"',
				"-c", `model_providers.puddingteams_compile.base_url="http://127.0.0.1:${channel.port}/v1"`,
				"-c", 'model_providers.puddingteams_compile.wire_api="responses"',
				"-c", "model_providers.puddingteams_compile.requires_openai_auth=false",
				"-c", "model_providers.puddingteams_compile.supports_websockets=false",
				"-c", "model_providers.puddingteams_compile.request_max_retries=0",
				"-c", "model_providers.puddingteams_compile.stream_max_retries=0",
			] : []),
		];
	}
	const sandbox = ctx.verificationProfile ? "workspace-write" : configuredSandbox ?? "workspace-write";
	if (ctx.workspaceBoundary === "platform_isolated_checkout" && sandbox === "workspace-write") return ["--approve-for-me"];
	return ["-s", sandbox];
}

/** 有界的 stderr 诊断摘要（截断 + 脱敏）。 */
function stderrSummary(stderr: string): string {
	if (!stderr.trim()) return "";
	const max = 400;
	let s = stderr.trim().slice(0, max);
	s = s.replace(/\b(?:token|sk-)[a-zA-Z0-9_\-\.]{6,}\b/gi, "[redacted]");
	s = s.replace(/\b(?:OPENAI_API_KEY|Authorization)\s*[:=]\s*"?[^\s"\]]+/gi, "$1=[redacted]");
	return `：${s}${stderr.length > max ? "…" : ""}`;
}

/**
 * Codex CLI Driver（§4/§8.1，spawn + JSONL 流式）。
 *
 * - run      → codex exec --json --skip-git-repo-check -C <cwd> -s <sandbox> [-m model] <message>
 * - continue → codex exec resume --json … <sessionHandle> <message>
 * - cancel   → 无上游取消命令，依赖 spawnWorker 的 SIGTERM→SIGKILL（no-op）
 * - respond  → 不支持：codex headless 没有跨进程审批（interactionKinds: []）
 *
 * prompt 走参数、stdin 立即 EOF（spawnWorker 保证）：stdin pipe 时 codex 会
 * 把内容追加为 <stdin> 块。sessionHandle = thread.started 的 thread_id；
 * runHandle 复用 thread_id（resume 以 thread 为单位）。
 */
export class CodexDriver implements AgentDriver {
	readonly id = "codex";

	constructor(private readonly opts: CodexDriverOptions = {}) {}

	async capabilities(): Promise<DriverCapabilities> {
		return {
			...CODEX_CAPABILITIES,
			workspace: {
				...CODEX_CAPABILITIES.workspace!,
				readOnlyEnforcement: this.opts.sandbox === "read-only" ? "sandbox" : "none",
			},
		};
	}

	private cmd(): string {
		return this.opts.command ?? "codex";
	}

	/**
	 * Read the account-aware picker catalog from Codex itself. This deliberately
	 * starts app-server only for discovery; task execution remains spawn + JSONL.
	 */
	async listConfigOptions(field: string, ctx: InvocationContext): Promise<DriverConfigOption[]> {
		if (ctx.protectedCompile) throw new Error("protected compile cannot run model discovery");
		if (field !== "model") return [];
		return new Promise((resolve, reject) => {
			const child = spawn(this.cmd(), ["app-server", "--stdio"], {
				cwd: ctx.cwd ?? process.cwd(),
				env: ctx.env,
				stdio: ["pipe", "pipe", "pipe"],
			});
			let settled = false;
			let stderr = "";
			let requestId = 1;
			const options: DriverConfigOption[] = [];
			const timer = setTimeout(() => finish(new Error("Codex model/list 超时")), 15_000);
			const lines = createInterface({ input: child.stdout });
			const send = (payload: unknown) => child.stdin.write(`${JSON.stringify(payload)}\n`);
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				lines.close();
				child.stdin.end();
				child.kill();
				if (error) reject(error);
				else resolve(options);
			};
			const requestPage = (cursor?: string | null) => {
				requestId += 1;
				send({ method: "model/list", id: requestId, params: { cursor: cursor ?? null, limit: 100, includeHidden: false } });
			};

			child.stderr.on("data", (chunk: Buffer) => {
				if (stderr.length < 4_000) stderr += chunk.toString("utf8");
			});
			child.on("error", (error) => finish(error));
			child.on("exit", (code) => {
				if (!settled) finish(new Error(`Codex app-server 提前退出（${code ?? "unknown"}）${stderrSummary(stderr)}`));
			});
			lines.on("line", (line) => {
				if (!line.trim() || settled) return;
				let message: {
					id?: number;
					result?: { data?: Array<{ id?: string; model?: string; displayName?: string; description?: string; isDefault?: boolean; supportedReasoningEfforts?: Array<{ reasoningEffort: string }> }>; nextCursor?: string | null };
					error?: { message?: string };
				};
				try {
					message = JSON.parse(line) as typeof message;
				} catch {
					return;
				}
				if (message.error) {
					finish(new Error(message.error.message || "Codex model/list 失败"));
					return;
				}
				if (message.id === 1) {
					send({ method: "initialized" });
					requestPage();
					return;
				}
				if (message.id !== requestId || !message.result) return;
				for (const model of message.result.data ?? []) {
					const value = model.model?.trim() || model.id?.trim();
					if (!value || options.some((option) => option.value === value)) continue;
					options.push({
						value,
						label: model.displayName?.trim() || value,
						description: model.description?.trim() || undefined,
						isDefault: model.isDefault === true,
						...(model.supportedReasoningEfforts ? { effortLevels: model.supportedReasoningEfforts.map((item) => item.reasoningEffort) } : {}),
					});
				}
				if (message.result.nextCursor) requestPage(message.result.nextCursor);
				else finish();
			});
			send({
				method: "initialize",
				id: 1,
				params: {
					clientInfo: { name: "puddingteams", title: "PuddingTeams", version: "1.0.0" },
					capabilities: { experimentalApi: false, requestAttestation: false },
				},
			});
		});
	}

	private executionPolicyArgs(ctx: InvocationContext): string[] {
		// Verification profiles are platform-bound and must never inherit a user's
		// danger-full-access Agent setting. Codex workspace-write is the executable
		// Connector-side half of the isolated-copy/mutation-guard profile.
		// Codex workspace-write deliberately protects .git. A platform-created
		// isolated checkout is the one boundary where git metadata must be writable;
		// --approve-for-me keeps workspace-write and routes that protected command
		// through Codex's command-level automatic reviewer. Never use this signal for
		// the user's target checkout and never fall back to danger-full-access.
		return codexExecutionPolicyArgs(this.opts.sandbox, ctx);
	}

	private runArgs(ctx: InvocationContext, settings?: import("@puddingteams/pwcp/types").RuntimeModelSettings): string[] {
		const args = ["--json", "--skip-git-repo-check", "-C", ctx.cwd ?? process.cwd(), ...this.executionPolicyArgs(ctx)];
		const model = settings?.model ?? this.opts.model;
		const effort = settings?.effort ?? this.opts.effort;
		if (model) args.push("-m", model);
		if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
		return args;
	}

	/**
	 * resume 子命令的 options 是 exec 的子集：没有 -C/-s（工作目录由 spawn cwd
	 * 保证；沙箱经 -c 配置覆盖传同一值，避免 resume 掉回默认 read-only）。
	 */
	private resumeArgs(settings?: import("@puddingteams/pwcp/types").RuntimeModelSettings): string[] {
		const args = ["--json", "--skip-git-repo-check"];
		const model = settings?.model ?? this.opts.model;
		const effort = settings?.effort ?? this.opts.effort;
		if (model) args.push("-m", model);
		if (effort) args.push("-c", `model_reasoning_effort=${JSON.stringify(effort)}`);
		return args;
	}

	/**
	 * 流式执行：onStdout 逐行归约（progress 实时外送），进程退出后取边界。
	 */
	private async runCli(args: string[], ctx: InvocationContext): Promise<AgentEvent> {
		const cwd = ctx.cwd ?? process.cwd();
		const protectedCompile = ctx.protectedCompile;
		if (protectedCompile) {
			if (this.opts.command) throw new Error("protected compile cannot use an Agent-configured command");
			if (protectedCompile.modelChannel && !this.opts.model) throw new Error("protected compile model channel requires a frozen model");
			if (!protectedCompile.jobId || await realpath(cwd) !== protectedCompile.stagingRoot) throw new Error("protected compile staging identity changed");
			if (protectedCompile.commandPath.startsWith(`${protectedCompile.stagingRoot}${sep}`) || protectedCompile.sandboxProfilePath.startsWith(`${protectedCompile.stagingRoot}${sep}`)) {
				throw new Error("protected compile command and profile must be outside writable staging");
			}
		}
		const command = protectedCompile?.commandPath ?? this.cmd();
		const env = protectedCompile?.env ?? ctx.env;
		// §15.4：任务前 git 基线，完成后只收新增变更（防止脏工作区误报）。
		// A protected compile cannot launch an unsandboxed Git process from a
		// Connector observe hook; its output is validated from staging instead.
		const baseline = protectedCompile ? undefined : await gitBaseline(cwd, env);
		const reducer = new CodexEventReducer();
		const parser = new JsonlLineParser();
		const feedRaw = (raw: unknown) => {
			const projected = reducer.pushWithActivity(raw);
			if (projected.activity) {
				ctx.onUpdate?.(projected.progress ?? projected.activity.title, { streaming: true, activity: projected.activity });
			} else if (projected.progress) {
				ctx.onUpdate?.(projected.progress, { streaming: true });
			}
		};
		const feed = (chunk: string) => {
			for (const raw of parser.push(chunk)) {
				feedRaw(raw);
			}
		};
		const res: SpawnResult = await spawnWorker({
			command,
			args,
			env,
			cwd,
			...(protectedCompile ? { protectedProcess: protectedCompile } : {}),
			signal: ctx.signal,
			timeoutMs: this.opts.timeoutMs ?? ctx.timeouts?.activeMs ?? 900_000,
			startupMs: ctx.timeouts?.startupMs ?? 30_000,
			onStdout: feed,
		});
		for (const raw of parser.flush()) feedRaw(raw);
		if (res.outputLimitExceeded) {
			return {
				type: "failed",
				result: { agentId: this.id, status: "failed", errorCode: "output_limit", error: "worker stdout 超出上限", recoverable: false },
			};
		}

		if (res.timedOut) {
			return {
				type: "failed",
				result: {
					agentId: this.id,
					status: "failed",
					errorCode: "timeout",
					error: `worker 超时（${Math.round((this.opts.timeoutMs ?? ctx.timeouts?.activeMs ?? 900_000) / 1000)}s）`,
					recoverable: false,
				},
			};
		}
		if (res.killed) {
			return {
				type: "failed",
				result: { agentId: this.id, status: "cancelled", errorCode: "cancelled", error: "任务已取消", recoverable: true },
			};
		}
		if (res.startupTimedOut && !res.stdout.trim()) {
			return {
				type: "failed",
				result: {
					agentId: this.id,
					status: "failed",
					errorCode: "startup_timeout",
					error: `worker 在 ${Math.round((ctx.timeouts?.startupMs ?? 30_000) / 1000)}s 内未输出任何内容`,
					recoverable: false,
				},
			};
		}
		if (res.exitCode === -1 && res.spawnError) {
			return {
				type: "failed",
				result: {
					agentId: this.id,
					status: "failed",
					errorCode: "spawn_error",
					error: `无法启动 worker：${res.spawnError.message}`,
					recoverable: true,
				},
			};
		}
		if (res.exitCode !== 0) {
			// Codex can emit the actual API failure in JSONL while stderr only says
			// "Reading additional input from stdin...". Keep the structured cause.
			const reported = reducer.boundary(this.id);
			if (reported.type === "failed" && reported.result.errorCode === "worker_failed") return reported;
			return {
				type: "failed",
				result: {
					agentId: this.id,
					status: "failed",
					errorCode: "worker_failed",
					error: `codex 退出码 ${res.exitCode}${stderrSummary(res.stderr)}`,
					// 退出码 2 是 CLI 参数/用法错误，重试多少次都一样（E2E 实测
					// manager 曾对同一用法错误重试 25 次）。
					recoverable: res.exitCode !== 2,
				},
			};
		}

		const boundary = reducer.boundary(this.id);
		// §15.4 observe 轨：completed 时对比任务前基线，只收新增变更。
		if (boundary.type === "completed" && baseline) {
			const observed = await observeGitArtifacts(cwd, env, baseline);
			if (observed.length) {
				boundary.result.artifacts = [...(boundary.result.artifacts ?? []), ...observed];
			}
		}
		ctx.onUpdate?.("worker 执行完成", { exitCode: res.exitCode });
		return boundary;
	}

	async *run(input: RunInput, ctx: InvocationContext): AsyncIterable<AgentEvent> {
		ctx.onUpdate?.("worker 正在执行…", { running: true });
		yield { type: "started" };
		yield await this.runCli(["exec", ...this.runArgs(ctx, input.options?.runtimeModel), input.message], ctx);
	}

	async *continue(input: ContinueInput, ctx: InvocationContext): AsyncIterable<AgentEvent> {
		ctx.onUpdate?.("worker 正在续接会话…", { running: true });
		yield { type: "started", sessionHandle: input.sessionHandle };
		yield await this.runCli(["exec", ...this.executionPolicyArgs(ctx), "resume", ...this.resumeArgs(input.options?.runtimeModel), input.sessionHandle, input.message], ctx);
	}

	async *respond(input: RespondInput, _ctx: InvocationContext): AsyncIterable<AgentEvent> {
		// 防御性失败：capabilities 不声明 respond，Runtime 正常不会路由到这里。
		yield {
			type: "failed",
			result: {
				agentId: this.id,
				status: "failed",
				runHandle: input.runHandle,
				errorCode: "interaction_unsupported",
				error: "Codex headless 不支持跨进程审批（无 respond 能力）",
				recoverable: false,
			},
		};
	}

	async cancel(_input: { runHandle: string }, _ctx: InvocationContext): Promise<void> {
		// 无上游取消命令；运行时取消经 AbortSignal → SIGTERM→SIGKILL。
	}

	async probe(ctx: InvocationContext): Promise<ProbeResult> {
		if (ctx.protectedCompile) throw new Error("protected compile cannot run Connector probe");
		const res = await spawnWorker({
			command: this.cmd(),
			args: ["--version"],
			env: ctx.env,
			timeoutMs: 15_000,
		});
		const detected = res.exitCode !== -1 && !res.spawnError;
		const versionMatch = res.stdout.trim().match(/(\d+\.\d+\.\d+)/);
		return {
			extensionInstalled: true,
			extensionVersion: undefined,
			detected,
			configured: detected,
			authenticated: "unknown",
			enabled: true,
			compatibility: detected ? "supported" : "unknown",
			upstreamVersion: versionMatch?.[1],
			version: undefined,
			transport: "spawn",
			capabilities: CODEX_CAPABILITIES,
			issues: detected
				? []
				: [{ code: "not_detected", message: "Codex CLI 未检测到", fixAction: "安装 Codex CLI（npm i -g @openai/codex）并完成 codex login" }],
		};
	}
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sandboxOf(value: unknown): CodexDriverOptions["sandbox"] {
	return value === "read-only" || value === "workspace-write" || value === "danger-full-access" ? value : undefined;
}

/**
 * Driver 工厂（Driver SPI 入口）：同一 Connector 多 Agent 实例（§9.3.7），
 * 每实例一份 config。ExtensionRegistry 加载 entry 时识别此导出。
 */
export function createDriver(config: Record<string, unknown>): AgentDriver {
	return new CodexDriver({
		command: str(config.command),
		model: str(config.model),
		effort: str(config.effort),
		sandbox: sandboxOf(config.sandbox),
	});
}
