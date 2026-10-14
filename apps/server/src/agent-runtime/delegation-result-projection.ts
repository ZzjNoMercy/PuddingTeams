import type { LargeWorkerResultStore } from "../store/large-worker-result.js";
import type { ProductSettingsStore } from "../store/product-settings.js";
import type { DelegationRecord } from "./delegation-store.js";

export function delegationStatus(record: DelegationRecord): string {
	if (record.executionState === "observation_lost") return "observation_lost";
	if (record.executionState === "reported_completed") return "completed";
	if (record.executionState === "cancelled") return "cancelled";
	if (["waiting_admission", "waiting_input"].includes(record.executionState)) return "needs_input";
	return record.executionState === "reported_failed" ? "failed" : "running";
}

/** Shared bounded model-facing result, including causal identity for all paths. */
export async function projectDelegationResult(input: {
	delegationId?: string; rootDelegationId?: string; toolCallId?: string; worker: string;
	status: string; content: string; details?: Record<string, unknown>;
}, largeResults?: LargeWorkerResultStore, settings?: ProductSettingsStore) {
	let largeResult;
	try {
		largeResult = input.delegationId && largeResults && settings
			? await largeResults.project(input.delegationId, input.content, (await settings.get()).harness.workerResults)
			: { text: input.content.slice(0, 30_000), offloaded: input.content.length > 30_000, originalChars: input.content.length, estimatedTokens: Math.ceil(input.content.length / 4) };
	} catch {
		largeResult = { text: input.content.slice(0, 30_000) + "\n[完整结果外置失败；此处为有界截断，请查询原执行记录]", offloaded: false, truncated: true, originalChars: input.content.length, estimatedTokens: Math.ceil(input.content.length / 4) };
	}
	const artifacts = input.details?.artifacts as Array<{ name: string; path: string }> | undefined;
	const artifactNote = artifacts?.length ? `\n\n交付物：\n${artifacts.map(item => `- ${item.name}：${item.path}`).join("\n")}` : "";
	return {
		text: `${largeResult.text}${artifactNote}\n\n[delegationId=${input.delegationId ?? "unavailable"}; status=${input.status}]`,
		details: { ...input.details, worker: input.worker, status: input.status, delegationId: input.delegationId,
			rootDelegationId: input.rootDelegationId ?? input.delegationId, toolCallId: input.toolCallId, processView: true, largeResult },
	};
}
