import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DelegationDeliveryStore } from "../store/delegation-delivery.js";
import { DelegationDelivery } from "./delegation-delivery.js";
import { LargeWorkerResultStore, DEFAULT_WORKER_RESULT_CONTEXT } from "../store/large-worker-result.js";
import type { DelegationRecord } from "./delegation-store.js";
import type { AgentRuntime } from "./runtime.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import type { TeamsStore } from "../store/teams.js";
import type { ProductSettingsStore } from "../store/product-settings.js";

test("P2 terminal delivery: pending/deferred/失败不误报追加；补投、外置、冷恢复与原生结果去重", async () => {
 const dir = await mkdtemp(path.join(tmpdir(), "pt-delivery-"));
 try {
  const ledger = new DelegationDeliveryStore(path.join(dir, "delivery.json"));
  const record = { id: "delegation-1", managerSessionId: "owner", managerToolCallId: "call", invocationKind: "manager_tool", agentId: "worker", executionState: "reported_completed", revision: 2, receipt: { id: "receipt-1" }, result: { status: "completed", content: "x".repeat(100_000) } } as DelegationRecord;
  const events = new Set<string>(); let wakeCount = 0, wakeObserved = true;
  let gone = false;
  let streaming = true, result = "none", deferred = false, failure = false;
  const sent: string[] = [];
  const sessions = { delegationDeliveryState: async (_owner: string, _tool: string, eventId: string) => ({ eventPresent: events.has(eventId), observed: eventId.endsWith(":wake") && events.has(eventId) && wakeObserved, streaming, toolResult: result, hasCall: true }),
   appendCustomMessageIfAbsent: async (_owner: string, _event: string, message: { customType: string; content: string }) => { if (failure) throw new Error("receiver-failed"); if (deferred) return "deferred"; if (events.has(_event)) return "duplicate"; if (message.customType === "pudding:delegation_wake") wakeCount++; else sent.push(message.content); events.add(_event); return "delivered"; },
   appendToolResultIfPending: async () => { result = "terminal"; return true; }
  } as unknown as PiSessionStore;
  const runtime = { listDelegations: async () => [record], getWorkspaceResultContext: async () => ({ note: "", workspaceChangeSet: undefined }) } as unknown as AgentRuntime;
  const teams = { contextForSession: async () => gone ? undefined : ({ active: !deferred }), windowForSession: async () => ({ type: "solo" }) } as unknown as TeamsStore;
  const settings = { get: async () => ({ harness: { workerResults: DEFAULT_WORKER_RESULT_CONTEXT } }) } as unknown as ProductSettingsStore;
  const create = () => new DelegationDelivery(ledger, runtime, sessions, teams, new LargeWorkerResultStore(dir), settings);
  const delivery = create(); await delivery.publish(record); assert.equal((await ledger.list())[0]!.state, "pending");
  streaming = false; result = "waiting"; deferred = true; await delivery.publish(record); assert.equal((await ledger.list())[0]!.state, "deferred");
  deferred = false; failure = true; await delivery.publish(record); assert.equal(sent.length, 0); assert((await ledger.list())[0]!.lastError);
  failure = false; wakeObserved = false; await Promise.all([delivery.publish(record), delivery.publish(record)]); await create().recover();
  assert.equal(wakeCount, 1); assert.equal((await ledger.list())[0]!.state, "wake_requested", "已请求但未观察到模型时不伪造 observed");
  wakeObserved = true; await create().recover();
  assert.equal(sent.length, 1); assert(sent[0]!.length < 40_000); assert(sent[0]!.includes("delegationId=delegation-1")); assert.equal((await ledger.list())[0]!.state, "observed");
  result = "terminal"; await delivery.publish({ ...record, id: "native", receipt: { ...record.receipt!, id: "receipt-native" } });
  assert.equal(sent.length, 1); assert.equal((await ledger.list()).find(item => item.delegationId === "native")!.kind, "tool_result");
  gone = true; await delivery.publish({ ...record, id: "gone", receipt: { ...record.receipt!, id: "receipt-gone" } });
  assert.equal((await ledger.list()).find(item => item.delegationId === "gone")!.state, "gone"); assert.equal(sent.length, 1);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
