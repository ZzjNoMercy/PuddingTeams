import type { VerificationCriterionResult, VerificationRecord } from "../store/work-state.js";

export interface VerificationReviewInput {
	verificationId: string;
	mode: "independent_evidence_review" | "environment_verified";
	goalId: string;
	workPlanId: string;
	workItemId: string;
	submissionId: string;
	criteria: string[];
	submission: unknown;
	allowedEvidenceRefs: string[];
}

export const ENVIRONMENT_OBSERVATION_REF = "platform:environment-observation";
export type VerificationObservation = NonNullable<VerificationRecord["observations"]>[number];

export const VERIFICATION_REVIEWER_SYSTEM_PROMPT = [
	"你是 PuddingTeams 的独立 WorkItem 验收员；你的 Session 与 Executor/Manager 完全隔离。",
	"只能检查冻结条件和给定证据，不得修改条件、补充产品标准或把 Worker 自述当成自动证明。",
	"ExecutionReceipt.reportedEvidence 只是 Worker 主动提供的条件映射；它为空不能否定同一冻结输入中由平台提供的 executorSnapshot、不可伪造 observation、Workspace change-set 或自动调度证明。",
	"environment_verified 时必须基于当前隔离环境中的实际命令/文件观测；无法执行就 blocked，不得猜测 passed。",
	"只输出一个 JSON 对象，不使用 Markdown。",
].join("\n");

export function buildVerificationPrompt(input: VerificationReviewInput): string {
	return [
		"逐项核对冻结验收条件，输出：",
		'{"status":"passed|failed|blocked","integrity":"clean|suspect|violation","criteria":[{"criterion":"原文","status":"satisfied|unsatisfied|uncertain","evidenceRefs":["已允许的引用"],"explanation":"说明"}],"evidenceRefs":["汇总引用"],"failureReason":"可选"}',
		"criteria 必须原序原文覆盖；passed 要求每项 satisfied、每项至少一个允许的 evidenceRef、integrity=clean。",
		...(input.mode === "environment_verified" ? [`每个 satisfied 条件都必须引用 ${ENVIRONMENT_OBSERVATION_REF}；平台只会在真实观察到本次命令/文件/搜索活动后把它替换为不可伪造 observation ID。`] : []),
		`允许引用：${JSON.stringify(input.allowedEvidenceRefs)}`,
		`冻结输入：${JSON.stringify(input)}`,
	].join("\n");
}

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 无效`);
	return value.trim();
}
function refs(value: unknown, allowed: Set<string>, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} 必须是字符串数组`);
	const values = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
	const unknown = values.filter((item) => !allowed.has(item));
	if (unknown.length) throw new Error(`${field} 引用了未知证据：${unknown.join("、")}`);
	return values;
}
function jsonBody(output: string): string {
	const trimmed = output.trim();
	return trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim() ?? trimmed;
}

export function parseVerificationOutput(
	output: string,
	input: VerificationReviewInput,
	meta: Omit<VerificationRecord, "criteria" | "evidenceRefs" | "status" | "integrity" | "failureReason">,
): VerificationRecord {
	let raw: Record<string, unknown>;
	try { raw = JSON.parse(jsonBody(output)) as Record<string, unknown>; }
	catch { throw new Error("Verifier 未返回有效 JSON"); }
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Verifier 输出必须是 JSON 对象");
	if (raw.status !== "passed" && raw.status !== "failed" && raw.status !== "blocked") throw new Error("Verifier status 无效");
	if (raw.integrity !== "clean" && raw.integrity !== "suspect" && raw.integrity !== "violation") throw new Error("Verifier integrity 无效");
	if (!Array.isArray(raw.criteria) || raw.criteria.length !== input.criteria.length) throw new Error("Verifier 未逐项覆盖验收条件");
	const allowed = new Set(input.allowedEvidenceRefs);
	const criteria: VerificationCriterionResult[] = raw.criteria.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`criteria[${index}] 无效`);
		const item = entry as Record<string, unknown>;
		if (item.status !== "satisfied" && item.status !== "unsatisfied" && item.status !== "uncertain") throw new Error(`criteria[${index}].status 无效`);
		const criterion = text(item.criterion, `criteria[${index}].criterion`);
		if (criterion !== input.criteria[index]) throw new Error(`criteria[${index}] 必须原样复制冻结条件`);
		return { criterion, status: item.status, evidenceRefs: refs(item.evidenceRefs ?? [], allowed, `criteria[${index}].evidenceRefs`), explanation: text(item.explanation, `criteria[${index}].explanation`) };
	});
	if (raw.status === "passed" && (raw.integrity !== "clean" || criteria.some((item) => item.status !== "satisfied" || item.evidenceRefs.length === 0))) throw new Error("passed 与逐项证据/完整性矛盾");
	return {
		...meta,
		status: raw.status,
		integrity: raw.integrity,
		criteria,
		evidenceRefs: refs(raw.evidenceRefs ?? [], allowed, "evidenceRefs"),
		...(typeof raw.failureReason === "string" && raw.failureReason.trim() ? { failureReason: raw.failureReason.trim() } : {}),
	};
}

/**
 * A Verifier's prose cannot create environment evidence. The model must cite the
 * platform placeholder for every satisfied criterion; after the Run, Harness
 * replaces that placeholder only with tool/file/search events actually observed
 * in the immutable delegation timeline. An empty/no-op run therefore cannot pass.
 */
export function bindEnvironmentObservations(record: VerificationRecord, observations: VerificationObservation[]): VerificationRecord {
	const missingBinding = record.criteria.some((criterion) => criterion.status === "satisfied" && !criterion.evidenceRefs.includes(ENVIRONMENT_OBSERVATION_REF));
	if (record.status === "passed" && (observations.length === 0 || missingBinding)) {
		return {
			...record,
			status: "failed",
			integrity: "suspect",
			failureReason: observations.length === 0 ? "平台未观察到本次 Verifier 的命令、文件或搜索活动" : "Verifier 未逐项引用平台环境观测",
			observations,
		};
	}
	const observationRefs = observations.map((entry) => entry.id);
	const replace = (values: string[]) => [...new Set(values.flatMap((value) => value === ENVIRONMENT_OBSERVATION_REF ? observationRefs : [value]))];
	return {
		...record,
		criteria: record.criteria.map((criterion) => ({ ...criterion, evidenceRefs: replace(criterion.evidenceRefs) })),
		evidenceRefs: replace(record.evidenceRefs),
		observations,
	};
}
