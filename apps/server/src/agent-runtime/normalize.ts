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
		if (needs?.type === "user_input") {
			providerState.interaction_type = "user_input";
			providerState.upstream_request_id = requestIdOf(payload, needs);
			providerState.questions = userInputQuestions(needs).map((question) => ({
				requestId: question.requestId,
				questionId: question.questionId,
				optionIds: question.optionIds,
				type: question.type,
			}));
		}
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

	// completed：主聊天卡只接收上游明确声明的最终回复。token、segment、
	// 中间 assistant 内容已经逐事件进入 delegation timeline，不能在这里
	// 拼接或把整个协议 payload 当成正文展示。
	const content =
		(typeof payload.final_response === "string" && payload.final_response
			? payload.final_response
			: typeof payload.reply === "string" && payload.reply
				? payload.reply
				: "（puddingclaw 无最终文本输出）");
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
	const requestId = requestIdOf(payload, needs);
	const prompt = needs && typeof needs.prompt === "string" ? needs.prompt : "需要更多输入才能执行";

	// Only permission options are authorization scopes. Questions and business
	// confirmations keep their exact choices so the user can answer the Worker.
	const options = Array.isArray(needs?.options)
		? (needs.options as Array<{ id?: string; name?: string }>)
				.map((o) => (typeof o.id === "string" ? o.id : typeof o.name === "string" ? o.name : ""))
				.filter(Boolean)
		: [];
	const needsType = typeof needs?.type === "string" ? needs.type : "";
	const isPermission = needsType === "permission" || needsType === "permission_request";
	const isConfirmation = needsType === "confirmation"
		|| needsType === "skill_plan_confirmation"
		|| needsType === "skill_plan_confirmation_request";
	const kind: NeedsInputResult["interaction"]["kind"] = isPermission
		? "permission"
		: isConfirmation
			? "confirmation"
			: "question";

	const structuredQuestions = needsType === "user_input" ? userInputQuestions(needs ?? {}) : [];
	return {
		...resultBase(payload),
		status: "needs_input",
		interaction: {
			id: "",
			kind,
			requests: structuredQuestions.length ? structuredQuestions.map((question) => ({
				requestId: question.requestId,
				prompt: question.prompt,
				...(question.optionIds.length ? { options: question.optionIds } : {}),
				...(typeof needs?.reason === "string" ? { reason: needs.reason } : {}),
			})) : [
				{
					requestId,
					prompt,
					...(typeof needs?.command === "string" ? { command: needs.command } : {}),
					...(typeof needs?.path === "string" ? { path: needs.path } : {}),
					...(kind === "permission"
						// PuddingClaw 的权限层会把精确授权目标编码进 option，例如
						// exact_directory_run / exact_directory_session。它们是授权
						// 目标，不是 Platform 对外协议的 scope；必须归一化为 CLI
						// 能接受的 once/session。不能在丢失映射后回退成 session，
						// 否则前端会展示一个服务端并未提供的长期授权按钮。
						? { options: normalizeApprovalScopes(options) }
						: options.length
							? { options }
							: undefined),
					reason: typeof needs?.reason === "string" ? needs.reason : undefined,
				},
			],
		},
	};
}

function requestIdOf(payload: Record<string, unknown>, needs?: Record<string, unknown> | null): string {
	return (typeof needs?.request_id === "string" && needs.request_id)
		|| (typeof payload.request_id === "string" ? payload.request_id : "")
		|| "req-1";
}

interface NormalizedUserInputQuestion {
	requestId: string;
	questionId: string;
	prompt: string;
	type: string;
	optionIds: string[];
}

/**
 * PuddingClaw 的业务 HITL 是一个上游 request，内部包含 1–3 个 question。
 * PWCP 把每个 question 投影成必须逐项回答的 InteractionRequest；私有
 * providerState 保留 request/question 映射，respond 时再组装回同一 Run。
 */
function userInputQuestions(needs: Record<string, unknown>): NormalizedUserInputQuestion[] {
	const questions = Array.isArray(needs.questions) ? needs.questions : [];
	return questions.flatMap((raw, index) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
		const question = raw as Record<string, unknown>;
		const questionId = typeof question.id === "string" && question.id ? question.id : `question-${index + 1}`;
		const prompt = typeof question.prompt === "string" && question.prompt ? question.prompt : "需要你的选择";
		const options = Array.isArray(question.options) ? question.options : [];
		const optionIds = options.map((option) => {
			if (typeof option === "string") return option;
			if (!option || typeof option !== "object" || Array.isArray(option)) return "";
			const item = option as Record<string, unknown>;
			return typeof item.id === "string" && item.id
				? item.id
				: typeof item.name === "string" && item.name
					? item.name
					: typeof item.label === "string" ? item.label : "";
		}).filter(Boolean);
		return [{
			requestId: questionId,
			questionId,
			prompt,
			type: typeof question.type === "string" ? question.type : "text",
			optionIds,
		}];
	});
}

/**
 * Convert worker-specific permission options into the PWCP scope contract.
 *
 * PuddingClaw deliberately exposes target-qualified values (for example
 * `exact_directory_session`) so the backend can enforce the exact grant. The
 * Platform only needs to present the portable approval scope and the driver
 * can then send `once`/`session` back to the worker. Unknown values are not
 * promoted into a reusable scope; this is fail-closed.
 */
function normalizeApprovalScopes(options: string[]): string[] {
	const scopes = new Set<string>();
	for (const option of options) {
		if (option === "once" || option === "run" || option.endsWith("_run")) {
			scopes.add("once");
		} else if (option === "session" || option.endsWith("_session")) {
			scopes.add("session");
		}
	}
	// An empty/unknown permission option set must not manufacture a reusable
	// grant. A one-time approval is the safe compatibility default.
	if (scopes.size === 0) scopes.add("once");
	return [...scopes, "reject"];
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
	interactionKinds: ["permission", "question", "confirmation"],
	// All public Headless JSONL events are projected into the Runtime timeline;
	// terminal content remains the separately normalized final response.
	progress: "stream",
	transport: "spawn",
};
