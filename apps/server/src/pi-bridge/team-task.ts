import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { TeamsStore, type AgentConfig } from "../store/teams.js";

const MAX_RESULT_CHARS = 30_000;

const TeamTaskParams = Type.Object(
	{
		task: Type.String({ description: "Task to delegate to the team worker." }),
		worker: Type.Optional(
			Type.String({
				description:
					"Name of the worker to delegate to. Omit to use the only enabled worker in the current room.",
			}),
		),
		model: Type.Optional(
			Type.String({
				description:
					"Optional worker-specific model/analytics-model id. Some workers require a model before they will run.",
			}),
		),
	},
	{ description: "Delegate a task to a team worker subprocess and return its final result." },
);

type TeamTaskInput = Static<typeof TeamTaskParams>;

const WORKER_META_KEYS = [
	"run_id",
	"session_id",
	"project_id",
	"analytics_model_id",
	"approval_mode",
	"outcome",
	"verification",
	"auto_resolved",
	"interrupt_summary",
	"model_call_count",
] as const;

function truncate(text: string): string {
	if (text.length <= MAX_RESULT_CHARS) return text;
	return `${text.slice(0, MAX_RESULT_CHARS)}\n\n…(输出过长，已截断)`;
}

function workerList(workers: AgentConfig[]): string {
	return workers.map((w) => `- ${w.name}: ${w.description || "（无描述）"}`).join("\n");
}

function needsInputText(worker: string, needsInput: unknown): string {
	if (needsInput && typeof needsInput === "object" && "prompt" in needsInput) {
		const prompt = String((needsInput as { prompt?: unknown }).prompt ?? "");
		const rawOptions = (needsInput as { options?: unknown }).options;
		const options = Array.isArray(rawOptions)
			? rawOptions
					.filter((o): o is { name?: string; id?: string } => Boolean(o) && typeof o === "object")
					.map((o) => `- ${o.name ?? o.id ?? ""}`)
					.join("\n")
			: "";
		return `worker「${worker}」需要更多输入才能执行：${prompt}${options ? `\n可选：\n${options}` : ""}`;
	}
	return `worker「${worker}」需要更多输入才能执行。`;
}

/**
 * Build the team_task tool bound to one manager session.
 *
 * `getSessionId` is a mutable binding: createAgentSession generates the
 * session id internally, so the tool reads it lazily at execution time.
 * Room membership is re-read from the store on every call, so changes to
 * room members are picked up immediately.
 */
export function createTeamTaskTool(store: TeamsStore, getSessionId: () => string, log?: (msg: string) => void) {
	return defineTool({
		name: "team_task",
		label: "Team Task",
		description: [
			"Delegate a task to a team worker (a specialized subprocess agent) and return its final result.",
			"Use this when the user asks for work that belongs to a team member (e.g. data analysis via puddingclaw) instead of doing it yourself.",
			"Specify `worker` when the user names a worker. If omitted, the only enabled worker in the current room is used.",
			"When a worker needs more input (e.g. an analytics model selection), the result reports the required options; relay them to the user and retry with the chosen value.",
		].join(" "),
		parameters: TeamTaskParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			const sessionId = getSessionId();
			const members = await store.roomMembers(sessionId);

			let worker: AgentConfig | undefined;
			if (params.worker) {
				worker = members.find((m) => m.name === params.worker);
				if (!worker) {
					throw new Error(
						`worker「${params.worker}」不在当前房间的成员中（可用成员：${members.map((m) => m.name).join("、") || "无"}）。`,
					);
				}
			} else if (members.length === 1) {
				worker = members[0];
			} else if (members.length === 0) {
				throw new Error("当前房间没有启用的 worker，无法派活。请在智能体管理中启用 worker，并把它们加入当前房间。");
			} else {
				return {
					content: [
						{
							type: "text",
							text: `当前房间有多个可用 worker，请指定 worker 后重试。可用成员：\n${workerList(members)}`,
						},
					],
					details: { worker: undefined, status: "needs_input" },
				};
			}
			if (!worker) throw new Error("unreachable: no worker selected");

			log?.(`team_task: ${sessionId} → ${worker.name} (task len ${params.task.length})`);

			const result = await store.runAgent({
				agent: worker,
				task: params.task,
				model: params.model,
				sessionId,
				signal,
				onUpdate: (content) => onUpdate?.({ content: [{ type: "text", text: content }], details: {} }),
			});

			const meta = {
				worker: result.worker,
				status: result.status,
				exitCode: result.exitCode,
				elapsedMs: result.elapsedMs,
			};
			const picked: Record<string, unknown> = {};
			for (const key of WORKER_META_KEYS) {
				if (key in result.raw) picked[key] = result.raw[key];
			}

			if (result.status === "needs_input") {
				return {
					content: [
						{
							type: "text",
							text: needsInputText(result.worker, result.raw.needs_input),
						},
					],
					details: { ...meta, ...picked },
				};
			}

			if (result.status === "error") {
				const errorCode = typeof result.raw.error_code === "string" ? result.raw.error_code : "";
				const message = typeof result.raw.error === "string" ? result.raw.error : "";
				throw new Error(
					`worker「${result.worker}」执行出错${errorCode ? `（${errorCode}）` : ""}${message ? `：${message}` : ""}`,
				);
			}

			return {
				content: [{ type: "text", text: truncate(result.content) }],
				details: { ...meta, ...picked },
			};
		},
	});
}
