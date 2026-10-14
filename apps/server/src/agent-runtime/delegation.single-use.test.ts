import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, type DelegateInput } from "./runtime.js";
import { DelegationStore } from "./delegation-store.js";
import { InteractionSecretStore } from "./interaction-secret-store.js";
import type { AgentDriver } from "./types.js";

test("P2 同调用并发与冷重放不双跑；后续任务 fresh；direct 保留 continue；落盘失败不启动", async () => {
 const dir = await mkdtemp(path.join(tmpdir(), "pt-single-use-"));
 try {
  const records = new DelegationStore(path.join(dir, "records")); await records.init();
  const secrets = new InteractionSecretStore(path.join(dir, "secrets")); await secrets.init();
  const calls: Array<{ mode: string; message: string; sessionHandle?: string }> = [];
  const driver = { id: "alpha", capabilities: async () => ({ operations: ["run", "continue"], interactionKinds: [], progress: "none", transport: "spawn" }),
   async *run(input: { message: string }) { calls.push({ mode: "run", ...input }); const handle = `fresh-${calls.length}`; yield { type: "started", sessionHandle: handle, runHandle: handle }; yield { type: "completed", result: { agentId: "alpha", status: "completed", content: input.message, sessionHandle: handle } }; },
   async *continue(input: { message: string; sessionHandle: string }) { calls.push({ mode: "continue", ...input }); yield { type: "completed", result: { agentId: "alpha", status: "completed", content: input.message, sessionHandle: input.sessionHandle } }; }
  } as unknown as AgentDriver;
  const create = () => new AgentRuntime(records, secrets, () => driver, { ttlMs: 60_000 });
  const runtime = create(); const ctx = { cwd: dir, env: {} };
  const input: DelegateInput = { windowId: "window", managerSessionId: "manager", managerToolCallId: "call-1", invocationKind: "manager_tool", cwdSnapshot: dir, agentId: "alpha", agentRevision: 0, message: "first", mode: "continue", sessionHandle: "old-context" };
  const [first, duplicate] = await Promise.all([runtime.delegate(input, ctx), runtime.delegate(input, ctx)]);
  assert.equal(first.delegation.id, duplicate.delegation.id); assert.equal(calls.length, 1); assert.equal(calls[0]!.mode, "run");
  assert.equal((await create().delegate(input, ctx)).delegation.id, first.delegation.id); assert.equal(calls.length, 1);
  await assert.rejects(() => runtime.delegate({ ...input, message: "changed" }, ctx), /delegation_call_conflict/);
  const next = await runtime.delegate({ ...input, managerToolCallId: "call-2", message: "explicit-only", parentDelegationId: first.delegation.id }, ctx);
  assert.notEqual(next.delegation.id, first.delegation.id); assert.notEqual(next.delegation.sessionHandle, first.delegation.sessionHandle);
  assert.equal(calls[1]!.mode, "run"); assert.equal(calls[1]!.message, "explicit-only");
  await runtime.delegate({ ...input, invocationKind: "direct_chat", managerToolCallId: undefined }, ctx);
  assert.equal(calls[2]!.mode, "continue"); assert.equal(calls[2]!.sessionHandle, "old-context");
  records.createDelegation = async () => { throw new Error("write-failed"); };
  await assert.rejects(() => runtime.delegate({ ...input, managerToolCallId: "call-3" }, ctx), /write-failed/); assert.equal(calls.length, 3);
 } finally { await rm(dir, { recursive: true, force: true }); }
});
