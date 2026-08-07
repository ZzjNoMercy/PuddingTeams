import { defineTool } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { TeamsStore, type AgentConfig, type WindowConfig } from "../store/teams.js";
import type { PiSessionStore } from "./session-store.js";
import type { AgentInvoker } from "../agent-runtime/invoker.js";

const MAX_RESULT_CHARS = 30_000;

/**
 * How long solo task sync waits for the direct window's manager session to
 * become idle before giving up. sendCustomMessage during streaming degrades
 * to a steer injection (semantics change), so we never force it — 15s covers
 * normal relay runs while keeping the tool result timely; on timeout the
 * result is still returned with `synced: false`.
 */
const SYNC_IDLE_TIMEOUT_MS = 15_000;

const TeamTaskParams = Type.Object(
	{
		task: Type.String({ description: "Task to delegate to the team worker." }),
		worker: Type.Optional(
			Type.String({
				description:
					"Name of the worker to delegate to. Omit to use the only worker in the current window.",
			}),
		),
		model: Type.Optional(
			Type.String({
				description:
					"Optional worker-specific model/analytics-model id. Most workers select a model themselves; pass this only to force a specific one.",
			}),
		),
		session: Type.Optional(
			Type.Union([Type.Literal("new"), Type.Literal("continue")], {
				description:
					'Solo only: "continue" (default) resumes the worker session recorded in that worker\'s direct chat; pass "new" when the task is unrelated to the ongoing session. Ignored inside direct/group windows.',
			}),
		),
	},
	{ description: "Delegate a task to a team worker subprocess and return its final result." },
);

type TeamTaskInput = Static<typeof TeamTaskParams>;

function truncate(text: string): string {
	if (text.length <= MAX_RESULT_CHARS) return text;
	return `${text.slice(0, MAX_RESULT_CHARS)}\n\n…(输出过长，已截断)`;
}

function workerList(workers: AgentConfig[]): string {
	return workers.map((w) => `- ${w.name}: ${w.description || "（无描述）"}`).join("\n");
}

const BASE_DESCRIPTION = [
	"Delegate a task to a team worker (a specialized subprocess agent) and return its final result.",
	"Use this when the user asks for work that belongs to a team member (e.g. data analysis via puddingclaw) instead of doing it yourself.",
	"Specify `worker` when the user names a worker. If omitted, the only worker in the current window is used.",
	"When a worker needs approval to proceed, the result reports a pending interaction; do NOT retry the task — the approval card handles it.",
].join(" ");

/**
 * Build the team_task tool bound to one manager session.
 *
 * `getSessionId` is a mutable binding: createAgentSession generates the
 * session id internally, so the tool reads it lazily at execution time.
 * Room membership is re-read from the store on every call, so changes to
 * room members are picked up immediately.
 *
 * Solo routing (§4): the whitelist is every enabled worker; the task is
 * routed to the worker's direct window (auto-created if missing) and the
 * assignment + result are mirrored into that window's message stream as
 * custom messages. The tool description carries a per-worker summary of the
 * direct window's existing sessions so the manager can pick
 * `session: "new" | "continue"` — pi reads `definition.description` per
 * turn, so a getter keeps it current; the backing cache is refreshed after
 * every delegation (and once at creation).
 */
export function createTeamTaskTool(
	store: TeamsStore,
	sessions: PiSessionStore,
	getSessionId: () => string,
	invoker: AgentInvoker,
	opts?: { solo?: boolean; log?: (msg: string) => void },
) {
	const solo = opts?.solo ?? false;
	let soloSummary = "";

	const refreshSoloSummary = async (): Promise<void> => {
		if (!solo) return;
		try {
			const agents = (await store.listAgents()).filter((a) => a.enabled !== false);
			if (agents.length === 0) {
				soloSummary = "当前没有启用的 worker，无法派活。";
				return;
			}
			const byId = new Map((await sessions.list()).map((s) => [s.id, s]));
			const lines: string[] = [];
			for (const a of agents) {
				const direct = await store.findDirectWindow(a.name);
				let windowInfo = "单聊：无（首次派活时自动创建）";
				if (direct) {
					const infos = direct.sessions
						.map((id) => byId.get(id))
						.filter((s): s is NonNullable<typeof s> => Boolean(s));
					windowInfo = infos.length
						? `单聊现有会话：${infos
								.slice(0, 3)
								.map(
									(s) =>
										`「${s.firstMessage || "新对话"}」（最近活跃 ${s.modifiedAt.slice(0, 16).replace("T", " ")}）`,
								)
								.join("；")}`
						: "单聊：已有窗口，暂无历史会话";
				}
				lines.push(`- ${a.name}：${a.description || "（无描述）"}｜${windowInfo}`);
			}
			soloSummary = lines.join("\n");
		} catch {
			// Best-effort: a stale/empty summary never blocks delegation.
		}
	};
	void refreshSoloSummary();

	/** Mirror assignment + result into the direct window's message stream. */
	const syncToWindow = async (
		window: WindowConfig,
		taskId: string,
		workerName: string,
		task: string,
		status: string,
		resultText: string,
		interaction?: { interactionId: string; revision?: number; requests?: unknown[] },
	): Promise<boolean> => {
		try {
			// Re-read the window: the active session may have moved since the
			// delegation started.
			const fresh = await store.getWindow(window.id);
			const activeSession = fresh?.activeSession ?? window.activeSession;
			const target = await sessions.open(activeSession);
			if (!target.isIdle) {
				await Promise.race([
					target.waitForIdle(),
					new Promise<void>((_resolve, reject) =>
						setTimeout(() => reject(new Error("waitForIdle timeout")), SYNC_IDLE_TIMEOUT_MS),
					),
				]);
			}
			if (!target.isIdle) return false;
			// SDK _persist writes nothing until the first assistant message
			// exists, so on a freshly auto-created window the sync would stay
			// memory-only (lost on restart, and the fileless session makes
			// ensureWindowAlive mint replacements). When the session file does
			// not exist yet, replicate the SDK's first flush — header entry
			// plus pending entries, `wx` so we never clobber — and mark the
			// SessionManager flushed so later entries append normally.
			// Private-field poke, best-effort: failure just means memory-only
			// sync, as before.
			try {
				const sm = target.sessionManager as unknown as {
					flushed?: boolean;
					sessionFile?: string;
					fileEntries?: unknown[];
				};
				if (sm.sessionFile && !existsSync(sm.sessionFile) && Array.isArray(sm.fileEntries)) {
					writeFileSync(
						sm.sessionFile,
						sm.fileEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
						{ encoding: "utf-8", flag: "wx" },
					);
					sm.flushed = true;
				}
			} catch {
				// ignore — memory-only sync is the fallback
			}
			await target.sendCustomMessage(
				{
					customType: "pudding:task_assign",
					content: task,
					display: true,
					details: { taskId, worker: workerName, windowId: window.id, from: "solo" },
				},
				{ triggerTurn: false },
			);
			if (interaction) {
				// §6.5：等待审批时，把安全投影的审批卡镜像进对方单聊窗口，用户可在
				// 该窗口直接允许/拒绝（H2：409「去处理」跳转过去后可操作）。
				await target.sendCustomMessage(
					{
						customType: "pudding:interaction_required",
						content: resultText,
						display: true,
						details: {
							taskId,
							worker: workerName,
							windowId: window.id,
							interactionId: interaction.interactionId,
							delegationId: taskId,
							status: "pending",
							revision: interaction.revision,
							requests: interaction.requests,
						},
					},
					{ triggerTurn: false },
				);
				return true;
			}
			await target.sendCustomMessage(
				{
					customType: "pudding:task_result",
					content: resultText,
					display: true,
					details: { taskId, worker: workerName, status, windowId: window.id },
				},
				{ triggerTurn: false },
			);
			return true;
		} catch {
			return false;
		}
	};

	return defineTool({
		name: "team_task",
		label: "Team Task",
		get description() {
			if (!solo) return BASE_DESCRIPTION;
			return [
				BASE_DESCRIPTION,
				"当前是 solo 对话：所有启用的 worker 都可派活。派活会自动路由到该 worker 的单聊窗口（没有则自动创建），并把任务与结果同步到该单聊的消息流。",
				'参数 `session`：默认 "continue" 续接该 worker 单聊中正在进行的 worker 会话；参考下方各 worker 单聊的现有会话摘要，任务与现有会话无关时传 "new"。',
				`可用 worker 及其单聊现状：\n${soloSummary || "（摘要加载中）"}`,
			].join(" ");
		},
		parameters: TeamTaskParams,
		async execute(_toolCallId, params, signal, onUpdate) {
			const sessionId = getSessionId();
			const window = await store.windowForSession(sessionId);
			// Sessions outside any window (legacy) behave like solo: the whole
			// enabled roster is available for delegation.
			const isSoloContext = !window || window.type === "solo";
			const members = isSoloContext
				? (await store.listAgents()).filter((a) => a.enabled !== false)
				: await store.windowMembers(window.id);

			let worker: AgentConfig | undefined;
			if (params.worker) {
				worker = members.find((m) => m.name === params.worker);
				if (!worker) {
					throw new Error(
						isSoloContext
							? `worker「${params.worker}」不存在或未启用（可用 worker：${members.map((m) => m.name).join("、") || "无"}）。`
							: `worker「${params.worker}」不在当前窗口的成员中（可用成员：${members.map((m) => m.name).join("、") || "无"}）。`,
					);
				}
			} else if (members.length === 1) {
				worker = members[0];
			} else if (members.length === 0) {
				throw new Error(
					isSoloContext
						? "当前没有启用的 worker，无法派活。请先在智能体管理中启用 worker。"
						: "当前窗口没有启用的 worker，无法派活。请在智能体管理中启用 worker，并新建包含它的单聊/群聊窗口。",
				);
			} else {
				return {
					content: [
						{
							type: "text",
							text: `当前可派活的 worker 有多个，请指定 worker 后重试。可用：\n${workerList(members)}`,
						},
					],
					details: { worker: undefined, status: "needs_input" },
				};
			}
			if (!worker) throw new Error("unreachable: no worker selected");

			// §4.1: solo tasks run inside the worker's direct window (auto-created),
			// so the worker session continuity lives where the user can see it.
			let targetWindow = window;
			if (isSoloContext) {
				targetWindow = await store.ensureDirectWindow(worker.name, () =>
					sessions.create(undefined, { type: "direct", members: [worker!.name] }),
				);
			}

			opts?.log?.(`team_task: ${sessionId} → ${worker.name} (task len ${params.task.length})`);

			const taskId = randomUUID();
			const result = await invoker.delegate({
				agent: worker,
				message: params.task,
				model: params.model,
				windowId: targetWindow?.id ?? "",
				managerSessionId: sessionId,
				managerToolCallId: taskId,
				mode: isSoloContext ? (params.session === "new" ? "run" : "continue") : "continue",
				signal,
				onUpdate: (content) => onUpdate?.({ content: [{ type: "text", text: content }], details: {} }),
			});

			const meta: Record<string, unknown> = {
				worker: result.details.worker ?? worker.name,
				status: result.status,
				delegationId: result.delegationId,
				interactionId: result.interactionId,
			};
			const picked = result.details;

			// §4.4: mirror into the direct window's message stream. Best-effort —
			// a busy target session yields synced:false instead of blocking.
			const sync = async (
				status: string,
				text: string,
				interaction?: { interactionId: string; revision?: number; requests?: unknown[] },
			): Promise<boolean> => {
				if (!isSoloContext || !targetWindow) return false;
				const ok = await syncToWindow(targetWindow, taskId, worker.name, params.task, status, text, interaction);
				void refreshSoloSummary();
				return ok;
			};
			const soloMeta = async (
				status: string,
				text: string,
				interaction?: { interactionId: string; revision?: number; requests?: unknown[] },
			) => {
				if (!isSoloContext || !targetWindow) return {};
				const synced = await sync(status, text, interaction);
				return { taskId, windowId: targetWindow.id, synced };
			};
			const syncNote = (synced: boolean | undefined) =>
				synced === undefined
					? ""
					: synced
						? `\n\n（已同步到与 ${worker.name} 的单聊）`
						: `\n\n（未能同步到与 ${worker.name} 的单聊：对方会话忙碌）`;

			// HITL（§6.2）：needs_input 时保存待处理 Interaction，返回“等待审批”
			// 结构，manager 本轮正常结束，绝不指导它重跑任务。
			if (result.status === "needs_input" || result.status === "conflict") {
				const text = result.content;
				const interaction =
					result.interactionId && result.status === "needs_input"
						? {
								interactionId: result.interactionId,
								revision: (picked as { revision?: number }).revision,
								requests: (picked as { requests?: unknown[] }).requests,
							}
						: undefined;
				const extra = await soloMeta(result.status, text, interaction);
				return {
					content: [{ type: "text", text: `${text}${syncNote(extra.synced as boolean | undefined)}` }],
					details: { ...meta, ...picked, ...extra },
				};
			}

			if (result.status === "failed") {
				const text = result.content;
				await soloMeta("error", text);
				throw new Error(text);
			}

			const text = truncate(result.content);
			const extra = await soloMeta(result.status, result.content);
			return {
				content: [{ type: "text", text: `${text}${syncNote(extra.synced as boolean | undefined)}` }],
				details: { ...meta, ...picked, ...extra },
			};
		},
	});
}
