import type { DelegationRecord } from "./delegation-store.js";
import type { AgentRuntime } from "./runtime.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type { TeamsStore } from "../store/teams.js";
import { DelegationDeliveryStore, type DelegationDeliveryRecord } from "../store/delegation-delivery.js";
import type { LargeWorkerResultStore } from "../store/large-worker-result.js";
import type { ProductSettingsStore } from "../store/product-settings.js";
import { delegationStatus, projectDelegationResult } from "./delegation-result-projection.js";

export class DelegationDelivery {
	private readonly pending = new Map<string, Promise<void>>();
	constructor(private readonly ledger: DelegationDeliveryStore, private readonly runtime: AgentRuntime,
		private readonly sessions: PiSessionStore, private readonly teams: TeamsStore,
		private readonly largeResults?: LargeWorkerResultStore, private readonly settings?: ProductSettingsStore) {}
	async publish(record: DelegationRecord, wake = true): Promise<void> {
		if (!["reported_completed", "reported_failed", "cancelled", "observation_lost"].includes(record.executionState)) return;
		if (record.result && "errorCode" in record.result && record.result.errorCode === "admission_replaced") return;
		const receiptId = record.receipt?.id ?? `observation-${record.revision}`;
		const eventId = `delegation:${record.id}:terminal:${receiptId}`;
		const active = this.pending.get(eventId); if (active) return active;
		const pending = this.deliver(record, eventId, receiptId, wake);
		this.pending.set(eventId, pending); try { await pending; } finally { this.pending.delete(eventId); }
	}
	private async deliver(record: DelegationRecord, eventId: string, receiptId: string, wake: boolean) {
		let root = record;
		const seen = new Set<string>();
		while (!root.managerToolCallId && root.parentDelegationId && root.operationId?.startsWith("admission-replacement:")) {
			if (seen.has(root.id)) throw new Error("delegation replacement cycle"); seen.add(root.id);
			const parent = await this.runtime.getDelegation(root.parentDelegationId); if (!parent) throw new Error("delegation replacement root missing"); root = parent;
		}
		const prior = (await this.ledger.list()).find(item => item.eventId === eventId);
		if (prior?.state === "gone" || prior?.state === "observed" || prior?.kind === "tool_result" && prior.state === "appended") return;
		const delivery: DelegationDeliveryRecord = prior ?? { eventId, receiptId, delegationId: record.id, ownerSessionId: root.managerSessionId, toolCallId: root.managerToolCallId, state: "pending", attempts: 0 };
		delivery.attempts++; await this.ledger.put(delivery); // reserve before any Session or model effect
		if (!await this.teams.contextForSession(delivery.ownerSessionId)) { delivery.state = "gone"; await this.ledger.put(delivery); return; }
		const state = await this.sessions.delegationDeliveryState(delivery.ownerSessionId, delivery.toolCallId, eventId);
		if (state.toolResult === "terminal") { delivery.kind = "tool_result"; delivery.state = "appended"; await this.ledger.put(delivery); return; }
		if (state.eventPresent) {
			delivery.kind = "terminal_event";
			// A crash in the wake boundary is uncertain. Never trigger another model turn just from an append acknowledgement.
			delivery.state = state.observed ? "observed" : "appended"; await this.ledger.put(delivery);
			if (wake && !state.observed) await this.wake(delivery);
			return;
		}
		if (state.streaming) return; // native toolResult still owns the write boundary
		const status = delegationStatus(record);
		const content = record.result?.status === "completed" ? record.result.content ?? "Worker 已完成。"
			: status === "observation_lost" ? "原 Run 观测丢失，执行效果未知；请先对账，禁止重跑副作用。"
			: record.result && "error" in record.result ? record.result.error : `Worker ${status}`;
		const { workspaceChangeSet, note } = await this.runtime.getWorkspaceResultContext(record);
		const projection = await projectDelegationResult({ delegationId: record.id, rootDelegationId: root.id, toolCallId: root.managerToolCallId, worker: record.agentId, status, content: content + note,
			details: { executionState: record.executionState, workerStarted: record.workerStarted, readOnlyAssessment: record.readOnlyAssessment, reportedStatus: record.result?.status, errorCode: record.result && "errorCode" in record.result ? record.result.errorCode : status === "observation_lost" ? "observation_lost" : undefined, executionReceipt: record.receipt, workspaceChangeSet,
				artifacts: record.result?.artifacts, usage: record.result?.usage, goalId: record.goalId, workItemId: record.workItemId } }, this.largeResults, this.settings);
		if (state.toolResult === "none" && root.managerToolCallId && state.hasCall && !state.streaming) {
			await this.sessions.appendToolResultIfPending(root.managerSessionId, { toolCallId: root.managerToolCallId, toolName: "delegation", text: projection.text, details: projection.details, isError: status !== "completed" });
			delivery.kind = "tool_result"; delivery.state = "appended"; await this.ledger.put(delivery); return;
		}
		delivery.kind = "terminal_event";
		const owner = await this.teams.windowForSession(root.managerSessionId);
		const triggerTurn = false;
		delivery.state = triggerTurn ? "wake_requested" : "pending"; await this.ledger.put(delivery);
		try {
			const disposition = await this.sessions.appendCustomMessageIfAbsent(root.managerSessionId, eventId,
				{ customType: "pudding:task_result", content: projection.text, details: projection.details }, { triggerTurn, deliverAs: "followUp" });
			if (disposition === "deferred") delivery.state = "deferred";
			else { const persisted = await this.sessions.delegationDeliveryState(root.managerSessionId, root.managerToolCallId, eventId); delivery.state = persisted.eventPresent ? "appended" : "pending"; }
			delivery.lastError = undefined;
		} catch (error) { delivery.lastError = String(error); }
		await this.ledger.put(delivery);
		if (wake && owner?.type !== "direct" && delivery.state === "appended") await this.wake(delivery);
	}
	private async wake(delivery: DelegationDeliveryRecord): Promise<void> {
		const context = await this.teams.contextForSession(delivery.ownerSessionId);
		if (!context?.active) { delivery.state = "deferred"; await this.ledger.put(delivery); return; }
		const wakeId = `${delivery.eventId}:wake`;
		const state = await this.sessions.delegationDeliveryState(delivery.ownerSessionId, delivery.toolCallId, wakeId);
		if (state.eventPresent) { delivery.state = state.observed ? "observed" : "wake_requested"; await this.ledger.put(delivery); return; }
		if (state.streaming) return; // wait for the natural SDK boundary; no memory-only acknowledgement
		delivery.state = "wake_requested"; await this.ledger.put(delivery);
		try {
			await this.sessions.appendCustomMessageIfAbsent(delivery.ownerSessionId, wakeId, { customType: "pudding:delegation_wake", content: "Worker 结果已到达，请依据已记录的委派结果继续处理当前请求。", details: { hidden: true, terminalEventId: delivery.eventId, delegationId: delivery.delegationId } }, { triggerTurn: true, deliverAs: "followUp" });
			const observed = await this.sessions.delegationDeliveryState(delivery.ownerSessionId, delivery.toolCallId, wakeId);
			delivery.state = observed.observed ? "observed" : "wake_requested"; delivery.lastError = undefined;
		} catch (error) { delivery.lastError = String(error); }
		await this.ledger.put(delivery);
	}
	async recover(wake = true): Promise<void> {
		const pendingIds = new Set((await this.ledger.list()).map(item => item.delegationId));
		for (const record of await this.runtime.listDelegations()) {
			if (pendingIds.has(record.id) || record.invocationKind === "manager_tool" || record.operationId?.startsWith("admission-replacement:")) await this.publish(record, wake);
		}
	}
}
