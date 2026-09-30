import type { WorkerProcessListItem } from "./api";

/** End of one delegation within a Pi session reused by later delegations. */
export function delegationMessageEnd(item: WorkerProcessListItem, items: readonly WorkerProcessListItem[]): number {
	const sealedAt = item.receipt?.sealedAt ? Date.parse(item.receipt.sealedAt) : NaN;
	const start = Date.parse(item.createdAt);
	const nextStart = items
		.filter((candidate) => Boolean(item.sessionHandle) && candidate.delegationId !== item.delegationId && candidate.agentId === item.agentId
			&& candidate.sessionHandle === item.sessionHandle && Number.isFinite(start)
			&& Date.parse(candidate.createdAt) > start)
		.map((candidate) => Date.parse(candidate.createdAt));
	return Math.min(Number.isFinite(sealedAt) ? sealedAt + 1 : Infinity, ...nextStart);
}
