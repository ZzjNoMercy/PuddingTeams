import path from "node:path";
import { applyKnowledgePlan, type KnowledgePlan } from "./plans.js";
import type { KnowledgeBindingRegistry } from "./bindings.js";
import type { KnowledgeAcceptanceStore } from "./acceptance.js";
import type { KnowledgeObjectStore } from "./objects.js";
import { isControlDocument } from "./note-paths.js";
import { hashBufferSha256 } from "./hashing.js";

/** 初始化创建的首页使用同一采纳链路，已有文件绝不自动获得授权。 */
export async function applyAndAcceptKnowledgePlan(plan: KnowledgePlan, registry: KnowledgeBindingRegistry,
	deps: { acceptance: KnowledgeAcceptanceStore; objects: KnowledgeObjectStore }) {
	const { binding, receipts } = await applyKnowledgePlan(plan, registry);
	// Only files actually created from this approved plan gain navigation authority.
	// Existing external index/log documents remain unaccepted until explicitly reviewed.
	{
		const controls = [];
		for (const receipt of receipts) {
			if (receipt.status !== "created") continue;
			const relativePath = path.relative(binding.contentRoot, path.join(plan.canonicalBindingRoot, receipt.relativePath)).split(path.sep).join("/");
			if (!isControlDocument(relativePath) || !["index.md", "log.md"].includes(path.posix.basename(relativePath))) continue;
			const planned = plan.filesToCreate.find((item) => item.relativePath === receipt.relativePath)!;
			const bytes = Buffer.from(planned.content, "utf8");
			if (hashBufferSha256(bytes) !== planned.contentHash) throw new Error("已审核控制文档的内容指纹不一致");
			const object = await deps.objects.put(bytes, planned.contentHash);
			controls.push({ relativePath, contentHash: object.hash, acceptedBy: plan.ownerId });
		}
		if (controls.length) {
			const snapshot = await deps.acceptance.getSnapshot(binding.id);
			await deps.acceptance.adoptPublished(binding.id, controls, snapshot.acceptanceRevision, { operationId: `plan:${plan.planId}`, channel: "initial" });
		}
	}
	return { binding, receipts };
}
