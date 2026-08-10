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
import { normalizePuddingClawJson, PUDDINGCLAW_CAPABILITIES } from "./normalize.js";
import { handoffDirFor, handoffRelativePath } from "./handoff.js";
import { spawnWorker } from "./transport/spawn.js";

export interface PuddingClawDriverOptions {
	/** Executable name/path (default "puddingclaw"). */
	command?: string;
	/** Working directory for the child process (workspace root). */
	cwd?: string;
	/** Timeout for one run/continue/respond invocation. */
	timeoutMs?: number;
	/**
	 * Continuation token used to resume an interrupted Run via `respond`.
	 * Never logged; only placed into the machine-readable stdin JSON.
	 */
	continuationToken?: string;
}

/** 有界的 stderr 诊断摘要（§8.1）：截断 + 脱敏 token 形字符串。 */
function stderrSummary(stderr: string): string {
	if (!stderr.trim()) return "";
	const max = 400;
	let s = stderr.trim().slice(0, max);
	// 脱敏形如 token/sk-.../Bearer ... 的敏感片段，绝不进模型上下文。
	s = s.replace(/\b(?:token|sk-)[a-zA-Z0-9_\-\.]{6,}\b/gi, "[redacted]");
	s = s.replace(/\b(?:PUDDINGCLAW_TOKEN|Authorization)\s*[:=]\s*"?[^\s"\]]+/gi, "$1=[redacted]");
	return `：${s}${stderr.length > max ? "…" : ""}`;
}

/**
 * First-party PuddingClaw Driver (§5).
 *
 * - run         → puddingclaw run --input-json - --json [--export <handoffDir>]
 * - continue    → same, plus {session_id}
 * - respond     → puddingclaw respond <run_id> --input-json - --json [--export …]
 *                  {continuation_token, request_id, decisions}
 * - cancel      → puddingclaw cancel <run_id> (best-effort; the CLI may not
 *                  have a public cancel yet, so absence degrades to SIGTERM)
 *
 * --export 目录按 §15.3 约定生成为 <cwd>/.pudding/handoff/<delegationId>/
 * （delegationId 由 Runtime 经 InvocationContext 注入）。
 *
 * The CLI's stdout carries a single JSON boundary in phase 1 (§8.2); a future
 * JSONL endpoint flows through the same normalize path per line.
 */
export class PuddingClawDriver implements AgentDriver {
	readonly id = "puddingclaw";

	constructor(private readonly opts: PuddingClawDriverOptions = {}) {}

	async capabilities(): Promise<DriverCapabilities> {
		return PUDDINGCLAW_CAPABILITIES;
	}

	private cmd(): string {
		return this.opts.command ?? "puddingclaw";
	}

	private ctxCwd(ctx: InvocationContext): string {
		return ctx.cwd ?? this.opts.cwd ?? process.cwd();
	}

	/**
	 * §15.3/§15.7：导出路径由 Driver 按约定生成并传入 CLI（CLI 不知道平台
	 * 目录结构）。没有 delegationId（如 probe/cancel）就不导出。
	 */
	private exportArgs(ctx: InvocationContext): string[] {
		if (!ctx.delegationId) return [];
		return ["--export", handoffDirFor(this.ctxCwd(ctx), ctx.delegationId)];
	}

	/**
	 * normalize 给出的 artifact.path 是导出目录相对路径（exported_path）；
	 * 这里改写成 workspace 相对路径（.pudding/handoff/<delegationId>/…），
	 * 登记与接力文本引用统一用 workspace 相对路径。
	 */
	private withHandoffPaths(event: AgentEvent, ctx: InvocationContext): AgentEvent {
		if (event.type !== "completed" || !ctx.delegationId || !event.result.artifacts?.length) return event;
		const delegationId = ctx.delegationId;
		return {
			...event,
			result: {
				...event.result,
				artifacts: event.result.artifacts.map((a) => ({ ...a, path: handoffRelativePath(delegationId, a.path) })),
			},
		};
	}

	private async runCli(
		args: string[],
		stdin: unknown,
		ctx: InvocationContext,
	): Promise<AgentEvent> {
		const res = await spawnWorker({
			command: this.cmd(),
			args,
			env: ctx.env,
			cwd: this.ctxCwd(ctx),
			signal: ctx.signal,
			timeoutMs: this.opts.timeoutMs ?? ctx.timeouts?.activeMs ?? 900_000,
			startupMs: ctx.timeouts?.startupMs ?? 30_000,
			stdinJson: stdin,
		});
		if (res.timedOut) {
			return {
				type: "failed",
				result: {
					agentId: this.id,
					status: "failed",
					errorCode: "timeout",
					error: `worker 超时（${Math.round((this.opts.timeoutMs ?? 900_000) / 1000)}s）`,
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
		// M1：启动超时（30s 内没有任何 stdout）且无输出时，判启动失败而不是干等到
		// 活跃超时（§8.3 启动超时）。
		if (res.startupTimedOut && !res.stdout.trim() && res.lines.length === 0) {
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

		const lastLine = res.lines.length > 0 ? res.lines[res.lines.length - 1] : undefined;
		if (lastLine !== undefined) {
			const event = normalizePuddingClawJson(lastLine);
			ctx.onUpdate?.("worker 执行完成", { exitCode: res.exitCode });
			return this.withHandoffPaths(event, ctx);
		}
		// Fall back to the accumulated stdout as a single JSON.
		if (res.stdout.trim()) {
			let raw: unknown;
			try {
				raw = JSON.parse(res.stdout.trim());
			} catch {
				raw = undefined;
			}
			if (raw !== undefined) return this.withHandoffPaths(normalizePuddingClawJson(raw), ctx);
		}
		return {
			type: "failed",
			result: {
				agentId: this.id,
				status: "failed",
				errorCode: "protocol_error",
				// M2：stderr 只取有界摘要（§8.1），并脱敏 token 形字符串，避免敏感
				// 诊断进入模型上下文/JSONL。
				error: `worker「${this.cmd()}」返回非 JSON 输出${stderrSummary(res.stderr)}`,
				recoverable: false,
			},
		};
	}

	async *run(input: RunInput, ctx: InvocationContext): AsyncIterable<AgentEvent> {
		ctx.onUpdate?.("worker 正在执行…", { running: true });
		yield {
			type: "started",
		};
		yield await this.runCli(
			["run", "--input-json", "-", "--json", ...this.exportArgs(ctx)],
			{ message: input.message, request_id: input.requestId, ...(input.options ?? {}) },
			ctx,
		);
	}

	async *continue(input: ContinueInput, ctx: InvocationContext): AsyncIterable<AgentEvent> {
		ctx.onUpdate?.("worker 正在续接会话…", { running: true });
		yield { type: "started", sessionHandle: input.sessionHandle };
		yield await this.runCli(
			["run", "--input-json", "-", "--json", ...this.exportArgs(ctx)],
			{ message: input.message, session_id: input.sessionHandle, request_id: input.requestId, ...(input.options ?? {}) },
			ctx,
		);
	}

	async *respond(input: RespondInput, ctx: InvocationContext): AsyncIterable<AgentEvent> {
		// continuation token 由 Runtime 从 InteractionSecretStore 解密后经
		// ctx.providerState 注入，永不出现在 tool result / JSONL / 浏览器。
		const state = (ctx.providerState ?? {}) as Record<string, unknown>;
		const token = typeof state.continuation_token === "string"
			? state.continuation_token
			: this.opts.continuationToken;
		if (!token) {
			yield {
				type: "failed",
				result: {
					agentId: this.id,
					status: "failed",
					errorCode: "interaction_unsupported",
					error: "PuddingClaw respond 需要 continuation token；当前未提供",
					recoverable: false,
				},
			};
			return;
		}
		ctx.onUpdate?.("正在提交审批…", { running: true });
		yield { type: "started", runHandle: input.runHandle };
		yield await this.runCli(
			["respond", input.runHandle, "--input-json", "-", "--json", ...this.exportArgs(ctx)],
			{
				continuation_token: token,
				request_id: input.requestId,
				decisions: input.responses.map((r) => ({
					request_id: r.requestId,
					decision: r.action,
					...(r.scope ? { scope: r.scope } : {}),
					...(r.value !== undefined ? { value: r.value } : {}),
				})),
			},
			ctx,
		);
	}

	async cancel(input: { runHandle: string }, ctx: InvocationContext): Promise<void> {
		try {
			await spawnWorker({
				command: this.cmd(),
				args: ["cancel", input.runHandle, "--json"],
				env: ctx.env,
				cwd: this.ctxCwd(ctx),
				signal: ctx.signal,
				timeoutMs: 10_000,
			});
		} catch {
			// best-effort: absence of a public cancel degrades to SIGTERM
		}
	}

	async probe(ctx: InvocationContext): Promise<ProbeResult> {
		const res = await spawnWorker({
			command: this.cmd(),
			args: ["doctor", "--json"],
			env: ctx.env,
			cwd: this.ctxCwd(ctx),
			timeoutMs: 15_000,
		});
		let detected = res.exitCode !== -1;
		let configured = res.exitCode === 0;
		let authenticated: boolean | "unknown" = "unknown";
		let upstreamVersion: string | undefined;
		if (res.stdout.trim()) {
			try {
				const raw = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
				configured = raw.configured === true;
				authenticated = raw.authenticated === true ? true : raw.authenticated === false ? false : "unknown";
				detected = detected || raw.cli_version !== undefined;
				upstreamVersion = typeof raw.server_version === "string" ? raw.server_version : undefined;
			} catch {
				// ignore
			}
		}
		return {
			extensionInstalled: true,
			extensionVersion: undefined,
			detected,
			configured,
			authenticated,
			enabled: true,
			compatibility: detected ? "supported" : "unknown",
			upstreamVersion,
			version: undefined,
			transport: "spawn",
			capabilities: PUDDINGCLAW_CAPABILITIES,
			issues: configured
				? []
				: [{ code: "not_configured", message: "PuddingClaw CLI 未检测到或未配置", fixAction: "运行 puddingclaw doctor --json" }],
		};
	}
}
