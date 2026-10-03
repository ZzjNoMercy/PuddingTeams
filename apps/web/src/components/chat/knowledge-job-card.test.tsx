import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KnowledgeJobCard } from "./knowledge-job-card";

test("聊天中的历史通用失败卡按结构化错误码直接显示超时和重试入口", () => {
	const html = renderToStaticMarkup(createElement(KnowledgeJobCard, {
		content: "知识整理失败，请查看任务详情。",
		details: { status: "failed", failureCode: "model_timeout", jobId: "job-1", bindingId: "vault-1" },
	}));
	assert.match(html, /role="alert"/);
	assert.match(html, /知识库整理：整理超时/);
	assert.match(html, /整理超时，任务已停止，尚未生成审核候选/);
	assert.match(html, /查看任务并重试/);
	assert.match(html, /href="\/knowledge\?job=job-1&amp;vault=vault-1"/);
	assert.doesNotMatch(html, /知识整理失败，请查看任务详情|model_timeout/);
});

test("没有明确超时证据的失败不猜测原因；运行与候选卡不显示失败警报", () => {
	const unknown = renderToStaticMarkup(createElement(KnowledgeJobCard, { content: "Worker 未提交有效候选", details: { status: "failed" } }));
	assert.match(unknown, /Worker 未提交有效候选/); assert.doesNotMatch(unknown, /超时/);
	for (const status of ["running", "pending_review"]) {
		const html = renderToStaticMarkup(createElement(KnowledgeJobCard, { content: "阶段回执", details: { status, failureCode: "model_timeout" } }));
		assert.doesNotMatch(html, /role="alert"|超时|重试/);
	}
});

test("聊天 Worker 失败仅引导查看任务，不误导启动后台重试", () => {
	const html = renderToStaticMarkup(createElement(KnowledgeJobCard, {
		content: "聊天 Worker 整理失败，请回来源聊天继续。",
		details: { status: "failed", failureCode: "worker_no_submission", executionMode: "worker", jobId: "worker-job", bindingId: "vault-1" },
	}));
	assert.match(html, /查看整理任务/);
	assert.match(html, /href="\/knowledge\?job=worker-job&amp;vault=vault-1"/);
	assert.doesNotMatch(html, /查看任务并重试/);
	const timeout = renderToStaticMarkup(createElement(KnowledgeJobCard, {
		content: "整理超时。",
		details: { status: "failed", failureCode: "model_timeout", executionMode: "worker", jobId: "worker-job" },
	}));
	assert.match(timeout, /返回来源聊天继续/);
	assert.doesNotMatch(timeout, /重试/);
});
