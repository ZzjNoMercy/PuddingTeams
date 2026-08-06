import type { FastifyInstance } from "fastify";
import { AgentRuntime } from "../agent-runtime/runtime.js";
import { AgentInvoker } from "../agent-runtime/invoker.js";
import { InteractionError } from "../agent-runtime/interaction-broker.js";
import { TeamsStore } from "../store/teams.js";

/**
 * /api/interactions/*（§6.4）。
 *
 * 浏览器只拿 PuddingTeams 生成的本地 interaction.id；continuation token 等
 * provider state 永不离开 Runtime/SecretStore。
 */
export function registerInteractionsRoutes(
	app: FastifyInstance,
	runtime: AgentRuntime,
	invoker: AgentInvoker,
	teams: TeamsStore,
): void {
	// 列出某个窗口（或 manager session）下的 pending 审批。
	app.get<{ Querystring: { windowId?: string; sessionId?: string } }>("/api/interactions", async (req) => {
		const { windowId, sessionId } = req.query;
		const list = await runtime.listDelegations(windowId, sessionId);
		return { interactions: list };
	});

	// 单个 interaction（含请求集合，供审批卡对账/刷新恢复）。
	app.get<{ Params: { id: string } }>("/api/interactions/:id", async (req, reply) => {
		const interaction = await runtime.getDelegation(req.params.id);
		if (!interaction) {
			// interaction 与 delegation 同 id 集合；也尝试按 interaction id 查。
			const all = await runtime.listDelegations();
			const hit = all.find((d) => d.id === req.params.id);
			if (!hit) return reply.code(404).send({ error: "interaction not found" });
			return { interaction: hit };
		}
		return { interaction };
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
		// 非当前窗口不能审批该 Interaction（§12.3）。
		const delegation = await runtime.getDelegation(req.params.id);
		const windowId = req.body?.windowId;
		if (windowId && delegation && delegation.windowId !== windowId) {
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

	// 取消一个 delegation（用户主动取消，非静默）。
	app.post<{ Params: { id: string } }>("/api/interactions/:id/cancel", async (req, reply) => {
		try {
			await invoker.cancel(req.params.id, undefined);
			return { ok: true };
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});
}
