import type {
	AgentDriver,
	AgentEvent,
	ContinueInput,
	DriverCapabilities,
	InvocationContext,
	ProbeResult,
	RespondInput,
	RunInput,
} from "@puddingteams/pwcp/types";
import { gitBaseline, observeGitArtifacts } from "@puddingteams/pwcp/observe";
import { spawnWorker, type SpawnResult } from "@puddingteams/pwcp/spawn";
import { JsonlLineParser } from "@puddingteams/pwcp/jsonl-lines";
import { CodexEventReducer, CODEX_CAPABILITIES } from "../core/codex-normalize.js";

export interface CodexDriverOptions {
	/** 可执行文件名/路径（默认 "codex"）。 */
	command?: string;
	/** 模型（-m）；留空用 codex 默认。 */
	model?: string;
	/** 沙箱模式（-s），默认 workspace-write。 */
	sandbox?: "read-only" | "workspace-write" | "danger-full-access";
	/** 单次 run/continue 超时。 */
	timeoutMs?: number;
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
		return CODEX_CAPABILITIES;
	}

	private cmd(): string {
		return this.opts.command ?? "codex";
	}

	private runArgs(ctx: InvocationContext): string[] {
		const args = ["--json", "--skip-git-repo-check", "-C", ctx.cwd ?? process.cwd(), "-s", this.opts.sandbox ?? "workspace-write"];
		if (this.opts.model) args.push("-m", this.opts.model);
		return args;
	}

	/**
	 * resume 子命令的 options 是 exec 的子集：没有 -C/-s（工作目录由 spawn cwd
	 * 保证；沙箱经 -c 配置覆盖传同一值，避免 resume 掉回默认 read-only）。
	 */
	private resumeArgs(): string[] {
		const args = ["--json", "--skip-git-repo-check", "-c", `sandbox_mode="${this.opts.sandbox ?? "workspace-write"}"`];
		if (this.opts.model) args.push("-m", this.opts.model);
		return args;
	}

	/**
	 * 流式执行：onStdout 逐行归约（progress 实时外送），进程退出后取边界。
	 */
	private async runCli(args: string[], ctx: InvocationContext): Promise<AgentEvent> {
		const cwd = ctx.cwd ?? process.cwd();
		// §15.4：任务前 git 基线，完成后只收新增变更（防止脏工作区误报）。
		const baseline = await gitBaseline(cwd, ctx.env);
		const reducer = new CodexEventReducer();
		const parser = new JsonlLineParser();
		const feed = (chunk: string) => {
			for (const raw of parser.push(chunk)) {
				const progress = reducer.push(raw);
				if (progress) ctx.onUpdate?.(progress, { streaming: true });
			}
		};
		const res: SpawnResult = await spawnWorker({
			command: this.cmd(),
			args,
			env: ctx.env,
			cwd,
			signal: ctx.signal,
			timeoutMs: this.opts.timeoutMs ?? ctx.timeouts?.activeMs ?? 900_000,
			startupMs: ctx.timeouts?.startupMs ?? 30_000,
			onStdout: feed,
		});
		for (const raw of parser.flush()) reducer.push(raw);

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
					error: `worker「${this.cmd()}」在 ${Math.round((ctx.timeouts?.startupMs ?? 30_000) / 1000)}s 内未输出任何内容`,
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
					error: `无法启动 worker「${this.cmd()}」：${res.spawnError.message}`,
					recoverable: true,
				},
			};
		}
		if (res.exitCode !== 0) {
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
		if (boundary.type === "completed") {
			const observed = await observeGitArtifacts(cwd, ctx.env, baseline);
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
		yield await this.runCli(["exec", ...this.runArgs(ctx), input.message], ctx);
	}

	async *continue(input: ContinueInput, ctx: InvocationContext): AsyncIterable<AgentEvent> {
		ctx.onUpdate?.("worker 正在续接会话…", { running: true });
		yield { type: "started", sessionHandle: input.sessionHandle };
		yield await this.runCli(["exec", "resume", ...this.resumeArgs(), input.sessionHandle, input.message], ctx);
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
		sandbox: sandboxOf(config.sandbox),
	});
}
