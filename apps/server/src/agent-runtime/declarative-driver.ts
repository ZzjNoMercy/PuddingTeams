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
import { spawnWorker, type SpawnResult } from "@puddingteams/pwcp/spawn";
import { JsonlLineParser } from "@puddingteams/pwcp/jsonl-lines";
import {
	parseDeclarativeMappingRef,
	type DeclarativeConnectorSpec,
	type DeclarativeMappingRef,
	type DeclarativeOperationSpec,
} from "./extensions.js";
import type { DriverFactory } from "./driver-registry.js";

/**
 * 声明式 Connector Driver（§10.3 两级模型第 1 级）：用户只写 manifest，
 * 不写代码即可接入简单 CLI。spawn、超时、取消、stdin framing、JSON/JSONL
 * 解码全部由核心执行，包内没有任何可执行模块（无 entry）。
 *
 * 错误处理形状照抄 CodexDriver：timeout / killed / startupTimedOut /
 * spawnError / exitCode!=0 五种 failed 归一，recoverable: exitCode!==2，
 * stderr 摘要截断 + 脱敏。
 */

/** 有界的 stderr 诊断摘要（截断 + 脱敏，同 CodexDriver）。 */
function stderrSummary(stderr: string): string {
	if (!stderr.trim()) return "";
	const max = 400;
	let s = stderr.trim().slice(0, max);
	s = s.replace(/\b(?:token|sk-)[a-zA-Z0-9_\-\.]{6,}\b/gi, "[redacted]");
	s = s.replace(/\b(?:OPENAI_API_KEY|Authorization)\s*[:=]\s*"?[^\s"\]]+/gi, "$1=[redacted]");
	return `：${s}${stderr.length > max ? "…" : ""}`;
}

/** 取对象上的 dot.path 值（路径段任一缺失返回 undefined）。 */
function getPath(obj: unknown, path: string[]): unknown {
	let cur = obj;
	for (const seg of path) {
		if (!cur || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[seg];
	}
	return cur;
}

/** 一次 run/continue 的流式归约状态。 */
interface Accumulator {
	sessionHandle?: string;
	runHandle?: string;
	contents: string[];
	error?: string;
	inputTokens?: number;
	outputTokens?: number;
}

interface MappingRule extends DeclarativeMappingRef {
	key: string;
}

class DeclarativeDriver implements AgentDriver {
	private readonly rules: MappingRule[];

	constructor(
		readonly id: string,
		private readonly spec: DeclarativeConnectorSpec,
		private readonly packageDir: string,
	) {
		// mapping 在 manifest parse 时已校验，这里直接展开为可执行规则。
		this.rules = Object.entries(spec.output.mapping ?? {}).map(([key, value]) => ({
			key,
			...parseDeclarativeMappingRef(value)!,
		}));
	}

	async capabilities(): Promise<DriverCapabilities> {
		return {
			operations: this.spec.capabilities.operations,
			interactionKinds: this.spec.capabilities.interactionKinds,
			// 有 progress mapping 才能流式外送进度，否则只有边界（coarse）。
			progress: this.rules.some((r) => r.key === "progress") ? "stream" : "coarse",
			transport: "spawn",
		};
	}

	/** argv 模板占位符替换（{message}/{sessionHandle}/{requestId}/{packageDir}）。 */
	private substitute(arg: string, values: Record<string, string>): string {
		return arg.replace(/\{(message|sessionHandle|requestId|packageDir)\}/g, (_, name: string) => values[name] ?? "");
	}

	/** 把一条上游事件按 mapping 归约进 acc；progress 命中的文本实时外送。 */
	private applyEvent(raw: unknown, acc: Accumulator, ctx: InvocationContext): void {
		if (!raw || typeof raw !== "object") return;
		for (const rule of this.rules) {
			if (rule.eventType && (raw as Record<string, unknown>).type !== rule.eventType) continue;
			if (rule.filterPath && String(getPath(raw, rule.filterPath)) !== rule.filterValue) continue;
			const v = getPath(raw, rule.path);
			switch (rule.key) {
				case "sessionHandle":
					if (typeof v === "string" && v) acc.sessionHandle = v;
					break;
				case "runHandle":
					if (typeof v === "string" && v) acc.runHandle = v;
					break;
				case "content":
					if (typeof v === "string" && v) acc.contents.push(v);
					break;
				case "progress":
					// 只有 progress 外送；content 不外送（避免与终态重复，同 codex 的 agent_message 约定）。
					if (typeof v === "string" && v) ctx.onUpdate?.(v, { streaming: true });
					break;
				case "error":
					if (typeof v === "string" && v) acc.error = v;
					break;
				case "usage.inputTokens":
					if (typeof v === "number") acc.inputTokens = v;
					break;
				case "usage.outputTokens":
					if (typeof v === "number") acc.outputTokens = v;
					break;
			}
		}
	}

	private boundaryCompleted(acc: Accumulator): AgentEvent {
		const usage =
			acc.inputTokens !== undefined || acc.outputTokens !== undefined
				? {
						...(acc.inputTokens !== undefined ? { inputTokens: acc.inputTokens } : {}),
						...(acc.outputTokens !== undefined ? { outputTokens: acc.outputTokens } : {}),
					}
				: undefined;
		return {
			type: "completed",
			result: {
				agentId: this.id,
				status: "completed",
				...(acc.sessionHandle ? { sessionHandle: acc.sessionHandle } : {}),
				...(acc.runHandle ? { runHandle: acc.runHandle } : {}),
				content: acc.contents.length ? acc.contents.join("\n\n") : "（无文本输出）",
				...(usage ? { usage } : {}),
			},
		};
	}

	private failed(errorCode: string, error: string, recoverable: boolean, sessionHandle?: string): AgentEvent {
		return {
			type: "failed",
			result: {
				agentId: this.id,
				status: errorCode === "cancelled" ? "cancelled" : "failed",
				...(sessionHandle ? { sessionHandle } : {}),
				errorCode,
				error,
				recoverable,
			},
		};
	}

	/**
	 * 流式执行：onStdout 逐行应用 mapping（progress 实时外送），进程退出后
	 * 产出边界。失败归一顺序与 CodexDriver 一致。
	 */
	private async runCli(op: DeclarativeOperationSpec, values: Record<string, string>, ctx: InvocationContext): Promise<AgentEvent> {
		const args = op.args.map((a) => this.substitute(a, values));
		const jsonl = this.spec.output.mode === "jsonl";
		const acc: Accumulator = { contents: [] };
		const parser = new JsonlLineParser();
		const feed = (chunk: string) => {
			for (const raw of parser.push(chunk)) this.applyEvent(raw, acc, ctx);
		};
		const activeMs = ctx.timeouts?.activeMs ?? 900_000;
		const res: SpawnResult = await spawnWorker({
			command: this.spec.command,
			args,
			env: ctx.env,
			cwd: ctx.cwd ?? process.cwd(),
			signal: ctx.signal,
			timeoutMs: activeMs,
			startupMs: ctx.timeouts?.startupMs ?? 30_000,
			// stdin framing：json = 写 {message, sessionHandle, requestId} 后 EOF；none 立即 EOF。
			...(op.stdin === "json"
				? { stdinJson: { message: values.message, sessionHandle: values.sessionHandle, requestId: values.requestId } }
				: {}),
			...(jsonl ? { onStdout: feed } : {}),
		});
		if (jsonl) {
			for (const raw of parser.flush()) this.applyEvent(raw, acc, ctx);
		}

		if (res.timedOut) {
			return this.failed("timeout", `worker 超时（${Math.round(activeMs / 1000)}s）`, false, acc.sessionHandle);
		}
		if (res.killed) {
			return this.failed("cancelled", "任务已取消", true, acc.sessionHandle);
		}
		if (res.startupTimedOut && !res.stdout.trim()) {
			return this.failed(
				"startup_timeout",
				`worker「${this.spec.command}」在 ${Math.round((ctx.timeouts?.startupMs ?? 30_000) / 1000)}s 内未输出任何内容`,
				false,
				acc.sessionHandle,
			);
		}
		if (res.exitCode === -1 && res.spawnError) {
			return this.failed("spawn_error", `无法启动 worker「${this.spec.command}」：${res.spawnError.message}`, true, acc.sessionHandle);
		}
		// 上游事件里声明了错误：以事件为准（recoverable，可重试）。
		if (acc.error) {
			return this.failed("worker_failed", acc.error, true, acc.sessionHandle);
		}
		if (res.exitCode !== 0) {
			// 退出码 2 是 CLI 参数/用法错误，重试多少次都一样（同 codex）。
			return this.failed(
				"worker_failed",
				`worker 退出码 ${res.exitCode}${stderrSummary(res.stderr)}`,
				res.exitCode !== 2,
				acc.sessionHandle,
			);
		}
		if (!jsonl) {
			// single-json：整个 stdout 是一个 JSON 对象，按路径取值（无 @ 事件匹配）。
			let doc: unknown;
			try {
				doc = JSON.parse(res.stdout);
			} catch {
				return this.failed("worker_failed", `worker 输出不是合法 JSON${stderrSummary(res.stderr)}`, true, acc.sessionHandle);
			}
			this.applyEvent(doc, acc, ctx);
		}
		ctx.onUpdate?.("worker 执行完成", { exitCode: res.exitCode });
		return this.boundaryCompleted(acc);
	}

	async *run(input: RunInput, ctx: InvocationContext): AsyncIterable<AgentEvent> {
		yield { type: "started" };
		yield await this.runCli(
			this.spec.operations.run,
			{ message: input.message, sessionHandle: "", requestId: input.requestId, packageDir: this.packageDir },
			ctx,
		);
	}

	async *continue(input: ContinueInput, ctx: InvocationContext): AsyncIterable<AgentEvent> {
		const op = this.spec.operations.continue;
		if (!op) {
			// capabilities 未声明 continue，Runtime 正常不会路由到这里（防御性）。
			yield this.failed("operation_unsupported", `connector「${this.id}」未声明 continue 操作`, false, input.sessionHandle);
			return;
		}
		yield { type: "started", sessionHandle: input.sessionHandle };
		yield await this.runCli(
			op,
			{ message: input.message, sessionHandle: input.sessionHandle, requestId: input.requestId, packageDir: this.packageDir },
			ctx,
		);
	}

	async *respond(input: RespondInput, _ctx: InvocationContext): AsyncIterable<AgentEvent> {
		// 防御性失败：声明式 Connector 不支持 HITL（capabilities 无 respond）。
		yield {
			type: "failed",
			result: {
				agentId: this.id,
				status: "failed",
				runHandle: input.runHandle,
				errorCode: "interaction_unsupported",
				error: "声明式 Connector 不支持跨进程审批（无 respond 能力）",
				recoverable: false,
			},
		};
	}

	async cancel(_input: { runHandle: string }, _ctx: InvocationContext): Promise<void> {
		// 无上游取消命令；运行时取消经 AbortSignal → SIGTERM→SIGKILL。
	}

	async probe(ctx: InvocationContext): Promise<ProbeResult> {
		const caps = await this.capabilities();
		// 有 probe 声明用声明的 args；没有则以 --version 兜底探测命令可执行性。
		const probeArgs = this.spec.probe
			? this.spec.probe.args.map((a) =>
					this.substitute(a, { message: "", sessionHandle: "", requestId: "", packageDir: this.packageDir }),
				)
			: ["--version"];
		const res = await spawnWorker({ command: this.spec.command, args: probeArgs, env: ctx.env, timeoutMs: 15_000 });
		const detected = res.exitCode !== -1 && !res.spawnError;
		const versionRe = this.spec.probe?.versionRegex ? new RegExp(this.spec.probe.versionRegex) : /(\d+\.\d+\.\d+)/;
		const versionMatch = res.stdout.trim().match(versionRe);
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
			capabilities: caps,
			issues: detected
				? []
				: [{ code: "not_detected", message: `命令「${this.spec.command}」未检测到`, fixAction: "确认 declarative.command 可执行且在 PATH 中" }],
		};
	}
}

/**
 * 声明式 Driver 工厂：ExtensionRegistry 对无 entry、有 connector.declarative
 * 的包调用，注册进 DriverRegistry。同一 Connector 多 Agent 实例（§9.3.7）；
 * config 暂不覆盖 declarative.command（保持简单，后续可加 config 覆盖）。
 */
export function createDeclarativeDriverFactory(
	connectorId: string,
	spec: DeclarativeConnectorSpec,
	opts: { packageDir: string },
): DriverFactory {
	return () => new DeclarativeDriver(connectorId, spec, opts.packageDir);
}
