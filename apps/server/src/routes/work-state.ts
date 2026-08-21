import type { FastifyInstance } from "fastify";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type { TeamsStore } from "../store/teams.js";
import {
	WorkStateConflictError,
	WorkStateOperationConflictError,
	type CompletionReviewMode,
	type SessionWorkStatus,
	type WorkStateStore,
} from "../store/work-state.js";
import type { AgentRuntime } from "../agent-runtime/runtime.js";
import type { ProductSettingsStore } from "../store/product-settings.js";

export function registerWorkStateRoutes(
	app: FastifyInstance,
	workStates: WorkStateStore,
	teams: TeamsStore,
	sessions: PiSessionStore,
	runtime?: AgentRuntime,
	productSettings?: ProductSettingsStore,
): void {
	const requireOwnedSession = async (sessionId: string) => {
		const window = await teams.windowForSession(sessionId);
		if (!window) throw new Error("session not found");
		return window;
	};
	const idempotencyKey = (headers: Record<string, unknown>): string => {
		const raw = headers["idempotency-key"];
		if (typeof raw !== "string" || !raw.trim()) throw new Error("Idempotency-Key header 必填");
		return raw.trim();
	};
	const sendError = (reply: import("fastify").FastifyReply, err: unknown) => {
		if (err instanceof WorkStateConflictError) return reply.code(409).send({ error: err.message, current: err.current, code: "stale_goal_state" });
		if (err instanceof WorkStateOperationConflictError) return reply.code(409).send({ error: err.message, code: err.code });
		const message = err instanceof Error ? err.message : String(err);
		return reply.code(message.includes("not found") || message.includes("不存在") ? 404 : 400).send({ error: message });
	};
	const publicDelegation = (item: Awaited<ReturnType<AgentRuntime["listDelegations"]>>[number]) => ({
		id: item.id,
		parentDelegationId: item.parentDelegationId,
		handoffKind: item.handoffKind,
		goalId: item.goalId,
		workPlanId: item.workPlanId,
		workItemId: item.workItemId,
		attempt: item.attempt,
		goalEpoch: item.goalEpoch,
		agentId: item.agentId,
		intent: item.intent,
		expectedOutcome: item.expectedOutcome,
		evidenceRequirements: item.evidenceRequirements,
		completionBoundary: item.completionBoundary,
		status: item.status,
		sessionHandle: item.sessionHandle,
		processView: true,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	});

	app.get<{ Params: { id: string }; Querystring: { goalId?: string } }>("/api/sessions/:id/work-state", async (req, reply) => {
		try {
			await requireOwnedSession(req.params.id);
			const goals = await workStates.listSessionGoals(req.params.id);
			const activeGoal = goals.find((goal) => goal.status === "active");
			const selected = req.query.goalId ? await workStates.getGoal(req.params.id, req.query.goalId) : activeGoal ?? goals[0];
			if (req.query.goalId && !selected) return reply.code(404).send({ error: "Goal 不存在" });
			const goalSummaries = await Promise.all(goals.map(async (goal) => {
				const items = Object.values(goal.plan?.items ?? {});
				const decisions = await workStates.listDecisions(req.params.id, goal.goalId);
				return {
					goalId: goal.goalId, goal: goal.goal, status: goal.status, executionStatus: goal.execution.status,
					pending: decisions.filter((item) => item.status === "pending").length + items.filter((item) => item.status === "submitted").length + (goal.plan?.needsReconcile ? 1 : 0) + (goal.execution.status === "interrupted" ? 1 : 0),
					running: ["running", "recovering", "reviewing"].includes(goal.execution.status),
					createdAt: goal.createdAt, updatedAt: goal.updatedAt,
				};
			}));
			return {
				workState: selected ?? null,
				activeGoalId: activeGoal?.goalId ?? null,
				goals: goalSummaries,
				decisions: selected ? await workStates.listDecisions(req.params.id, selected.goalId) : [],
				// Every delegation exposes a read-only process view. Pi resolves to its
				// AgentSession; spawn connectors resolve to the persisted event timeline.
				delegations: runtime && selected
					? (await runtime.listDelegations(undefined, req.params.id)).filter((item) => item.goalId === selected.goalId).map(publicDelegation)
					: [],
			};
		} catch (err) {
			return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.put<{
		Params: { id: string };
		Body: {
			goalId?: string;
			revision?: number;
			goal?: string;
			completionBoundary?: string;
			reviewMode?: CompletionReviewMode;
			reviewerModel?: string;
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
			const current = await workStates.getActive(req.params.id);
			if (!current) {
				if (productSettings && (await productSettings.get()).harness.goalActivation[window.type] === "disabled") {
					return reply.code(403).send({ error: `Harness 已禁用 ${window.type} Goal` });
				}
				if (!req.body?.goal?.trim() || !req.body?.completionBoundary?.trim()) {
					return reply.code(400).send({ error: "创建 Session Goal 需要 goal 与 completionBoundary" });
				}
				const participantAgentIds = req.body.participantAgentIds ?? window.members;
				return {
					workState: await workStates.create({
						sessionId: req.params.id,
						goal: req.body.goal,
						completionBoundary: req.body.completionBoundary,
						reviewMode: req.body.reviewMode,
						reviewerModel: req.body.reviewerModel,
						participantAgentIds,
						contractProvenance: { criteriaOrigin: "user_input", sourceMessageIds: [] },
						operationId: idempotencyKey(req.headers as Record<string, unknown>),
					}),
				};
			}
			if (req.body?.revision === undefined) {
				if (req.body?.goal?.trim() && req.body?.completionBoundary?.trim()) {
					return reply.code(409).send({ error: "当前已有进行中的 Goal，请先完成或取消后再创建下一个" });
				}
				return reply.code(400).send({ error: "更新 Session Goal 需要 revision" });
			}
			if (req.body.status === "resolved") {
				return reply.code(400).send({ error: "Goal 完成必须由 responsible manager 通过完成申请提交" });
			}
			if (!req.body.goalId?.trim()) return reply.code(400).send({ error: "更新 Session Goal 需要 goalId" });
			const { goalId, revision, ...patch } = req.body;
			return { workState: await workStates.update(req.params.id, revision, patch, idempotencyKey(req.headers as Record<string, unknown>), undefined, goalId) };
		} catch (err) {
			return sendError(reply, err);
		}
	});

	app.get<{ Params: { id: string } }>("/api/sessions/:id/work-plan", async (req, reply) => {
		try {
			await requireOwnedSession(req.params.id);
			const workState = await workStates.getActive(req.params.id);
			if (!workState) return reply.code(404).send({ error: "Session Goal 不存在" });
			const delegations = runtime ? (await runtime.listDelegations(undefined, req.params.id)).filter((item) => item.goalId === workState.goalId).map(publicDelegation) : [];
			return { workState, plan: workState.plan ?? null, delegations };
		} catch (err) { return sendError(reply, err) }
	});

	app.put<{
		Params: { id: string };
		Body: {
			expectedGoalId: string;
			expectedRevision: number;
			expectedEpoch?: number;
			title?: string;
			upsertItems: Array<{ id?: string; title: string; description?: string; assignedAgentId?: string; dependsOn?: string[]; acceptanceCriteria: string[]; sourceGoalCriteria?: string[] }>;
			removeItemIds?: string[];
			cancelItemIds?: string[];
			reopenItemIds?: string[];
			reason: string;
		};
	}>("/api/sessions/:id/work-plan", async (req, reply) => {
		try {
			await requireOwnedSession(req.params.id);
			if (!req.body.expectedGoalId?.trim()) return reply.code(400).send({ error: "更新 WorkPlan 需要 expectedGoalId" });
			const { expectedGoalId, expectedRevision, expectedEpoch, ...input } = req.body;
			const workState = await workStates.updatePlan(req.params.id, expectedRevision, input, idempotencyKey(req.headers as Record<string, unknown>), expectedEpoch, expectedGoalId);
			return { workState, plan: workState.plan };
		} catch (err) { return sendError(reply, err) }
	});

	app.post<{
		Params: { id: string; workItemId: string };
		Body: { expectedGoalId: string; expectedRevision: number; expectedEpoch?: number; verdict: "accepted" | "revision" | "blocked"; summary: string; evidenceRefs?: string[] };
	}>("/api/sessions/:id/work-items/:workItemId/review", async (req, reply) => {
		try {
			await requireOwnedSession(req.params.id);
			if (!req.body.expectedGoalId?.trim()) return reply.code(400).send({ error: "验收 WorkItem 需要 expectedGoalId" });
			const { expectedGoalId, expectedRevision, expectedEpoch, ...review } = req.body;
			const workState = await workStates.reviewWorkItem(req.params.id, req.params.workItemId, expectedRevision, review, idempotencyKey(req.headers as Record<string, unknown>), expectedEpoch, expectedGoalId);
			return { workState, workItem: workState.plan?.items[req.params.workItemId] };
		} catch (err) { return sendError(reply, err) }
	});

	app.get<{ Params: { id: string } }>("/api/sessions/:id/work-plan/summary", async (req, reply) => {
		try {
			await requireOwnedSession(req.params.id);
			const state = await workStates.getActive(req.params.id);
			if (!state) return reply.code(404).send({ error: "Session Goal 不存在" });
			const items = Object.values(state.plan?.items ?? {});
			return {
				goalId: state.goalId,
				revision: state.revision,
				epoch: state.execution.epoch,
				executionStatus: state.execution.status,
				accepted: items.filter((item) => item.status === "accepted").length,
				total: items.filter((item) => item.status !== "cancelled").length,
				pendingReview: items.filter((item) => item.status === "submitted").length,
				running: items.filter((item) => item.status === "in_progress" || item.status === "waiting_input").length,
			};
		} catch (err) { return sendError(reply, err) }
	});

	app.get<{ Params: { id: string } }>("/api/sessions/:id/goal/recovery", async (req, reply) => {
		try {
			await requireOwnedSession(req.params.id);
			const workState = await workStates.getActive(req.params.id);
			if (!workState) return reply.code(404).send({ error: "Session Goal 不存在" });
			return { goalId: workState.goalId, execution: workState.execution, revision: workState.revision };
		} catch (err) { return sendError(reply, err) }
	});

	app.post<{
		Params: { id: string };
		Body: { expectedGoalId: string; expectedRevision: number; kind?: "user" | "manager_interrupted" | "effect_unknown"; fingerprint?: string };
	}>("/api/sessions/:id/goal/interrupt", async (req, reply) => {
		try {
			await requireOwnedSession(req.params.id);
			if (!req.body.expectedGoalId?.trim()) return reply.code(400).send({ error: "暂停 Goal 需要 expectedGoalId" });
			const current = await workStates.getActive(req.params.id);
			if (!current) return reply.code(404).send({ error: "当前没有进行中的 Goal" });
			const active = runtime ? (await runtime.listDelegations(undefined, req.params.id)).filter((item) => item.goalId === current.goalId && (item.status === "running" || item.status === "waiting_input")) : [];
			const key = idempotencyKey(req.headers as Record<string, unknown>);
			const workState = await workStates.interruptGoal(req.params.id, req.body.expectedRevision, {
				kind: req.body.kind ?? "user",
				fingerprint: req.body.fingerprint?.trim() || `user:${key}`,
				delegationIds: active.map((item) => item.id),
			}, key, req.body.expectedGoalId);
			if (runtime) {
				await Promise.all(active.map((item) => runtime.cancel(item.id, { cwd: item.cwdSnapshot, env: process.env }).catch(() => undefined)));
			}
			return { workState };
		} catch (err) { return sendError(reply, err) }
	});

	app.post<{
		Params: { id: string };
		Body: { expectedGoalId: string; expectedRevision: number; ownerId?: string; leaseMs?: number };
	}>("/api/sessions/:id/goal/resume", async (req, reply) => {
		try {
			await requireOwnedSession(req.params.id);
			if (!req.body.expectedGoalId?.trim()) return reply.code(400).send({ error: "恢复 Goal 需要 expectedGoalId" });
			const key = idempotencyKey(req.headers as Record<string, unknown>);
			const workState = await workStates.resumeGoal(req.params.id, req.body.expectedRevision, {
				ownerId: req.body.ownerId?.trim() || "user",
				leaseMs: req.body.leaseMs,
			}, key, req.body.expectedGoalId);
			return { workState };
		} catch (err) { return sendError(reply, err) }
	});

	app.post<{
		Params: { id: string };
		Body: {
			expectedGoalId: string;
			expectedRevision?: number;
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
			if (!body.expectedGoalId?.trim()) return reply.code(400).send({ error: "创建决策请求需要 expectedGoalId" });
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
				}, idempotencyKey(req.headers as Record<string, unknown>), body.expectedRevision, body.expectedGoalId),
			};
		} catch (err) {
			return sendError(reply, err);
		}
	});

	app.post<{
		Params: { id: string };
		Body: { answer?: string; grantedAuthorizationScope?: string };
	}>("/api/decision-requests/:id/answer", async (req, reply) => {
		try {
			const answer = req.body?.answer?.trim();
			if (!answer) return reply.code(400).send({ error: "answer 必填" });
			const key = idempotencyKey(req.headers as Record<string, unknown>);
			const decision = await workStates.answerDecision(req.params.id, answer, req.body?.grantedAuthorizationScope, key);
			const eventId = `decision-answered:${decision.goalId}:${decision.id}`;
			await sessions.appendCustomMessageIfAbsent(
				decision.sessionId,
				eventId,
				{
					customType: "pudding:decision_answered",
					content: `Human 已回答业务决策：${decision.question}\n答案：${decision.answer}`,
					details: { decision },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			await workStates.markOutboxDelivered(eventId);
			return { decision };
		} catch (err) {
			return sendError(reply, err);
		}
	});
}
