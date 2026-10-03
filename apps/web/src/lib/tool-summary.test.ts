import assert from "node:assert/strict";
import test from "node:test";
import { toolSummary } from "./tool-summary";

test("成功和失败合并为一行汇总", () => {
	assert.deepEqual(toolSummary([{ status: "done" }, { status: "error" }]), {
		text: "使用了 2 个工具，成功 1 个，失败 1 个", running: 0,
	});
});

test("全部成功仍明确失败为零", () => {
	assert.equal(toolSummary([{ status: "done" }, { status: "done" }]).text, "使用了 2 个工具，成功 2 个，失败 0 个");
});

test("isError 结果不计为成功，也不重复计数", () => {
	assert.equal(toolSummary([{ status: "done", isError: true }, { status: "error", isError: true }]).text, "使用了 2 个工具，成功 0 个，失败 2 个");
});

test("进行中和等待中的调用不会伪装成成功", () => {
	assert.deepEqual(toolSummary([{ status: "done" }, { status: "running" }, { status: "pending" }]), {
		text: "使用了 3 个工具，成功 1 个，失败 0 个，运行中 1 个，待运行 1 个", running: 1,
	});
});

test("中断不是成功或工具失败", () => {
	assert.equal(toolSummary([{ status: "interrupted" }, { status: "error" }]).text, "使用了 2 个工具，成功 0 个，失败 1 个，已中断 1 个");
});

test("空调用清单不会产生负数", () => {
	assert.equal(toolSummary([]).text, "使用了 0 个工具，成功 0 个，失败 0 个");
});
