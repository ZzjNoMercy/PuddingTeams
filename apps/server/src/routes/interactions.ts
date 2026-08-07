import type { FastifyInstance } from "fastify";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { InteractionError } from "../agent-runtime/interaction-broker.js";
import { TeamsStore } from "../store/teams.js";

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
		return { interactions };
	});

	// 单个 interaction（含请求集合，供审批卡对账/刷新恢复）。H3：按 interaction id。
	app.get<{ Params: { id: string } }>("/api/interactions/:id", async (req, reply) => {
		const interaction = await runtime.getInteraction(req.params.id);
		if (!interaction) return reply.code(404).send({ error: "interaction not found" });
		const delegation = await runtime.getDelegationById(req.params.id);
		return { interaction, delegation };
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
			return { outcome };
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
