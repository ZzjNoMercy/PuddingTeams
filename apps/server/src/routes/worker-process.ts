import type { FastifyInstance } from "fastify";
import { serializePiEvent } from "../pi-bridge/bridge.js";
import type { WorkerProcessService } from "../agent-runtime/worker-process.js";
import { config } from "../config.js";
import type { WorkStateStore } from "../store/work-state.js";

/**
 * Worker 执行过程可视化（只读）：pi 回放完整 AgentSession，spawn CLI
 * 回放 append-only delegation timeline；两者都按 delegationId 寻址。
 */
export function registerWorkerProcessRoutes(
	app: FastifyInstance,
	service: WorkerProcessService,
	controls?: { cancel: (delegationId: string, signal?: AbortSignal) => Promise<void> },
	workStates?: WorkStateStore,
): void {
	/** Cancel one Run without aborting the whole manager Session. */
	app.post<{ Params: { id: string }; Body: { expectedGoalId?: string } }>("/api/delegations/:id/cancel", async (req, reply) => {
		const info = await service.resolve(req.params.id);
		if (!info) return reply.code(404).send({ error: "delegation not found" });
		if (info.goalId) {
			const expectedGoalId = req.body?.expectedGoalId?.trim();
			if (!expectedGoalId) return reply.code(400).send({ error: "终止 Goal 内的 Worker 任务需要 expectedGoalId" });
			const activeGoal = await workStates?.getActive(info.managerSessionId);
			if (expectedGoalId !== info.goalId || activeGoal?.goalId !== info.goalId) {
				return reply.code(409).send({ error: "该任务属于已结束的 Goal，只能查看执行记录", code: "stale_goal_state" });
			}
		}
		if (info.status !== "running" && info.status !== "waiting_input") {
			return reply.code(409).send({ error: `delegation is already ${info.status}` });
		}
		if (!controls) return reply.code(501).send({ error: "delegation cancellation is unavailable" });
		try {
			await controls.cancel(req.params.id, undefined);
			return { cancelled: true, delegationId: req.params.id };
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.get<{ Params: { id: string } }>("/api/delegations/:id/process", async (req, reply) => {
		const info = await service.resolve(req.params.id);
		if (!info) return reply.code(404).send({ error: "delegation not found" });
		return info;
	});

	app.get<{ Params: { id: string }; Querystring: { managerSessionId?: string } }>(
		"/api/rooms/:id/delegation-processes",
		async (req) => ({
			delegations: await service.list(req.params.id, req.query.managerSessionId?.trim() || undefined),
		}),
	);

	app.get<{ Params: { id: string } }>("/api/delegations/:id/process/messages", async (req, reply) => {
		const info = await service.resolve(req.params.id);
		if (!info) return reply.code(404).send({ error: "delegation not found" });
		if (!info.sessionHandle) return reply.code(404).send({ error: "worker session not started" });
		if (info.view !== "session") return reply.code(409).send({ error: "delegation uses activity timeline" });
		const messages = await service.messages(info.agentId, info.sessionHandle);
		if (!messages) return reply.code(404).send({ error: "worker session not found" });
		return {
			messages,
			live: info.live,
			agentId: info.agentId,
			status: info.status,
			createdAt: info.createdAt,
			runningToolCallIds: service.runningToolCallIds(info.sessionHandle),
		};
	});

	app.get<{ Params: { id: string }; Querystring: { afterSeq?: string } }>(
		"/api/delegations/:id/process/timeline",
		async (req, reply) => {
			const info = await service.resolve(req.params.id);
			if (!info) return reply.code(404).send({ error: "delegation not found" });
			const afterSeq = Math.max(0, Number(req.query.afterSeq ?? 0) || 0);
			return {
				events: await service.timeline(req.params.id, afterSeq),
				live: info.live,
				agentId: info.agentId,
				status: info.status,
				createdAt: info.createdAt,
			};
		},
	);

	app.get<{ Params: { id: string }; Querystring: { afterSeq?: string } }>(
		"/api/delegations/:id/process/timeline/ws",
		{ websocket: true },
		async (socket, req) => {
			const origin = req.headers.origin;
			let sameOrigin = false;
			if (origin) {
				try {
					sameOrigin = new URL(origin).host === req.headers.host;
				} catch {
					sameOrigin = false;
				}
			}
			if (origin && !sameOrigin && !config.allowedOrigins.includes(origin)) {
				socket.close(1008, "origin not allowed");
				return;
			}
			const info = await service.resolve(req.params.id);
			if (!info) {
				socket.close(4404, "delegation not found");
				return;
			}
			const send = (event: unknown) => {
				if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "timeline_event", event }));
			};
			const afterSeq = Math.max(0, Number(req.query.afterSeq ?? 0) || 0);
			const subscription = await service.subscribeTimeline(req.params.id, afterSeq, send);
			for (const event of subscription.events) send(event);
			if (socket.readyState === socket.OPEN) {
				socket.send(JSON.stringify({ type: "timeline_ready", live: info.live, status: info.status }));
			}
			const cleanup = () => subscription.unsubscribe();
			socket.on("close", cleanup);
			socket.on("error", cleanup);
		},
	);

	app.get<{ Params: { id: string } }>(
		"/api/delegations/:id/process/ws",
		{ websocket: true },
		async (socket, req) => {
			// 与 chat.ts 的 WS 同源策略一致。
			const origin = req.headers.origin;
			let sameOrigin = false;
			if (origin) {
				try {
					sameOrigin = new URL(origin).host === req.headers.host;
				} catch {
					sameOrigin = false;
				}
			}
			if (origin && !sameOrigin && !config.allowedOrigins.includes(origin)) {
				socket.close(1008, "origin not allowed");
				return;
			}

			const info = await service.resolve(req.params.id);
			if (!info || info.view !== "session" || !info.sessionHandle) {
				socket.close(4404, "delegation not found");
				return;
			}
			socket.send(JSON.stringify({ type: "session_ready", sessionId: info.sessionHandle }));
			const unsubscribe = service.subscribeLive(info.sessionHandle, (event) => {
				const payload = serializePiEvent(event);
				if (payload && socket.readyState === socket.OPEN) socket.send(payload);
			});
			if (!unsubscribe) {
				// 非 live：前端只展示历史，给个明确信号免得空等流式。
				socket.send(JSON.stringify({ type: "worker_offline" }));
				return;
			}
			socket.on("close", () => unsubscribe());
			socket.on("error", () => unsubscribe());
		},
	);
}
