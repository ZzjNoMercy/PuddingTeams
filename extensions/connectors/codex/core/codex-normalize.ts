import type { AgentEvent, DriverCapabilities, WorkerActivity } from "@puddingteams/pwcp/types";

/** Codex CLI (`codex exec --json`) terminal reducer + activity projector. */
export interface CodexUsage {
	inputTokens?: number;
	outputTokens?: number;
}

export interface CodexEventProjection {
	progress?: string;
	activity?: WorkerActivity;
}

export class CodexEventReducer {
	threadId: string | undefined;
	usage: CodexUsage | undefined;
	sawTurnCompleted = false;
	private error: string | undefined;
	/** Earlier agent messages stay in the activity timeline; only the latest
	 * completed message is the turn's final deliverable. */
	private finalContent: string | undefined;

	/** Backward-compatible coarse progress interface used by the pi facade. */
	push(raw: unknown): string | undefined {
		return this.pushWithActivity(raw).progress;
	}

	/** Project every visible exec JSONL lifecycle into the common timeline. */
	pushWithActivity(raw: unknown): CodexEventProjection {
		if (!raw || typeof raw !== "object") return {};
		const ev = raw as Record<string, unknown>;
		const type = typeof ev.type === "string" ? ev.type : "";

		if (type === "thread.started" && typeof ev.thread_id === "string") {
			this.threadId = ev.thread_id;
			return { activity: activity(type, "lifecycle", "started", "Codex Thread 已建立", undefined, undefined, { threadId: ev.thread_id }) };
		}
		if (type === "turn.started") {
			return { activity: activity(type, "lifecycle", "started", "Codex Turn 已开始") };
		}
		if (type === "item.started" || type === "item.updated" || type === "item.completed") {
			return this.onItem(type, ev.item as Record<string, unknown> | undefined);
		}
		if (type === "turn.completed") {
			this.sawTurnCompleted = true;
			const usage = ev.usage as Record<string, unknown> | undefined;
			if (usage) {
				this.usage = {
					...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
					...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
				};
			}
			return {
				activity: activity(type, "lifecycle", "completed", "Codex Turn 已完成", undefined, undefined, usage ? safeMetadata(usage) : undefined),
			};
		}
		if (type === "turn.failed" || type === "error") {
			this.error = errorText(ev.error ?? ev.message);
			return { progress: this.error, activity: activity(type, "error", "failed", "Codex 执行失败", this.error) };
		}
		return {};
	}

	private onItem(sourceEvent: string, item: Record<string, unknown> | undefined): CodexEventProjection {
		if (!item || typeof item !== "object") return {};
		const itemType = typeof item.type === "string" ? item.type : "";
		const itemId = typeof item.id === "string" ? item.id : undefined;
		const phase: WorkerActivity["status"] = sourceEvent === "item.started" ? "started" : sourceEvent === "item.updated" ? "updated" : "completed";

		switch (itemType) {
			case "agent_message": {
				const text = stringValue(item.text, 24_000);
				if (sourceEvent === "item.completed" && text) this.finalContent = text;
				return { activity: activity(sourceEvent, "assistant", phase, phase === "completed" ? "Codex 回复" : "Codex 正在生成回复", text, itemId) };
			}
			case "reasoning":
				return { activity: activity(sourceEvent, "reasoning", phase, "Codex 推理摘要", stringValue(item.text, 12_000), itemId) };
			case "command_execution": {
				const command = stringValue(item.command, 4_000);
				const output = stringValue(item.aggregated_output, 12_000);
				const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
				const status: WorkerActivity["status"] = failed ? "failed" : phase;
				const title = phase === "started" ? "开始执行命令" : failed ? "命令执行失败" : "命令执行完成";
				return {
					progress: command ? `$ ${truncate(command, 120)}` : title,
					activity: activity(sourceEvent, "tool", status, title, [command ? `$ ${command}` : "", output].filter(Boolean).join("\n"), itemId, {
						tool: "command_execution",
						...(typeof item.exit_code === "number" ? { exitCode: item.exit_code } : {}),
					}),
				};
			}
			case "file_change": {
				const normalized = (Array.isArray(item.changes) ? item.changes : [])
					.map((change) => {
						if (!change || typeof change !== "object") return undefined;
						const c = change as Record<string, unknown>;
						return typeof c.path === "string" ? { path: c.path, ...(typeof c.kind === "string" ? { kind: c.kind } : {}) } : undefined;
					})
					.filter((change): change is { path: string; kind?: string } => Boolean(change));
				const paths = normalized.map((change) => change.path);
				const failed = item.status === "failed";
				const title = failed ? "文件修改失败" : "文件修改完成";
				return {
					progress: paths.length ? `修改 ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? " …" : ""}` : title,
					activity: activity(sourceEvent, "file", failed ? "failed" : phase, title, normalized.map((c) => `${c.kind ?? "update"} ${c.path}`).join("\n"), itemId, { changes: normalized }),
				};
			}
			case "web_search": {
				const query = stringValue(item.query, 2_000);
				return {
					progress: query ? `搜索 ${truncate(query, 80)}` : "搜索网络",
					activity: activity(sourceEvent, "search", phase, phase === "started" ? "开始网络搜索" : "网络搜索完成", query, itemId),
				};
			}
			case "mcp_tool_call": {
				const server = stringValue(item.server, 200);
				const tool = stringValue(item.tool, 300);
				const failed = item.status === "failed" || Boolean(item.error);
				const name = [server, tool].filter(Boolean).join("/") || "MCP 工具";
				const payload = sourceEvent === "item.completed" ? (item.error ?? item.result) : item.arguments;
				const verb = phase === "started" ? "调用" : failed ? "调用失败" : "调用完成";
				return {
					progress: `${verb} ${name}`,
					activity: activity(sourceEvent, "tool", failed ? "failed" : phase, `${verb} ${name}`, safeStringify(payload), itemId, { tool: name }),
				};
			}
			case "collab_tool_call": {
				const tool = stringValue(item.tool, 300) || "协作工具";
				const failed = item.status === "failed";
				return {
					progress: `${phase === "started" ? "启动" : "完成"} ${tool}`,
					activity: activity(sourceEvent, "tool", failed ? "failed" : phase, `Codex 协作：${tool}`, safeStringify({ receiverThreadIds: item.receiver_thread_ids, agentsStates: item.agents_states }), itemId, { tool }),
				};
			}
			case "todo_list": {
				const content = (Array.isArray(item.items) ? item.items : []).map((entry) => {
					const todo = entry as Record<string, unknown>;
					return `${todo.completed ? "✓" : "○"} ${stringValue(todo.text, 1_000)}`;
				}).join("\n");
				return { activity: activity(sourceEvent, "plan", phase, "Codex 任务计划", content, itemId) };
			}
			case "error": {
				const message = stringValue(item.message, 12_000) || "Codex item error";
				return { progress: message, activity: activity(sourceEvent, "error", "failed", "Codex 报告错误", message, itemId) };
			}
			default:
				return {};
		}
	}

	boundary(agentId: string): AgentEvent {
		if (this.error) {
			return {
				type: "failed",
				result: {
					agentId,
					status: "failed",
					...(this.threadId ? { sessionHandle: this.threadId, runHandle: this.threadId } : {}),
					errorCode: "worker_failed",
					error: this.error,
					recoverable: true,
				},
			};
		}
		return {
			type: "completed",
			result: {
				agentId,
				status: "completed",
				...(this.threadId ? { sessionHandle: this.threadId, runHandle: this.threadId } : {}),
				content: this.finalContent || "（codex 无文本输出）",
				...(this.usage ? { usage: this.usage } : {}),
			},
		};
	}
}

function activity(
	sourceEvent: string,
	kind: WorkerActivity["kind"],
	status: WorkerActivity["status"],
	title: string,
	content?: string,
	itemId?: string,
	metadata?: Record<string, unknown>,
): WorkerActivity {
	return {
		source: "codex",
		sourceEvent,
		kind,
		status,
		title,
		...(content ? { content: truncate(content, 16_000) } : {}),
		...(itemId ? { itemId } : {}),
		...(metadata ? { metadata } : {}),
	};
}

function errorText(value: unknown): string {
	if (typeof value === "string" && value) return value;
	if (value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string") {
		return String((value as { message: string }).message);
	}
	return "codex turn failed";
}

function stringValue(value: unknown, max: number): string {
	return typeof value === "string" ? truncate(value, max) : "";
}

function safeMetadata(value: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean"));
}

function safeStringify(value: unknown): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return truncate(value, 12_000);
	try {
		return truncate(JSON.stringify(value, (key, current) => /token|secret|password|authorization|credential|api[_-]?key/i.test(key) ? "[redacted]" : current, 2), 12_000);
	} catch {
		return "[unserializable payload]";
	}
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

export const CODEX_CAPABILITIES: DriverCapabilities = {
	operations: ["run", "continue", "cancel"],
	interactionKinds: [],
	progress: "stream",
	transport: "spawn",
};
