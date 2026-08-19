import type { FastifyInstance } from "fastify";
import { serializePiEvent } from "../pi-bridge/bridge.js";
import type { WorkerProcessService } from "../agent-runtime/worker-process.js";
import { config } from "../config.js";

/**
 * pi worker 执行过程可视化（只读）：按 delegationId 查看 worker 的 pi 会话。
 * 历史走 JSONL 回放，运行中走内存会话的实时事件流——与 manager 会话的
 * /messages + /ws 同形，前端复用同一套渲染。
 */
export function registerWorkerProcessRoutes(app: FastifyInstance, service: WorkerProcessService): void {
	app.get<{ Params: { id: string } }>("/api/delegations/:id/process", async (req, reply) => {
		const info = await service.resolve(req.params.id);
		if (!info) return reply.code(404).send({ error: "delegation not found" });
		return info;
	});

	app.get<{ Params: { id: string } }>("/api/delegations/:id/process/messages", async (req, reply) => {
		const info = await service.resolve(req.params.id);
		if (!info) return reply.code(404).send({ error: "delegation not found" });
		if (!info.sessionHandle) return reply.code(404).send({ error: "worker session not started" });
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
			if (!info || !info.sessionHandle) {
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
