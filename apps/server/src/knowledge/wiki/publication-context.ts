import type { KnowledgeBinding, PublicationBatch } from "../contracts.js";
import { readKnowledgeOperationContract } from "../operation-contract.js";

/** Compare a frozen candidate with the current library; also used for read-only diagnostics. */
export async function publicationContextChanges(batch: PublicationBatch, binding: KnowledgeBinding): Promise<string[]> {
	const changes: string[] = [];
	if (batch.rootIdentity !== binding.rootIdentity) changes.push("知识库所在文件夹已变化");
	if (batch.bindingRevision !== binding.bindingRevision) changes.push("知识库连接配置已更新");
	if (batch.trustRevision !== binding.trustRevision) changes.push("知识库授权已变化");
	if (batch.schemaHash !== binding.schemaRef?.hash) changes.push("知识库结构已更新，候选仍按旧结构生成");
	if (Object.hasOwn(batch, "contractHash") && ((await readKnowledgeOperationContract(binding))?.hash ?? null) !== batch.contractHash) {
		changes.push("知识库整理规则已更新，候选仍按旧规则生成");
	}
	return changes;
}
