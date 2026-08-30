import type {
	AgentDriver,
	AgentEvent,
	ContinueInput,
	DriverCapabilities,
	InvocationContext,
	ProbeResult,
	RespondInput,
	RunInput,
	WorkerActivity,
} from "./types.js";
import { HttpJsonlError, streamHttpJsonl } from "@puddingteams/pwcp/http-jsonl";
import { normalizePuddingClawJson, PUDDINGCLAW_CAPABILITIES } from "./normalize.js";
import { handoffDirFor, handoffRelativePath } from "./handoff.js";
import { spawnWorker } from "./transport/spawn.js";

export interface PuddingClawDriverOptions {
	/** Concrete transport selected by the Agent Connector binding. */
	transport?: "spawn" | "http";
	/** Executable name/path (default "puddingclaw"). */
	command?: string;
	/** PuddingClaw Backend origin for direct Headless HTTP calls. */
	endpoint?: string;
	/** Working directory for the child process (workspace root). */
	cwd?: string;
	/** Timeout for one run/continue/respond invocation. */
	timeoutMs?: number;
	/**
	 * Continuation token used to resume an interrupted Run via `respond`.
	 * Never logged; only placed into the machine-readable stdin JSON.
	 */
	continuationToken?: string;
	/**
	 * A long synchronous Headless request can be completed by PuddingClaw after
	 * an intermediary has already closed the HTTP connection.  Re-submit the
	 * same request_id for this long to recover the idempotent terminal result.
	 */
	connectionRecoveryMs?: number;
	/** Minimum first-attempt age before a connection_error is treated as a lost response. */
	connectionRecoveryMinAgeMs?: number;
	/** Poll interval while the same request_id is still running upstream. */
	connectionRecoveryIntervalMs?: number;
}

/** 有界的 stderr 诊断摘要（§8.1）：截断 + 脱敏 token 形字符串。 */
function stderrSummary(stderr: string): string {
	if (!stderr.trim()) return "";
	const max = 400;
	let s = stderr.trim().slice(0, max);
	// 脱敏形如 token/sk-.../Bearer ... 的敏感片段，绝不进模型上下文。
	s = s.replace(/\b(?:token|sk-)[a-zA-Z0-9_\-\.]{6,}\b/gi, "[redacted]");
	s = s.replace(/\bAuthorization\s*[:=]\s*"?[^\s"\]]+/gi, "Authorization=[redacted]");
	return `：${s}${stderr.length > max ? "…" : ""}`;
}

export function projectPuddingClawActivity(line: unknown): { label: string; activity: WorkerActivity } | undefined {
	if (!line || typeof line !== "object") return undefined;
	const envelope = line as Record<string, unknown>;
	const name = typeof envelope.event === "string" ? envelope.event : "";
	if (!name || name === "result") return undefined;
	const data = envelope.data && typeof envelope.data === "object" ? envelope.data as Record<string, unknown> : {};
	const tool = firstText(data.tool, data.tool_name) || "工具";
	const itemId = firstText(data.tool_call_id, data.call_id, data.response_id, data.run_id);
	const sourceSeq = typeof envelope.seq === "number" ? envelope.seq : typeof data.seq === "number" ? data.seq : undefined;
	const content = firstText(data.content, data.text, data.message, data.prompt, data.final_response);
	const input = data.input ?? data.arguments ?? data.params;
	const output = data.output ?? data.result;
	const isError = data.is_error === true || data.error === true || typeof data.error === "string";
	const common = (
		kind: WorkerActivity["kind"],
		status: WorkerActivity["status"],
		title: string,
		body?: string,
		metadata?: Record<string, unknown>,
	): { label: string; activity: WorkerActivity } => ({
		label: title,
		activity: {
			source: "puddingclaw",
			sourceEvent: name,
			kind,
			status,
			title,
			...(body ? { content: truncateActivity(body, 16_000) } : {}),
			...(itemId ? { itemId } : {}),
			...(sourceSeq !== undefined ? { sourceSeq } : {}),
			...(metadata ? { metadata } : {}),
		},
	});

	switch (name) {
		case "run_starting":
			return common("lifecycle", "started", "PuddingClaw 正在启动");
		case "task_preflight_started":
			return common("lifecycle", "started", "正在准备任务上下文");
		case "task_preflight_completed":
			return common("lifecycle", "completed", "任务上下文已准备");
		case "run_started":
			return common("lifecycle", "started", "PuddingClaw Run 已开始", undefined, simpleFacts(data, ["run_id", "session_id", "project_id"]));
		case "run_outcome":
			return common("lifecycle", isError ? "failed" : "updated", "PuddingClaw Run 结果已更新", content || safeActivityStringify(data.outcome), simpleFacts(data, ["outcome", "status"]));
		case "goal_run_continued":
			return common("lifecycle", "updated", "目标继续执行", content);
		case "new_response":
			return common("assistant", "started", "开始生成新回复");
		case "token":
			return common("assistant", "running", "正在生成回复", content);
		case "segment_break":
			return common("assistant", "updated", "回复进入下一分段");
		case "segment_content_replaced":
			return common("assistant", "updated", "回复分段已替换", content);
		case "tool_start":
			return common("tool", "started", `开始执行：${tool}`, safeActivityStringify(input), { tool });
		case "tool_end":
			return common("tool", isError ? "failed" : "completed", `${isError ? "执行失败" : "执行完成"}：${tool}`, safeActivityStringify(data.error ?? output), { tool, isError });
		case "permission_required":
			return common("approval", "waiting", "等待人工审批", content || safeActivityStringify(data.requests), simpleFacts(data, ["run_id", "request_id"]));
		case "permission_resolved":
			return common("approval", "resolved", "人工审批已处理", content, simpleFacts(data, ["request_id", "decision", "scope"]));
		case "final_response":
			return common("assistant", "completed", "PuddingClaw 最终回复", content);
		case "done":
			return common("lifecycle", "completed", "PuddingClaw 已完成");
		case "error":
			return common("error", "failed", "PuddingClaw 执行错误", content || safeActivityStringify(data.error));
		case "stream_reset_required":
			return common("error", "failed", "上游事件历史需要重新同步", safeActivityStringify(data));
		default:
			return undefined;
	}
}

/**
 * Collapse transport-level token deltas before they reach the platform
 * timeline. Semantic events remain one-to-one; a consecutive token run becomes
 * one bounded `token.batch` activity with diagnostic count/source-seq range.
 */
export function createPuddingClawActivityObserver(
	emit: (projected: { label: string; activity: WorkerActivity }) => void,
): { push: (line: unknown) => void; flush: () => void } {
	let tokenContent = "";
	let tokenCount = 0;
	let tokenItemId: string | undefined;
	let sourceSeqStart: number | undefined;
	let sourceSeqEnd: number | undefined;

	const flush = () => {
		if (tokenCount === 0) return;
		emit({
			label: "回复内容已生成",
			activity: {
				source: "puddingclaw",
				sourceEvent: "token.batch",
				kind: "assistant",
				status: "updated",
				title: "回复内容片段",
				...(tokenContent ? { content: tokenContent } : {}),
				...(tokenItemId ? { itemId: tokenItemId } : {}),
				...(sourceSeqEnd !== undefined ? { sourceSeq: sourceSeqEnd } : {}),
				metadata: {
					tokenEventCount: tokenCount,
					...(sourceSeqStart !== undefined ? { sourceSeqStart } : {}),
					...(sourceSeqEnd !== undefined ? { sourceSeqEnd } : {}),
				},
			},
		});
		tokenContent = "";
		tokenCount = 0;
		tokenItemId = undefined;
		sourceSeqStart = undefined;
		sourceSeqEnd = undefined;
	};

	return {
		push: (line) => {
			const projected = projectPuddingClawActivity(line);
			if (projected?.activity.sourceEvent === "token") {
				const nextItemId = projected.activity.itemId;
				if (tokenCount > 0 && tokenItemId && nextItemId && tokenItemId !== nextItemId) flush();
				tokenContent = truncateActivity(`${tokenContent}${projected.activity.content ?? ""}`, 16_000);
				tokenCount += 1;
				tokenItemId ??= nextItemId;
				if (sourceSeqStart === undefined) sourceSeqStart = projected.activity.sourceSeq;
				if (projected.activity.sourceSeq !== undefined) sourceSeqEnd = projected.activity.sourceSeq;
				return;
			}
			// `result` and unknown future non-token events are still boundaries even
			// when they have no public WorkerActivity projection.
			flush();
			if (projected) emit(projected);
		},
		flush,
	};
}

function firstText(...values: unknown[]): string {
	for (const value of values) if (typeof value === "string" && value) return value;
	return "";
}

function simpleFacts(data: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
	const entries = keys
		.filter((key) => typeof data[key] === "string" || typeof data[key] === "number" || typeof data[key] === "boolean")
		.map((key) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), data[key]]);
	return entries.length ? Object.fromEntries(entries) : undefined;
}

function safeActivityStringify(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return truncateActivity(value, 12_000);
	try {
		return truncateActivity(JSON.stringify(value, (key, current) => /token|secret|password|authorization|credential|api[_-]?key/i.test(key) ? "[redacted]" : current, 2), 12_000);
	} catch {
		return "[unserializable payload]";
	}
}

function truncateActivity(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * First-party PuddingClaw Driver (§5).
 *
 * - run         → puddingclaw agent run --input-json - --jsonl [--export <handoffDir>]
 * - continue    → same, plus {session_id}; JSONL progress is projected to Runtime activity
 * - respond     → puddingclaw agent respond <run_id> --input-json - --jsonl [--export …]
 *                  {continuation_token, request_id, decisions}
 * - cancel      → puddingclaw agent cancel <run_id>（best-effort：失败降级为 SIGTERM）
 *
 * --export 目录按 §15.3 约定生成为 <cwd>/.pudding/handoff/<delegationId>/
 * （delegationId 由 Runtime 经 InvocationContext 注入）。
 *
 * run/continue/respond consume the CLI JSONL stream, project every public
 * event into the append-only delegation timeline, then normalize the final
 * `result` boundary.
 */
export class PuddingClawDriver implements AgentDriver {
	readonly id = "puddingclaw";

	constructor(private readonly opts: PuddingClawDriverOptions = {}) {}

	async capabilities(): Promise<DriverCapabilities> {
		return {
			...PUDDINGCLAW_CAPABILITIES,
			transport: this.transport(),
			cancelConfirmation: "acknowledged",
			reconciliation: "none",
			workspace: { honorsInvocationCwd: true, readOnlyEnforcement: "none", mutationObservation: ["event_stream", "git_diff", "filesystem_diff"] },
			verification: { modalities: ["cli", "gui"], freshSession: true, workspaceIsolation: ["mutation_guard", "isolated_copy"], commandExecution: true, guiObservation: true, networkObservation: true },
		};
	}

	private transport(): "spawn" | "http" {
		return this.opts.transport ?? "spawn";
	}

	private cmd(): string {
		return this.opts.command ?? "puddingclaw";
	}

	private endpoint(): string {
		return (this.opts.endpoint ?? "http://127.0.0.1:8888").replace(/\/+$/, "");
	}

	private httpUrl(requestPath: string): string {
		return `${this.endpoint()}${requestPath}`;
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

	/**
	 * input_required 时把原任务文本塞进 providerState（加密私有通道）：
	 * worker 在 Run 启动前发问（分析模型澄清）时没有 continuation token /
	 * runHandle 可恢复，respond 只能 clarify-and-retry 带原任务重跑（§8.2）。
	 */
	private withResumeState(event: AgentEvent, message: string): AgentEvent {
		if (event.type !== "input_required") return event;
		return { ...event, providerState: { ...(event.providerState ?? {}), task: message } };
	}

	private async runCli(
		args: string[],
		stdin: unknown,
		ctx: InvocationContext,
		streamProgress = false,
	): Promise<AgentEvent> {
		const activeMs = this.opts.timeoutMs ?? ctx.timeouts?.activeMs ?? 900_000;
		const startedAt = Date.now();
		const recoveryDeadline = startedAt + Math.min(
			activeMs,
			this.opts.connectionRecoveryMs ?? activeMs,
		);
		let recovering = false;
		let recoveryAttempt = 0;

		for (;;) {
			const attemptStartedAt = Date.now();
			const remainingMs = Math.max(1, startedAt + activeMs - attemptStartedAt);
			const observer = streamProgress
				? createPuddingClawActivityObserver((projected) => this.emitWorkerActivity(projected, ctx))
				: undefined;
			let res: Awaited<ReturnType<typeof spawnWorker>>;
			try {
				res = await spawnWorker({
					command: this.cmd(),
					args,
					env: ctx.env,
					cwd: this.ctxCwd(ctx),
					signal: ctx.signal,
					timeoutMs: remainingMs,
					startupMs: ctx.timeouts?.startupMs ?? 30_000,
					stdinJson: stdin,
					jsonl: streamProgress,
					onJsonLine: observer?.push,
				});
			} finally {
				observer?.flush();
			}
			const event = this.eventFromSpawn(res, ctx, remainingMs);
			const attemptAgeMs = Date.now() - attemptStartedAt;
			const result = event.type === "failed" ? event.result : undefined;
			const lostLongResponse =
				result?.errorCode === "connection_error" &&
				attemptAgeMs >= (this.opts.connectionRecoveryMinAgeMs ?? 30_000);
			const stillRunning =
				recovering &&
				result?.errorCode === "http_error" &&
				/identical Worker Run is already in progress/i.test(result.error);

			if (!(lostLongResponse || stillRunning) || Date.now() >= recoveryDeadline || ctx.signal?.aborted) {
				return event;
			}

			recovering = true;
			recoveryAttempt += 1;
			ctx.onUpdate?.(
				stillRunning ? "上游任务仍在执行，正在等待结果…" : "连接已断开，但上游可能仍在执行；正在恢复同一任务的结果…",
				{ running: true, recovering: true, recoveryAttempt },
			);
			await this.recoveryDelay(ctx.signal);
		}
	}

	private async requestHttpJson(
		requestPath: string,
		opts: { method?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
	): Promise<Record<string, unknown>> {
		let payload: Record<string, unknown> | undefined;
		await streamHttpJsonl({
			url: this.httpUrl(requestPath),
			method: opts.method ?? "GET",
			body: opts.body,
			signal: opts.signal,
			startupMs: Math.min(15_000, opts.timeoutMs ?? 15_000),
			timeoutMs: opts.timeoutMs ?? 15_000,
			maxBytes: 1024 * 1024,
			onJsonLine: (line) => {
				if (line && typeof line === "object" && !Array.isArray(line)) payload = line as Record<string, unknown>;
			},
		});
		if (!payload) throw new HttpJsonlError("HTTP response did not contain a JSON object", "protocol_error");
		return payload;
	}

	private httpFailure(error: HttpJsonlError, requestPath: string): AgentEvent {
		const detail = (() => {
			if (!error.responseBody) return error.message;
			try {
				const parsed = JSON.parse(error.responseBody) as Record<string, unknown>;
				return typeof parsed.detail === "string" ? parsed.detail : error.message;
			} catch {
				return error.message;
			}
		})();
		const errorCode = error.status === 410
			? requestPath.includes("/resume") ? "interaction_expired" : requestPath.includes("/cancel") ? "run_expired" : "session_expired"
			: error.status === 409 && requestPath.includes("/resume")
				? "interaction_conflict"
				: error.code;
		const cancelled = errorCode === "cancelled";
		return {
			type: "failed",
			result: {
				agentId: this.id,
				status: cancelled ? "cancelled" : "failed",
				errorCode,
				error: cancelled ? "任务已取消" : `PuddingClaw HTTP 调用失败：${stderrSummary(detail).replace(/^：/, "")}`,
				recoverable: errorCode === "connection_error" || errorCode === "http_error" || errorCode === "interaction_conflict",
			},
		};
	}

	private async runHttp(
		requestPath: string,
		body: Record<string, unknown>,
		ctx: InvocationContext,
	): Promise<AgentEvent> {
		const activeMs = this.opts.timeoutMs ?? ctx.timeouts?.activeMs ?? 900_000;
		const startedAt = Date.now();
		const recoveryDeadline = startedAt + Math.min(activeMs, this.opts.connectionRecoveryMs ?? activeMs);
		let recovering = false;
		let recoveryAttempt = 0;
		// A connection can disappear after the Backend has announced its Run id.
		// Keep the latest handle across retry attempts so cancellation during the
		// recovery delay still reaches the original upstream Run.
		let activeRunHandle = "";

		for (;;) {
			const attemptStartedAt = Date.now();
			const remainingMs = Math.max(1, startedAt + activeMs - attemptStartedAt);
			const observer = createPuddingClawActivityObserver((projected) => this.emitWorkerActivity(projected, ctx));
			let terminal: Record<string, unknown> | undefined;
			try {
				await streamHttpJsonl({
					url: this.httpUrl(requestPath),
					method: "POST",
					body,
					signal: ctx.signal,
					startupMs: ctx.timeouts?.startupMs ?? 30_000,
					timeoutMs: remainingMs,
					onJsonLine: (line) => {
						observer.push(line);
						if (!line || typeof line !== "object" || Array.isArray(line)) return;
						const envelope = line as Record<string, unknown>;
						const data = envelope.data && typeof envelope.data === "object"
							? envelope.data as Record<string, unknown>
							: {};
						const run = data.run && typeof data.run === "object" ? data.run as Record<string, unknown> : {};
						activeRunHandle = firstText(data.run_id, run.run_id, activeRunHandle, data.session_id);
						if (envelope.event === "result" && envelope.data && typeof envelope.data === "object") {
							terminal = envelope.data as Record<string, unknown>;
						} else if (!envelope.event && (typeof envelope.status === "string" || typeof envelope.outcome === "string")) {
							// Completed idempotency replays and older Backends return one JSON object.
							terminal = envelope;
						}
					},
				});
			} catch (error) {
				const transportError = error instanceof HttpJsonlError
					? error
					: new HttpJsonlError(error instanceof Error ? error.message : String(error), "connection_error");
				if (transportError.code === "cancelled" && activeRunHandle) {
					await this.requestHttpJson(`/api/headless/runs/${encodeURIComponent(activeRunHandle)}/cancel`, {
						method: "POST",
						timeoutMs: 10_000,
					}).catch(() => undefined);
				}
				const attemptAgeMs = Date.now() - attemptStartedAt;
				const lostLongResponse = transportError.code === "connection_error"
					&& attemptAgeMs >= (this.opts.connectionRecoveryMinAgeMs ?? 30_000);
				const stillRunning = recovering
					&& transportError.status === 409
					&& /identical Worker Run is already in progress/i.test(transportError.responseBody ?? transportError.message);
				if (!(lostLongResponse || stillRunning) || Date.now() >= recoveryDeadline || ctx.signal?.aborted) {
					return this.httpFailure(transportError, requestPath);
				}
				recovering = true;
				recoveryAttempt += 1;
				ctx.onUpdate?.(
					stillRunning ? "上游任务仍在执行，正在等待结果…" : "连接已断开，但上游可能仍在执行；正在恢复同一任务的结果…",
					{ running: true, recovering: true, recoveryAttempt },
				);
				await this.recoveryDelay(ctx.signal);
				continue;
			} finally {
				observer.flush();
			}

			if (!terminal) {
				return this.httpFailure(new HttpJsonlError("HTTP JSONL stream ended without a result event", "protocol_error"), requestPath);
			}
			ctx.onUpdate?.("worker 执行完成", { httpStatus: 200 });
			return this.withHandoffPaths(normalizePuddingClawJson(terminal), ctx);
		}
	}

	private emitWorkerActivity(projected: { label: string; activity: WorkerActivity }, ctx: InvocationContext): void {
		ctx.onUpdate?.(projected.label, {
			running: projected.activity.status !== "completed" && projected.activity.status !== "failed",
			workerEvent: projected.activity.sourceEvent,
			activity: projected.activity,
		});
	}

	private async recoveryDelay(signal?: AbortSignal): Promise<void> {
		const delayMs = this.opts.connectionRecoveryIntervalMs ?? 5_000;
		if (signal?.aborted) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(done, delayMs);
			function done() {
				signal?.removeEventListener("abort", done);
				clearTimeout(timer);
				resolve();
			}
			signal?.addEventListener("abort", done, { once: true });
		});
	}

	private eventFromSpawn(
		res: Awaited<ReturnType<typeof spawnWorker>>,
		ctx: InvocationContext,
		timeoutMs: number,
	): AgentEvent {
		if (res.timedOut) {
			return {
				type: "failed",
				result: {
					agentId: this.id,
					status: "failed",
					errorCode: "timeout",
					error: `worker 超时（${Math.round(timeoutMs / 1000)}s）`,
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

		const rawLastLine = res.lines.length > 0 ? res.lines[res.lines.length - 1] : undefined;
		const lastLine = rawLastLine && typeof rawLastLine === "object"
			&& (rawLastLine as Record<string, unknown>).event === "result"
			&& (rawLastLine as Record<string, unknown>).data
			? (rawLastLine as Record<string, unknown>).data
			: rawLastLine;
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
		const options = input.options ?? {};
		const metadata = options.metadata && typeof options.metadata === "object"
			? options.metadata as Record<string, unknown>
			: {};
		yield {
			type: "started",
		};
		const payload = {
			...options,
			message: input.message,
			request_id: input.requestId,
			...(this.transport() === "http" ? { workspace_path: this.ctxCwd(ctx) } : {}),
			metadata: { ...metadata, caller_id: "puddingteams", caller_name: "PuddingTeams" },
		};
		yield this.withResumeState(
			this.transport() === "http"
				? await this.runHttp("/api/headless/runs?stream=true", payload, ctx)
				: await this.runCli(
					["agent", "run", "--input-json", "-", "--jsonl", ...this.exportArgs(ctx)],
					payload,
					ctx,
					true,
				),
			input.message,
		);
	}

	async *continue(input: ContinueInput, ctx: InvocationContext): AsyncIterable<AgentEvent> {
		ctx.onUpdate?.("worker 正在续接会话…", { running: true });
		const options = input.options ?? {};
		const metadata = options.metadata && typeof options.metadata === "object"
			? options.metadata as Record<string, unknown>
			: {};
		yield { type: "started", sessionHandle: input.sessionHandle };
		const payload = {
			...options,
			message: input.message,
			session_id: input.sessionHandle,
			request_id: input.requestId,
			...(this.transport() === "http" ? { workspace_path: this.ctxCwd(ctx) } : {}),
			metadata: { ...metadata, caller_id: "puddingteams", caller_name: "PuddingTeams" },
		};
		yield this.withResumeState(
			this.transport() === "http"
				? await this.runHttp("/api/headless/runs?stream=true", payload, ctx)
				: await this.runCli(
					["agent", "run", "--input-json", "-", "--jsonl", ...this.exportArgs(ctx)],
					payload,
					ctx,
					true,
				),
			input.message,
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
			// clarify-and-retry（§8.2）：worker 在 Run 启动前的发问（如分析模型
			// 澄清）没有 continuation token/runHandle 可恢复。契约是把用户的
			// 选择并入原任务重跑一次，让模型路由这次能唯一匹配。原任务文本
			// 由 run/continue 经 providerState.task 私有通道带来。
			const task = typeof state.task === "string" ? state.task : "";
			const answer = input.responses.find(
				(r) => r.action !== "reject" && ((typeof r.scope === "string" && r.scope) || (typeof r.value === "string" && r.value)),
			);
			const chosen = typeof answer?.scope === "string" && answer.scope ? answer.scope : (answer?.value as string | undefined);
			if (!task || !chosen) {
				yield {
					type: "failed",
					result: {
						agentId: this.id,
						status: "failed",
						errorCode: "interaction_unsupported",
						error: "该审批对应的 worker 运行不支持恢复（无 continuation token），且缺少重跑所需的原任务或用户选择，请重新委托并在任务中说明选择",
						recoverable: false,
					},
				};
				return;
			}
			ctx.onUpdate?.("正在按你的选择重跑…", { running: true });
			yield { type: "started", runHandle: input.runHandle };
			const payload = {
				message: `${task}\n\n（用户已明确：使用「${chosen}」执行本任务。）`,
				request_id: input.requestId,
				...(this.transport() === "http" ? { workspace_path: this.ctxCwd(ctx) } : {}),
				metadata: { caller_id: "puddingteams", caller_name: "PuddingTeams" },
			};
			yield this.transport() === "http"
				? await this.runHttp("/api/headless/runs?stream=true", payload, ctx)
				: await this.runCli(
					["agent", "run", "--input-json", "-", "--jsonl", ...this.exportArgs(ctx)],
					payload,
					ctx,
					true,
				);
			return;
		}
		ctx.onUpdate?.("正在提交审批…", { running: true });
		yield { type: "started", runHandle: input.runHandle };
		const payload = {
			continuation_token: token,
			request_id: input.requestId,
			decisions: input.responses.map((r) => ({
				request_id: r.requestId,
				decision: r.action,
				...(r.scope ? { scope: r.scope } : {}),
				...(r.value !== undefined ? { value: r.value } : {}),
			})),
		};
		yield this.transport() === "http"
			? await this.runHttp(`/api/headless/runs/${encodeURIComponent(input.runHandle)}/resume?stream=true`, payload, ctx)
			: await this.runCli(
				["agent", "respond", input.runHandle, "--input-json", "-", "--jsonl", ...this.exportArgs(ctx)],
				payload,
				ctx,
				true,
			);
	}

	async cancel(input: { runHandle: string }, ctx: InvocationContext): Promise<void> {
		if (this.transport() === "http") {
			const response = await this.requestHttpJson(`/api/headless/runs/${encodeURIComponent(input.runHandle)}/cancel`, {
				method: "POST",
				timeoutMs: 10_000,
			});
			if (response.status !== "cancelled" && response.cancelled !== true) throw new Error("上游未确认 Run 已取消");
			return;
		}
		const cancelled = await spawnWorker({
				command: this.cmd(),
				args: ["agent", "cancel", input.runHandle, "--json"],
				env: ctx.env,
				cwd: this.ctxCwd(ctx),
				signal: ctx.signal,
				timeoutMs: 10_000,
			});
		if (cancelled.exitCode !== 0) throw new Error(`PuddingClaw cancel 未确认（exit ${cancelled.exitCode}）`);
	}

	async probe(ctx: InvocationContext): Promise<ProbeResult> {
		if (this.transport() === "http") {
			const capabilities = await this.capabilities();
			try {
				const raw = await this.requestHttpJson("/api/headless/health", {
					method: "GET",
					signal: ctx.signal,
					timeoutMs: 15_000,
				});
				const agentId = typeof raw.agent_id === "string" ? raw.agent_id : undefined;
				const detected = raw.reachable === true && agentId === "puddingclaw";
				const configured = raw.configured === true;
				const protocolVersion = typeof raw.protocol_version === "string" ? raw.protocol_version : undefined;
				const operations = raw.operations && typeof raw.operations === "object" && !Array.isArray(raw.operations)
					? raw.operations as Record<string, unknown>
					: {};
				const contractIssues: ProbeResult["issues"] = [];
				if (agentId !== "puddingclaw") {
					contractIssues.push({ code: "wrong_agent", message: "Endpoint 不是 PuddingClaw Headless API", fixAction: `检查 ${this.endpoint()}` });
				}
				if (raw.progress !== "jsonl") {
					contractIssues.push({ code: "progress_unsupported", message: "Headless API 未声明 JSONL 流式进度" });
				}
				for (const operation of ["run", "continue", "respond", "cancel"]) {
					if (operations[operation] !== true) {
						contractIssues.push({ code: "operation_unsupported", message: `Headless API 未声明 ${operation} 操作` });
					}
				}
				const compatibility = protocolVersion !== "1"
					? "untested"
					: contractIssues.length > 0
						? "incompatible"
						: "supported";
				return {
					extensionInstalled: true,
					detected,
					configured,
					authenticated: "unknown",
					enabled: true,
					compatibility,
					upstreamVersion: typeof raw.server_version === "string" ? raw.server_version : undefined,
					version: protocolVersion,
					transport: "http",
					capabilities,
					issues: [
						...(configured ? [] : [{ code: "not_configured", message: "PuddingClaw HTTP Backend 未配置", fixAction: `检查 ${this.endpoint()}` }]),
						...(protocolVersion === "1" ? [] : [{ code: "protocol_untested", message: `未经验证的 Headless API 协议版本：${protocolVersion ?? "未声明"}` }]),
						...contractIssues,
					],
				};
			} catch (error) {
				return {
					extensionInstalled: true,
					detected: false,
					configured: false,
					authenticated: "unknown",
					enabled: true,
					compatibility: "unknown",
					transport: "http",
					capabilities,
					issues: [{
						code: error instanceof HttpJsonlError ? error.code : "connection_error",
						message: `无法连接 PuddingClaw HTTP Backend：${error instanceof Error ? error.message : String(error)}`,
						fixAction: `确认 ${this.endpoint()} 已启动`,
					}],
				};
			}
		}
		const res = await spawnWorker({
			command: this.cmd(),
			args: ["doctor", "--json"],
			env: ctx.env,
			cwd: this.ctxCwd(ctx),
			timeoutMs: 15_000,
		});
		let detected = res.exitCode !== -1;
		let configured = res.exitCode === 0;
		const authenticated: boolean | "unknown" = "unknown";
		let upstreamVersion: string | undefined;
		let protocolVersion: string | undefined;
		if (res.stdout.trim()) {
			try {
				const raw = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
				configured = raw.configured === true;
				detected = detected || raw.cli_version !== undefined;
				upstreamVersion = typeof raw.cli_version === "string" ? raw.cli_version : undefined;
				protocolVersion = typeof raw.protocol_version === "string" ? raw.protocol_version : undefined;
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
			version: protocolVersion,
			transport: "spawn",
			capabilities: await this.capabilities(),
			issues: [
				...(configured
					? []
					: [{ code: "not_configured", message: "PuddingClaw CLI 未检测到或未配置", fixAction: "运行 puddingclaw doctor --json" }]),
			],
		};
	}
}
