import type { DelegationRecord, DelegationStore, InteractionRecord } from "./delegation-store.js";
import type { InteractionResponse } from "./types.js";
/** A single interaction error category, mappable to HTTP 4xx. */
export class InteractionError extends Error {
	constructor(
		readonly code: "not_found" | "not_pending" | "stale_revision" | "incomplete_responses" | "invalid_scope" | "expired" | "duplicate",
		message: string,
	) {
		super(message);
	}
}

/**
 * InteractionBroker 校验审批提交并把 Interaction/Delegation 状态向前推进（§6.4）。
 *
 * 服务端必须校验：
 * - Interaction 属于当前窗口/manager Session（由调用方传入 windowId 校验）；
 * - revision 未过期（相等才接受）；
 * - responses 恰好覆盖当前 request 集合；
 * - 选定 scope 在该 request 的 options 内；
 * - 同一 request_id 重试返回相同结果（幂等）；
 * - 非 pending 状态拒绝二次消费。
 */
export class InteractionBroker {
	constructor(private readonly store: DelegationStore) {}

	/**
	 * Validate + apply a response submission. Returns the updated interaction.
	 * Idempotent: if `requestId` was already consumed, returns the prior result.
	 */
	async submit(
		interactionId: string,
		input: { requestId: string; revision: number; responses: InteractionResponse[] },
	): Promise<{ interaction: InteractionRecord; replayed: boolean }> {
		const interaction = await this.store.getInteraction(interactionId);
		if (!interaction) throw new InteractionError("not_found", "interaction not found");

		// Idempotency: a replayed request_id returns the same terminal state.
		if (interaction.consumedRequestId === input.requestId) {
			return { interaction, replayed: true };
		}

		if (interaction.status !== "pending") {
			throw new InteractionError("not_pending", `interaction is ${interaction.status}`);
		}
		if (interaction.revision !== input.revision) {
			throw new InteractionError("stale_revision", `revision mismatch: got ${input.revision}, want ${interaction.revision}`);
		}
		if (interaction.expiresAt && new Date(interaction.expiresAt).getTime() < Date.now()) {
			await this.store.updateInteraction(interactionId, { status: "expired" });
			throw new InteractionError("expired", "interaction expired");
		}

		// 必须恰好覆盖当前 request 集合（不允许遗漏或凭空多答）。
		const want = new Set(interaction.requests.map((r) => r.requestId));
		const got = input.responses.map((r) => r.requestId);
		const missing = [...want].filter((id) => !got.includes(id));
		const extra = got.filter((id) => !want.has(id));
		if (missing.length > 0 || extra.length > 0) {
			throw new InteractionError(
				"incomplete_responses",
				`responses must cover exactly the pending requests (missing: ${missing.join(",")}; extra: ${extra.join(",")})`,
			);
		}

		// scope 必须在 request options 内（L3：options 为空时只允许不带 scope）。
		const byId = new Map(interaction.requests.map((r) => [r.requestId, r]));
		for (const r of input.responses) {
			const req = byId.get(r.requestId);
			if (!req) continue;
			if (r.action === "reject") continue;
			const options = req.options ?? [];
			if (r.scope) {
				if (options.length === 0 || !(options as string[]).includes(r.scope as string)) {
					throw new InteractionError("invalid_scope", `scope "${r.scope}" not allowed for ${r.requestId}`);
				}
			}
		}

		const anyReject = input.responses.some((r) => r.action === "reject");
		const status = anyReject ? "rejected" : "approved";

		const updated = await this.store.updateInteraction(interactionId, {
			status,
			revision: interaction.revision + 1,
			consumedRequestId: input.requestId,
		});
		return { interaction: updated!, replayed: false };
	}

	/** Advance the owning delegation when the interaction resolves. */
	async advanceDelegation(interaction: InteractionRecord): Promise<DelegationRecord | undefined> {
		const delegation = await this.store.getDelegation(interaction.delegationId);
		if (!delegation) return undefined;
		if (interaction.status === "rejected") {
			return this.store.updateDelegation(delegation.id, {
				status: "cancelled",
				result: {
					agentId: delegation.agentId,
					status: "cancelled",
					errorCode: "rejected",
					error: "审批被拒绝",
					recoverable: true,
				},
			});
		}
		// approved: 等待 respond 完成后由 runtime 更新为 completed/failed。
		return this.store.updateDelegation(delegation.id, { status: "waiting_input" });
	}
}
