import { randomUUID } from "node:crypto";
import type { CompletionReview, CompletionReviewCriterion } from "../store/work-state.js";

export interface CompletionReviewInput {
	goal: string;
	completionBoundary: string;
	goalRevision: number;
	currentBrief: string;
	delegations: unknown[];
	artifactIds: string[];
	artifacts: unknown[];
	humanDecisions: unknown[];
	managerEvidence: unknown[];
}

export interface CompletionReviewMeta {
	reviewerModel: string;
	reviewerSessionId: string;
}

export const COMPLETION_REVIEWER_SYSTEM_PROMPT = [
	"你是 PuddingTeams 的独立完成复核员。你与执行 manager 上下文隔离，只能根据给定的冻结目标、完成条件和证据作判断。",
	"不得修改、降低或补写用户的完成条件；不得因为执行者声称完成就判定通过；不得提出用户没有要求的新质量标准。",
	"逐项解释完成条件，并仅引用输入中真实存在的证据 ID。主观满意、授权、发布许可等无法由证据确认的条件必须判为 uncertain，并返回 needs_human。",
	"只输出一个 JSON 对象，不使用 Markdown，不解释 JSON 之外的内容。",
].join("\n");

export function buildCompletionReviewPrompt(input: CompletionReviewInput): string {
	return [
		"请复核下面 Goal 是否满足完成条件。输出结构：",
		'{"verdict":"satisfied|not_satisfied|needs_human","criteria":[{"criterion":"...","status":"satisfied|unsatisfied|uncertain","evidenceRefs":["..."],"explanation":"..."}],"gaps":["..."]}',
		"判定规则：completionBoundary 的每个非空行是一项条件；criteria 必须按原顺序逐行覆盖，criterion 原样复制对应文本，不得合并、拆分或改写。所有条件都有充分证据才可 satisfied；存在未满足条件则 not_satisfied；关键条件只能由人类确认则 needs_human。",
		"\n冻结输入：",
		JSON.stringify(input),
	].join("\n");
}

function requiredText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`reviewer 输出的 ${field} 无效`);
	return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new Error(`reviewer 输出的 ${field} 必须是字符串数组`);
	}
	return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function jsonBody(output: string): string {
	const trimmed = output.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return fenced?.[1]?.trim() ?? trimmed;
}

export function parseCompletionReview(
	output: string,
	input: CompletionReviewInput,
	meta: CompletionReviewMeta,
): CompletionReview {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(jsonBody(output)) as Record<string, unknown>;
	} catch {
		throw new Error("独立 reviewer 未返回有效 JSON");
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("独立 reviewer 输出必须是 JSON 对象");
	if (raw.verdict !== "satisfied" && raw.verdict !== "not_satisfied" && raw.verdict !== "needs_human") {
		throw new Error("独立 reviewer 返回了未知 verdict");
	}
	if (!Array.isArray(raw.criteria) || raw.criteria.length === 0) throw new Error("独立 reviewer 未逐项核对完成条件");
	const criteria: CompletionReviewCriterion[] = raw.criteria.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`reviewer criterion[${index}] 无效`);
		const criterion = item as Record<string, unknown>;
		if (criterion.status !== "satisfied" && criterion.status !== "unsatisfied" && criterion.status !== "uncertain") {
			throw new Error(`reviewer criterion[${index}].status 无效`);
		}
		return {
			criterion: requiredText(criterion.criterion, `criteria[${index}].criterion`),
			status: criterion.status,
			evidenceRefs: stringArray(criterion.evidenceRefs ?? [], `criteria[${index}].evidenceRefs`),
			explanation: requiredText(criterion.explanation, `criteria[${index}].explanation`),
		};
	});
	const expectedCriteria = input.completionBoundary.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
	if (criteria.length !== expectedCriteria.length || criteria.some((item, index) => item.criterion !== expectedCriteria[index])) {
		throw new Error("reviewer 未按冻结完成条件逐行、原序复核");
	}
	if (raw.verdict === "satisfied" && criteria.some((item) => item.status !== "satisfied")) {
		throw new Error("reviewer verdict 与逐项状态矛盾");
	}
	const allowedEvidenceRefs = new Set<string>();
	for (const collection of [input.delegations, input.artifacts, input.humanDecisions, input.managerEvidence]) {
		for (const item of collection) {
			if (item && typeof item === "object" && !Array.isArray(item) && typeof (item as { id?: unknown }).id === "string") {
				allowedEvidenceRefs.add((item as { id: string }).id);
			}
		}
	}
	for (const item of criteria) {
		const unknown = item.evidenceRefs.filter((ref) => !allowedEvidenceRefs.has(ref));
		if (unknown.length) throw new Error(`reviewer 引用了不存在的证据：${unknown.join("、")}`);
		if (raw.verdict === "satisfied" && item.evidenceRefs.length === 0) {
			throw new Error(`reviewer 未给已满足条件提供证据：${item.criterion}`);
		}
	}
	return {
		id: randomUUID(),
		goalRevision: input.goalRevision,
		mode: "independent",
		verdict: raw.verdict,
		criteria,
		gaps: stringArray(raw.gaps ?? [], "gaps"),
		reviewerModel: meta.reviewerModel,
		reviewerSessionId: meta.reviewerSessionId,
		reviewedAt: new Date().toISOString(),
	};
}
