import type { FastifyInstance } from "fastify";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type { TeamsStore } from "../store/teams.js";
import { WorkStateConflictError, type SessionWorkStatus, type WorkStateStore } from "../store/work-state.js";
import type { AgentRuntime } from "../agent-runtime/runtime.js";

export function registerWorkStateRoutes(
	app: FastifyInstance,
	workStates: WorkStateStore,
	teams: TeamsStore,
	sessions: PiSessionStore,
	runtime?: AgentRuntime,
): void {
	const requireOwnedSession = async (sessionId: string) => {
		const window = await teams.windowForSession(sessionId);
		if (!window) throw new Error("session not found");
		return window;
	};

	app.get<{ Params: { id: string } }>("/api/sessions/:id/work-state", async (req, reply) => {
		try {
			await requireOwnedSession(req.params.id);
			return {
				workState: (await workStates.get(req.params.id)) ?? null,
				decisions: await workStates.listDecisions(req.params.id),
				delegations: runtime ? await runtime.listDelegations(undefined, req.params.id) : [],
			};
		} catch (err) {
			return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.put<{
		Params: { id: string };
		Body: {
			revision?: number;
			goal?: string;
			completionBoundary?: string;
			participantAgentIds?: string[];
			currentBrief?: string;
			waitingOn?: string;
			nextAction?: string;
			status?: SessionWorkStatus;
			artifactIds?: string[];
		};
	}>("/api/sessions/:id/work-state", async (req, reply) => {
		try {
			const window = await requireOwnedSession(req.params.id);
			const current = await workStates.get(req.params.id);
			if (!current) {
				if (!req.body?.goal?.trim() || !req.body?.completionBoundary?.trim()) {
					return reply.code(400).send({ error: "创建 Session Goal 需要 goal 与 completionBoundary" });
				}
				const participantAgentIds = req.body.participantAgentIds ?? window.members;
				return {
					workState: await workStates.create({
						sessionId: req.params.id,
						goal: req.body.goal,
						completionBoundary: req.body.completionBoundary,
						participantAgentIds,
					}),
				};
			}
			if (req.body?.revision === undefined) return reply.code(400).send({ error: "更新 Session Goal 需要 revision" });
			const { revision, ...patch } = req.body;
			return { workState: await workStates.update(req.params.id, revision, patch) };
		} catch (err) {
			if (err instanceof WorkStateConflictError) {
				return reply.code(409).send({ error: err.message, current: err.current });
			}
			const message = err instanceof Error ? err.message : String(err);
			return reply.code(message.includes("not found") ? 404 : 400).send({ error: message });
		}
	});

	app.post<{
		Params: { id: string };
		Body: {
			requestedBy?: string;
			question?: string;
			context?: string;
			options?: Array<{ id: string; label: string }>;
			blockedAction?: string;
			resumeHint?: string;
			authorizationScope?: string;
		};
	}>("/api/sessions/:id/decision-requests", async (req, reply) => {
		try {
			await requireOwnedSession(req.params.id);
			const body = req.body ?? {};
			if (!body.question || !body.blockedAction || !body.resumeHint) {
				return reply.code(400).send({ error: "question、blockedAction、resumeHint 必填" });
			}
			return {
				decision: await workStates.createDecision({
					sessionId: req.params.id,
					requestedBy: body.requestedBy?.trim() || "manager",
					question: body.question,
					context: body.context ?? "",
					options: body.options,
					blockedAction: body.blockedAction,
					resumeHint: body.resumeHint,
					authorizationScope: body.authorizationScope,
				}),
			};
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.post<{
		Params: { id: string };
		Body: { answer?: string; grantedAuthorizationScope?: string };
	}>("/api/decision-requests/:id/answer", async (req, reply) => {
		try {
			const answer = req.body?.answer?.trim();
			if (!answer) return reply.code(400).send({ error: "answer 必填" });
			const decision = await workStates.answerDecision(req.params.id, answer, req.body?.grantedAuthorizationScope);
			const state = await workStates.get(decision.sessionId);
			if (state?.status === "waiting_human") {
				await workStates.update(decision.sessionId, state.revision, {
					status: "active",
					waitingOn: "",
					nextAction: decision.resumeHint,
				}).catch(() => undefined);
			}
			await sessions.sendCustomMessage(
				decision.sessionId,
				{
					customType: "pudding:decision_answered",
					content: `Human 已回答业务决策：${decision.question}\n答案：${decision.answer}`,
					details: { decision },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return { decision };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return reply.code(message.includes("不存在") ? 404 : 400).send({ error: message });
		}
	});
}
