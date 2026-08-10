import type {
	AgentEvent,
	ArtifactRef,
	CompletedResult,
	DriverCapabilities,
	FailedResult,
	NeedsInputResult,
} from "./types.js";

/**
 * 把 PuddingClaw CLI 的单 JSON 输出归一化为 PWCP 事件（§8.2：第一阶段先单 JSON，
 * 不依赖真实 JSONL 流）。若未来 stdout 是 JSONL，spawnWorker 已按行解析，这里按
 * 最后到达的边界事件取终态。
 */
export function normalizePuddingClawJson(raw: unknown): AgentEvent {
	if (!raw || typeof raw !== "object") {
		return failedEvent("protocol_error", "worker 返回了非 JSON 输出");
	}
	const payload = raw as Record<string, unknown>;
	const status = typeof payload.status === "string" ? payload.status : "";

	if (status === "needs_input" || status === "blocked") {
		const needs = payload.needs_input as Record<string, unknown> | undefined;
		// continuation token 只进 providerState（Runtime 私有通道），不进公开投影。
		const providerState: Record<string, unknown> = {};
		if (typeof payload.continuation_token === "string") {
			providerState.continuation_token = payload.continuation_token;
		}
		if (typeof payload.run_id === "string") providerState.run_id = payload.run_id;
		if (typeof payload.session_id === "string") providerState.session_id = payload.session_id;
		return {
			type: "input_required",
			result: needsInputResult(payload, needs),
			...(Object.keys(providerState).length ? { providerState } : {}),
		};
	}
	if (status === "failed" || status === "error") {
		const errorCode = typeof payload.error_code === "string" ? payload.error_code : "";
		const message = typeof payload.error === "string" ? payload.error : "";
		return failedEvent(errorCode || "worker_failed", message || "worker 执行失败");
	}
	if (status === "cancelled") {
		return { type: "failed", result: { ...resultBase(payload), status: "cancelled", errorCode: "cancelled", error: "任务已取消", recoverable: true } };
	}

	// completed（含默认兜底）
	const content =
		(typeof payload.final_response === "string" && payload.final_response
			? payload.final_response
			: typeof payload.reply === "string"
				? payload.reply
				: JSON.stringify(payload));
	const artifacts = parseExportedArtifacts(payload);
	return {
		type: "completed",
		result: { ...resultBase(payload), status: "completed", content, ...(artifacts.length ? { artifacts } : {}) },
	};
}

/**
 * §15.4 push 轨：--export 终态的 `export.exported` 是「backend 声明的原始
 * item + exported_path」（exported_path 相对导出目录）。只认显式导出结果，
 * 不做目录扫描兜底；path 由 Driver 按 §15.3 约定改写成 workspace 相对路径。
 */
export function parseExportedArtifacts(payload: Record<string, unknown>): ArtifactRef[] {
	const exportInfo = payload.export as Record<string, unknown> | undefined;
	const exported = Array.isArray(exportInfo?.exported) ? (exportInfo!.exported as unknown[]) : [];
	const out: ArtifactRef[] = [];
	for (const item of exported) {
		if (!item || typeof item !== "object") continue;
		const raw = item as Record<string, unknown>;
		const exportedPath = typeof raw.exported_path === "string" ? raw.exported_path : "";
		if (!exportedPath) continue;
		out.push({
			name:
				typeof raw.name === "string" && raw.name
					? raw.name
					: (exportedPath.split(/[\\/]+/).filter(Boolean).pop() ?? exportedPath),
			path: exportedPath,
			...(typeof raw.kind === "string" ? { kind: raw.kind } : {}),
			...(typeof raw.size === "number" ? { size: raw.size } : {}),
			origin: "push",
		});
	}
	return out;
}

export function resultBase(payload: Record<string, unknown>): Omit<CompletedResult, "status"> {
	return {
		agentId: "puddingclaw",
		sessionHandle: typeof payload.session_id === "string" ? payload.session_id : undefined,
		runHandle: typeof payload.run_id === "string" ? payload.run_id : undefined,
		meta: pickMeta(payload),
	};
}

function pickMeta(payload: Record<string, unknown>): Record<string, unknown> {
	const keys = [
		"project_id",
		"analytics_model_id",
		"approval_mode",
		"outcome",
		"verification",
		"auto_resolved",
		"interrupt_summary",
		"model_call_count",
	];
	const meta: Record<string, unknown> = {};
	for (const k of keys) {
		if (k in payload) meta[k] = payload[k];
	}
	return meta;
}

function needsInputResult(payload: Record<string, unknown>, needs?: Record<string, unknown> | null): NeedsInputResult {
	// H4：每次只构造一个 request，needs.options 是答案选项（choices），不是并行
	// 请求。真实 request_id 优先取 needs.request_id，否则取顶层 request_id。
	const requestId =
		(typeof needs?.request_id === "string" && (needs.request_id as string)) ||
		(typeof payload.request_id === "string" ? (payload.request_id as string) : "") ||
		"req-1";
	const prompt = needs && typeof needs.prompt === "string" ? needs.prompt : "需要更多输入才能执行";

	// permission / 业务确认类：选项是授权范围；question 类：选项是答案。
	const options = Array.isArray(needs?.options)
		? (needs.options as Array<{ id?: string; name?: string }>)
				.map((o) => (typeof o.id === "string" ? o.id : typeof o.name === "string" ? o.name : ""))
				.filter(Boolean)
		: [];
	const kind: NeedsInputResult["interaction"]["kind"] =
		needs && needs.type === "permission"
			? "permission"
			: needs && (needs.type === "confirmation" || needs.type === "skill_plan_confirmation_request")
				? "confirmation"
				: "question";

	return {
		...resultBase(payload),
		status: "needs_input",
		interaction: {
			id: "",
			kind,
			requests: [
				{
					requestId,
					prompt,
					...(typeof needs?.command === "string" ? { command: needs.command } : {}),
					...(typeof needs?.path === "string" ? { path: needs.path } : {}),
					...(kind === "permission" || kind === "confirmation"
						? { options: (["once", "run", "session", "reject"] as const).filter((s) => !options.length || options.includes(s)) }
						: options.length
							? { options: options.map((o) => o as "once") }
							: undefined),
					reason: typeof needs?.reason === "string" ? needs.reason : undefined,
				},
			],
		},
	};
}

function failedEvent(errorCode: string, error: string): AgentEvent {
	return {
		type: "failed",
		result: {
			agentId: "puddingclaw",
			status: "failed",
			errorCode,
			error,
			recoverable: false,
		},
	};
}

export const PUDDINGCLAW_CAPABILITIES: DriverCapabilities = {
	operations: ["run", "continue", "respond", "cancel"],
	interactionKinds: ["permission", "confirmation"],
	progress: "none",
	transport: "spawn",
};
