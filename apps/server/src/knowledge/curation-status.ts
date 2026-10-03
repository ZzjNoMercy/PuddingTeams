import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { KnowledgeMountSurface } from "./runtime-service.js";

export interface CurationStatusSnapshot {
 executionMode?: "worker" | "background"; recoveryRevision?: number; bindingId: string; jobId: string; status: string; jobUrl: string; message: string;
 reviewUrl?: string; reviewStatus?: string; reviewClosed?: boolean; reviewUpdatedAt?: string; failureCode?: string; createdAt: string; updatedAt: string;
 diagnostics?: { modelProvider?: string; modelId?: string; modelTurns: number; submitAttempts: number; submitErrors: number; stopReason?: string; errorCategory?: string; validationErrors?: string[] };
}
export type CurationStatusReader = (ownerId: string, jobId: string) => Promise<CurationStatusSnapshot | undefined>;
export const curationStatusParameters = Type.Object({ jobId: Type.String({ minLength: 1, maxLength: 200 }) });
export const curationStatusDescription = "按 jobId 查询知识整理任务的真实状态与审核入口，只读且不会重新提交。executionMode=worker由来源聊天的当前知识管家执行，background由后台任务执行。queued/running/submitting尚未生成审核候选，应查看原执行过程或状态卡，不能当作失败退回或重复发起整理；不要在 Wiki 正文中搜索 jobId。";

const short = (value: string | undefined, max = 200) => typeof value === "string" ? value.slice(0, max) : undefined;
const count = (value: number) => Number.isFinite(value) ? Math.min(100_000, Math.max(0, Math.floor(value))) : 0;
const oneOf = (value: string | undefined, values: string[]) => value && values.includes(value) ? value : undefined;

export function createCurationStatusTool(resolve: () => Promise<{ surface: KnowledgeMountSurface; ownerId: string }>, read: CurationStatusReader) {
 return defineTool({ name: "knowledge_curation_status", label: "查询知识整理状态", description: curationStatusDescription,
  parameters: curationStatusParameters, execute: async (toolCallId, args) => {
   const { surface, ownerId } = await resolve();
   await surface.assertCurrent();
   const record = await read(ownerId, args.jobId);
   const context = surface.tools.find(tool => tool.name === "knowledge_context");
   if (!record || !context) throw new Error("整理任务不存在或不在本轮授权范围内");
   const result = await context.execute(toolCallId, {}, undefined, undefined, {} as never);
   const block = result.content.find(item => item.type === "text");
   const mounts = block?.type === "text" ? (JSON.parse(block.text) as { mounts: { bindingId: string }[] }).mounts : [];
   if (!mounts.some(mount => mount.bindingId === record.bindingId)) throw new Error("整理任务不存在或不在本轮授权范围内");
   await surface.assertCurrent();
   const { jobId, status, jobUrl, message, reviewUrl, failureCode, createdAt, updatedAt } = record;
   const d = record.diagnostics;
   const diagnostics = d ? { modelProvider: short(d.modelProvider), modelId: short(d.modelId), modelTurns: count(d.modelTurns),
    submitAttempts: count(d.submitAttempts), submitErrors: count(d.submitErrors),
    stopReason: oneOf(d.stopReason, ["stop", "toolUse", "length", "error", "aborted"]),
    errorCategory: oneOf(d.errorCategory, ["timeout", "provider_error", "aborted", "output_limit", "no_submission"]),
    validationErrors: d.validationErrors?.filter(code => /^(invalid_directory|unknown_type|(invalid|missing|missing_source):[A-Za-z_][A-Za-z0-9_-]{0,100})$/.test(code)).slice(0, 20) } : undefined;
   return { content: [{ type: "text" as const, text: JSON.stringify({ executionMode: oneOf(record.executionMode, ["worker", "background"]), recoveryRevision: count(record.recoveryRevision ?? 0), jobId: short(jobId), status: short(status, 40), jobUrl: short(jobUrl, 2048), message: short(message, 1000), reviewUrl: short(reviewUrl, 2048), failureCode: short(failureCode, 500), createdAt: short(createdAt, 64), updatedAt: short(updatedAt, 64), reviewStatus: oneOf(record.reviewStatus, ["candidate", "pending_review", "approved", "rejected", "returned", "publishing", "published", "conflict", "failed"]), reviewClosed: record.reviewClosed === true, reviewUpdatedAt: short(record.reviewUpdatedAt, 64), diagnostics,
    nextAction: ["queued", "running", "submitting"].includes(status) ? record.executionMode === "worker" ? "来源聊天的知识管家继续执行；查看本次执行过程或状态卡，不重复提交，不因尚未完成而退回修订。" : "原任务继续执行；等待状态卡或稍后查询，不重复提交，不因尚未完成而退回修订。" : "按真实结果处理；候选生成完成不代表已经审核或发布。" }) }], details: {} };
  } });
}
