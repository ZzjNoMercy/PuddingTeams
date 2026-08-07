import type { FastifyInstance } from "fastify";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { InteractionError } from "../agent-runtime/interaction-broker.js";
import { TeamsStore } from "../store/teams.js";

/**
 * M3：浏览器只拿 interaction.id；runHandle/sessionHandle 是 worker 私有句柄，
 * 不在审批 API 响应里暴露（决策 4 的边界延伸）。
 */
function stripHandles<T extends { runHandle?: string; sessionHandle?: string }>(outcome: T): Omit<T, "runHandle" | "sessionHandle"> {
	const { runHandle: _run, sessionHandle: _session, ...rest } = outcome;
	void _run;
	void _session;
	return rest;
}

/**
 * L4：浏览器只需 interaction 的公开投影——内部 providerStateRef / consumedRequestId
 * 是服务端实现细节，不下发。
 */
function projectInteraction(interaction: {
	id: string;
	delegationId: string;
	kind: string;
	requests: unknown[];
	status: string;
	revision: number;
	expiresAt?: string;
}) {
	return {
		id: interaction.id,
		delegationId: interaction.delegationId,
		kind: interaction.kind,
		requests: interaction.requests,
		status: interaction.status,
		revision: interaction.revision,
		expiresAt: interaction.expiresAt,
	};
}

/**
 * /api/interactions/*（§6.4）。
 *
 * 浏览器只拿 PuddingTeams 生成的本地 interaction.id；continuation token 等
 * provider state 永不离开 Runtime/SecretStore。所有路由都以 interaction id 为
 * 主键（不是 delegation id，二者是不同 id 命名空间）。
 */
export function registerInteractionsRoutes(
	app: FastifyInstance,
	runtime: AgentRuntime,
	invoker: AgentInvoker,
	teams: TeamsStore,
): void {
	// 列出某个窗口下的 pending 审批卡。
	app.get<{ Querystring: { windowId?: string; sessionId?: string } }>("/api/interactions", async (req) => {
		const { windowId } = req.query;
		const interactions = await runtime.listInteractions(windowId);
		return { interactions: interactions.map(projectInteraction) };
	});

	// 单个 interaction（含请求集合，供审批卡对账/刷新恢复）。H3：按 interaction id。
	app.get<{ Params: { id: string } }>("/api/interactions/:id", async (req, reply) => {
		const interaction = await runtime.getInteraction(req.params.id);
		if (!interaction) return reply.code(404).send({ error: "interaction not found" });
		const delegation = await runtime.getDelegationById(req.params.id);
		return { interaction: projectInteraction(interaction), delegation };
	});

	// 提交审批：POST /api/interactions/:id/responses
	app.post<{
		Params: { id: string };
		Body: { requestId?: string; revision?: number; responses?: unknown; windowId?: string };
	}>("/api/interactions/:id/responses", async (req, reply) => {
		const requestId = req.body?.requestId?.trim();
		const revision = req.body?.revision;
		const responses = req.body?.responses;
		if (!requestId || typeof revision !== "number") {
			return reply.code(400).send({ error: "requestId and revision are required" });
		}
		if (!Array.isArray(responses) || responses.length === 0) {
			return reply.code(400).send({ error: "responses must be a non-empty array" });
		}
		// §12.3 非当前窗口不能审批：windowId 从服务端 delegation 派生，不信任 body。
		const delegation = await runtime.getDelegationById(req.params.id);
		if (delegation && req.body?.windowId && delegation.windowId !== req.body.windowId) {
			return reply.code(403).send({ error: "interaction belongs to another window" });
		}
		try {
			const outcome = await invoker.respond(
				req.params.id,
				{
					requestId,
					revision,
					responses: (responses as Array<{ requestId: string; action: string; scope?: string }>).map((r) => ({
						requestId: String(r.requestId),
						action: String(r.action),
						scope: r.scope ? String(r.scope) : undefined,
					})),
				},
				undefined,
			);
			// M1：失败/仍在处理的审批不返回 200，前端不能显示成「已批准」。
			if (outcome.status === "failed" && (outcome.details as { errorCode?: string }).errorCode === "responding") {
				return reply.code(409).send({ error: "该审批正在处理中，请稍候", code: "responding", outcome });
			}
			if (outcome.status === "failed" || outcome.status === "cancelled") {
				return reply.code(502).send({ error: outcome.content ?? "审批处理失败", code: outcome.status, outcome });
			}
			return { outcome: stripHandles(outcome) };
		} catch (err) {
			if (err instanceof InteractionError) {
				const status = err.code === "not_found" ? 404 : err.code === "not_pending" ? 409 : 400;
				return reply.code(status).send({ error: err.message, code: err.code });
			}
			return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	// 取消一个 pending interaction（用户主动取消，非静默）。H3：按 interaction id。
	app.post<{ Params: { id: string } }>("/api/interactions/:id/cancel", async (req, reply) => {
		const delegation = await runtime.getDelegationById(req.params.id);
		if (!delegation) return reply.code(404).send({ error: "interaction not found" });
		try {
			await invoker.cancel(delegation.id, undefined);
			return { ok: true };
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});
}
