import assert from "node:assert/strict";
import test from "node:test";
import { workerProcessPresentation } from "./worker-process-presentation";

test("只有 waiting_admission 投影为等待 Teams 准入", () => {
	assert.equal(workerProcessPresentation({ executionState: "waiting_admission", workerStarted: false }), "waiting_admission");
	assert.equal(workerProcessPresentation({ executionState: "waiting_admission", workerStarted: true }), "waiting_admission");
});

test("已完成是权威终态，不被缺失的 workerStarted 证据降级为等待准入", () => {
	assert.equal(workerProcessPresentation({ executionState: "reported_completed", workerStarted: false }), "process");
	assert.equal(workerProcessPresentation({ executionState: "reported_completed", workerStarted: true }), "process");
});

test("未观测到启动边界时区分启动中与启动前终态", () => {
	assert.equal(workerProcessPresentation({ executionState: "admitted", workerStarted: false }), "starting");
	assert.equal(workerProcessPresentation({ executionState: "running", workerStarted: false }), "starting");
	assert.equal(workerProcessPresentation({ executionState: "reported_failed", workerStarted: false }), "terminal_without_start_evidence");
	assert.equal(workerProcessPresentation({ executionState: "cancelled", workerStarted: false }), "terminal_without_start_evidence");
	assert.equal(workerProcessPresentation({ executionState: "observation_lost", workerStarted: false }), "process", "effect_unknown 仍需保留过程与重新对账入口");
});
