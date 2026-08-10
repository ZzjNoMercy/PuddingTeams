import { randomUUID } from "node:crypto";
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
import { ClaudeCodeEventReducer, CLAUDE_CODE_CAPABILITIES } from "../core/claude-code-normalize.js";

export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface ClaudeCodeDriverOptions {
	/** 可执行文件名/路径（默认 "claude"）。 */
	command?: string;
	/** 模型（--model）；留空用 claude 默认。 */
	model?: string;
	/**
	 * 权限模式（--permission-mode）。房间 worker 无人值守，默认
	 * bypassPermissions；该模式绕过 Claude 自身权限确认，cwd 不是强制沙箱。
	 */
	permissionMode?: ClaudePermissionMode;
	/** 追加系统提示（--append-system-prompt）。 */
	systemPrompt?: string;
	/** 工具白名单（--allowedTools），如 "Bash(git *) Edit"。 */
	allowedTools?: string;
	/** 单次 run/continue 超时。 */
	timeoutMs?: number;
}

/** 有界的 stderr 诊断摘要（截断 + 脱敏）。 */
function stderrSummary(stderr: string): string {
	if (!stderr.trim()) return "";
	const max = 400;
	let s = stderr.trim().slice(0, max);
	s = s.replace(/\b(?:token|sk-)[a-zA-Z0-9_\-\.]{6,}\b/gi, "[redacted]");
	s = s.replace(/\b(?:ANTHROPIC_API_KEY|Authorization)\s*[:=]\s*"?[^\s"\]]+/gi, "$1=[redacted]");
	return `：${s}${stderr.length > max ? "…" : ""}`;
}

/**
 * Claude Code CLI Driver（§4/§8.1，spawn + stream-json 流式）。
 *
 * - run      → claude -p <message> --output-format stream-json --verbose
 *              --session-id <uuid> [options]   （sessionHandle 由 Driver 生成）
 * - continue → claude -p <message> … --resume <sessionHandle> [options]
 * - cancel   → 无上游取消命令，依赖 spawnWorker 的 SIGTERM→SIGKILL（no-op）
 * - respond  → 不支持：headless -p 没有跨进程审批（interactionKinds: []）
 *
 * stream-json 必须配 --verbose（CLI 约束）。边界以 result 事件为准；
 * 进程退出码非零或缺 result 事件都归一为可解释 failed。
 */
export class ClaudeCodeDriver implements AgentDriver {
	readonly id = "claude-code";

	constructor(private readonly opts: ClaudeCodeDriverOptions = {}) {}

	async capabilities(): Promise<DriverCapabilities> {
		return CLAUDE_CODE_CAPABILITIES;
	}

	private cmd(): string {
		return this.opts.command ?? "claude";
	}

	private optionArgs(): string[] {
		const args = ["--output-format", "stream-json", "--verbose", "--permission-mode", this.opts.permissionMode ?? "bypassPermissions"];
		if (this.opts.model) args.push("--model", this.opts.model);
		if (this.opts.systemPrompt) args.push("--append-system-prompt", this.opts.systemPrompt);
		if (this.opts.allowedTools) args.push("--allowedTools", this.opts.allowedTools);
		return args;
	}

	private async runCli(args: string[], ctx: InvocationContext): Promise<AgentEvent> {
		const cwd = ctx.cwd ?? process.cwd();
		// §15.4：任务前 git 基线，完成后只收新增变更（防止脏工作区误报）。
		const baseline = await gitBaseline(cwd, ctx.env);
		const reducer = new ClaudeCodeEventReducer();
		const parser = new JsonlLineParser();
		const res: SpawnResult = await spawnWorker({
			command: this.cmd(),
			args,
			env: ctx.env,
			cwd,
			signal: ctx.signal,
			timeoutMs: this.opts.timeoutMs ?? ctx.timeouts?.activeMs ?? 900_000,
			startupMs: ctx.timeouts?.startupMs ?? 30_000,
			onStdout: (chunk) => {
				for (const raw of parser.push(chunk)) {
					const progress = reducer.push(raw);
					if (progress) ctx.onUpdate?.(progress, { streaming: true });
				}
			},
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

		const boundary = reducer.boundary(this.id);
		if (!boundary || res.exitCode !== 0) {
			return {
				type: "failed",
				result: {
					agentId: this.id,
					status: "failed",
					errorCode: res.exitCode === 0 ? "protocol_error" : "worker_failed",
					error: `claude 退出码 ${res.exitCode}，未收到 result 边界事件${stderrSummary(res.stderr)}`,
					// 退出码 2 是 CLI 参数/用法错误，重试无意义。
					recoverable: res.exitCode !== 2,
				},
			};
		}

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
		// sessionHandle 由 Driver 生成（--session-id），boundary 的 init/result
		// 事件会带回同一个 id 作交叉验证。
		const sessionId = randomUUID();
		yield { type: "started", sessionHandle: sessionId };
		yield await this.runCli(["-p", input.message, ...this.optionArgs(), "--session-id", sessionId], ctx);
	}

	async *continue(input: ContinueInput, ctx: InvocationContext): AsyncIterable<AgentEvent> {
		ctx.onUpdate?.("worker 正在续接会话…", { running: true });
		yield { type: "started", sessionHandle: input.sessionHandle };
		yield await this.runCli(["-p", input.message, ...this.optionArgs(), "--resume", input.sessionHandle], ctx);
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
				error: "Claude Code headless 不支持跨进程审批（无 respond 能力）",
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
			capabilities: CLAUDE_CODE_CAPABILITIES,
			issues: detected
				? []
				: [{ code: "not_detected", message: "Claude Code CLI 未检测到", fixAction: "安装 Claude Code 并完成 claude 登录" }],
		};
	}
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const PERMISSION_MODES: ClaudePermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

function permissionModeOf(value: unknown): ClaudePermissionMode | undefined {
	return typeof value === "string" && (PERMISSION_MODES as string[]).includes(value) ? (value as ClaudePermissionMode) : undefined;
}

/**
 * Driver 工厂（Driver SPI 入口）：同一 Connector 多 Agent 实例（§9.3.7），
 * 每实例一份 config。ExtensionRegistry 加载 entry 时识别此导出。
 */
export function createDriver(config: Record<string, unknown>): AgentDriver {
	return new ClaudeCodeDriver({
		command: str(config.command),
		model: str(config.model),
		permissionMode: permissionModeOf(config.permissionMode),
		systemPrompt: str(config.systemPrompt),
		allowedTools: str(config.allowedTools),
	});
}
