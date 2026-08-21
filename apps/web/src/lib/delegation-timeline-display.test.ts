import assert from "node:assert/strict";
import test from "node:test";
import type { DelegationTimelineEvent } from "./types";
import { timelineForDisplay } from "./delegation-timeline-display";

function event(seq: number, sourceEvent: string, title: string, overrides: Partial<DelegationTimelineEvent> = {}): DelegationTimelineEvent {
	return {
		id: `d-1:${seq}`,
		delegationId: "d-1",
		seq,
		timestamp: `2026-08-21T11:12:${String(seq).padStart(2, "0")}.000Z`,
		source: "claude-code",
		sourceEvent,
		kind: "lifecycle",
		status: "running",
		title,
		...overrides,
	};
}

test("中断终态不会吞掉 Claude Code 的中间 runtime.progress", () => {
	const visible = timelineForDisplay([
		event(1, "runtime.accepted", "PuddingTeams 已接收任务", { status: "started" }),
		event(2, "runtime.progress", "使用工具 Read: src/a.ts"),
		event(3, "runtime.progress", "使用工具 Bash: pnpm test"),
		event(4, "runtime.failed", "任务已取消", { status: "completed" }),
	]);
	assert.deepEqual(visible.map((item) => item.seq), [1, 2, 3, 4]);
});

test("只隐藏可证明重复的终态进度", () => {
	const visible = timelineForDisplay([
		event(1, "runtime.progress", "worker 正在执行…"),
		event(2, "runtime.progress", "worker 执行完成"),
		event(3, "runtime.completed", "任务已完成", { status: "completed" }),
	]);
	assert.deepEqual(visible.map((item) => item.seq), [1, 3]);
});
