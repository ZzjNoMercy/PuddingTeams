import type { DelegationRecord, DelegationStore, InteractionRecord } from "./delegation-store.js";
import type { InteractionResponse } from "./types.js";
import { createHash } from "node:crypto";
/** A single interaction error category, mappable to HTTP 4xx. */
export class InteractionError extends Error {
	constructor(
		readonly code: "not_found" | "not_pending" | "stale_revision" | "incomplete_responses" | "invalid_scope" | "expired" | "duplicate" | "idempotency_conflict",
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
		decisionPatch?: (status: "approved" | "rejected", interaction: InteractionRecord) => Partial<Omit<InteractionRecord, "id" | "createdAt">>,
	): Promise<{ interaction: InteractionRecord; replayed: boolean }> {
		const interaction = await this.store.getInteraction(interactionId);
		if (!interaction) throw new InteractionError("not_found", "interaction not found");

		const normalizedPayload = JSON.stringify({
			revision: input.revision,
			responses: [...input.responses].sort((a, b) => a.requestId.localeCompare(b.requestId)),
		});
		const inputHash = "sha256:" + createHash("sha256").update(normalizedPayload).digest("hex");
		// Idempotency: a replayed request_id returns the same terminal state only
		// when the normalized answers are identical.
		if (interaction.consumedRequestId === input.requestId) {
			if (interaction.consumedPayloadHash && interaction.consumedPayloadHash !== inputHash) {
				throw new InteractionError("idempotency_conflict", "same requestId was reused with different responses");
			}
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
		const duplicates = got.filter((id, index) => got.indexOf(id) !== index);
		if (missing.length > 0 || extra.length > 0 || duplicates.length > 0) {
			throw new InteractionError(
				"incomplete_responses",
				`responses must cover exactly the pending requests (missing: ${missing.join(",")}; extra: ${extra.join(",")}; duplicate: ${[...new Set(duplicates)].join(",")})`,
			);
		}

		// scope 必须在 request options 内（L3：options 为空时只允许不带 scope）。
		const byId = new Map(interaction.requests.map((r) => [r.requestId, r]));
		for (const r of input.responses) {
			if (!["approve", "reject", "answer", "confirm"].includes(r.action)) throw new InteractionError("incomplete_responses", `invalid action for ${r.requestId}`);
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

		const applied = await this.store.transitionInteraction(interactionId, interaction.revision, ["pending"], {
			status,
			revision: interaction.revision + 1,
			consumedRequestId: input.requestId,
			consumedPayloadHash: inputHash,
			...(decisionPatch?.(status, interaction) ?? {}),
		});
		if (!applied.applied || !applied.record) {
			const current = applied.record ?? await this.store.getInteraction(interactionId);
			if (current?.consumedRequestId === input.requestId && current.consumedPayloadHash === inputHash) {
				return { interaction: current, replayed: true };
			}
			throw new InteractionError("not_pending", `interaction is ${current?.status ?? "missing"}`);
		}
		return { interaction: applied.record, replayed: false };
	}

	/** Advance the owning delegation when the interaction resolves. */
	async advanceDelegation(interaction: InteractionRecord): Promise<DelegationRecord | undefined> {
		const delegation = await this.store.getDelegation(interaction.delegationId);
		if (!delegation) return undefined;
		// Delegation 的执行轴和 Receipt 只能由 Runtime 在同一个终态事务里推进。
		// Broker 只拥有 Interaction 聚合，不能自行签发 completed/cancelled 事实。
		return delegation;
	}
}
