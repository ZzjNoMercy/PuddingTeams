import type { FastifyInstance } from "fastify";
import { serializePiEvent } from "../pi-bridge/bridge.js";
import type { WorkerProcessService } from "../agent-runtime/worker-process.js";
import { config } from "../config.js";
import type { WorkStateStore } from "../store/work-state.js";

type VerificationProjection = "not_required" | "unverified" | "pending" | "running" | "waiting_input" | "passed" | "failed" | "blocked" | "stale";
type SettlementProjection = "pending" | "submitted" | "accepted" | "revision" | "blocked" | "cancelled";

/**
 * Worker 执行过程可视化（只读）：pi 回放完整 AgentSession，spawn CLI
 * 回放 append-only delegation timeline；两者都按 delegationId 寻址。
 */
export function registerWorkerProcessRoutes(
	app: FastifyInstance,
	service: WorkerProcessService,
	controls?: {
		cancel: (delegationId: string, signal?: AbortSignal) => Promise<void>;
		reconcile?: (delegationId: string) => Promise<{ executionState: string }>;
		takeover?: (delegationId: string, rationale: string) => Promise<{ executionState: string }>;
	},
	workStates?: WorkStateStore,
): void {
	const withTrustProjection = async <T extends Awaited<ReturnType<WorkerProcessService["resolve"]>>>(info: T) => {
		if (!info) return info;
		let verification: VerificationProjection = "not_required";
		let settlement: SettlementProjection = info.executionState === "cancelled" ? "cancelled" : "pending";
		if (workStates && info.goalId) {
			const goal = await workStates.getGoal(info.managerSessionId, info.goalId);
			const item = goal?.plan && Object.values(goal.plan.items).find((candidate) => candidate.delegationIds.includes(info.delegationId));
			if (item) {
				settlement = (["submitted", "accepted", "revision", "blocked", "cancelled"].includes(item.status) ? item.status : "pending") as SettlementProjection;
				const submission = [...item.submissions].reverse().find((candidate) => candidate.delegationId === info.delegationId);
				const record = submission?.verifications.at(-1);
				verification = record?.status ?? (item.verificationPolicy.mode === "manager_review" ? "not_required" : "unverified");
			}
		}
		return {
			...info,
			trustProjection: { execution: info.executionState, verification, settlement },
		};
	};
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
		if (info.executionState !== "waiting_admission" && info.executionState !== "running" && info.executionState !== "waiting_input" && info.executionState !== "reconciling") {
			return reply.code(409).send({ error: `delegation is already ${info.executionState}` });
		}
		if (!controls) return reply.code(501).send({ error: "delegation cancellation is unavailable" });
		try {
			await controls.cancel(req.params.id, undefined);
			const current = await service.resolve(req.params.id);
			return { requested: true, delegationId: req.params.id, executionState: current?.executionState };
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.post<{ Params: { id: string }; Body: { expectedGoalId?: string } }>("/api/delegations/:id/reconcile", async (req, reply) => {
		const info = await service.resolve(req.params.id);
		if (!info) return reply.code(404).send({ error: "delegation not found" });
		if (info.goalId && req.body?.expectedGoalId?.trim() !== info.goalId) return reply.code(409).send({ error: "Goal identity changed", code: "stale_goal_state" });
		if (info.executionState !== "observation_lost") return reply.code(409).send({ error: `delegation is ${info.executionState}` });
		if (!controls?.reconcile) return reply.code(501).send({ error: "delegation reconciliation is unavailable" });
		try {
			const record = await controls.reconcile(req.params.id);
			return { delegationId: req.params.id, executionState: record.executionState };
		} catch (error) {
			return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post<{ Params: { id: string }; Body: { expectedGoalId?: string; confirmation?: string; rationale?: string } }>("/api/delegations/:id/takeover", async (req, reply) => {
		const info = await service.resolve(req.params.id);
		if (!info) return reply.code(404).send({ error: "delegation not found" });
		if (info.goalId && req.body?.expectedGoalId?.trim() !== info.goalId) return reply.code(409).send({ error: "Goal identity changed", code: "stale_goal_state" });
		if (info.executionState !== "observation_lost") return reply.code(409).send({ error: `delegation is ${info.executionState}` });
		if (req.body?.confirmation !== "upstream_stopped") return reply.code(400).send({ error: "必须明确确认上游执行已经终止" });
		if (!controls?.takeover) return reply.code(501).send({ error: "manual takeover is unavailable" });
		try {
			const record = await controls.takeover(req.params.id, req.body?.rationale ?? "");
			return { delegationId: req.params.id, executionState: record.executionState };
		} catch (error) {
			return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.get<{ Params: { id: string } }>("/api/delegations/:id/process", async (req, reply) => {
		const info = await service.resolve(req.params.id);
		if (!info) return reply.code(404).send({ error: "delegation not found" });
		return withTrustProjection(info);
	});

	app.get<{ Params: { id: string }; Querystring: { managerSessionId?: string } }>(
		"/api/rooms/:id/delegation-processes",
		async (req) => ({
			delegations: await Promise.all((await service.list(req.params.id, req.query.managerSessionId?.trim() || undefined)).map(withTrustProjection)),
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
			executionState: info.executionState,
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
				executionState: info.executionState,
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
				socket.send(JSON.stringify({ type: "timeline_ready", live: info.live, executionState: info.executionState }));
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
