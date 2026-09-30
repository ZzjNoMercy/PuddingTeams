import type { WikiPublicationDetail } from "../../lib/api";

export function publicationFeedback(publication: WikiPublicationDetail) {
	if (!["conflict", "unknown", "partial"].includes(publication.state)) return null;
	const beforeWrite = publication.state === "conflict" && publication.conflictReason === "publish_preflight" &&
		publication.files.every(file => ["pending", "conflict"].includes(file.status) && file.receipts.every(receipt => receipt.step === "preflight"));
	const reason = publication.stopReason ?? {
		publish_preflight: "发布前检查未通过，系统已停止这批发布。",
		publish_rejected: "这批内容包含不允许发布的操作。",
		publish_external: "知识库文件在候选生成后发生了变化，系统已停止覆盖。",
		publish_interrupted: "发布过程中出现失败，系统已停止后续写入。",
		publish_uncertain: "发布过程中断，尚不能确认所有文件的写入结果。",
		review_window_expired: "审核有效期已过，需要重新生成候选并审核。",
	}[publication.conflictReason ?? "publish_uncertain"];
	const needsReconcile = publication.state === "unknown" || publication.files.some(file => file.status === "uncertain");
	return {
		title: needsReconcile ? "发布结果需要确认" : publication.state === "partial" ? "这批内容只发布了一部分" : "这批内容未完成发布",
		reason,
		impact: beforeWrite ? `本次未写入任何文件，${publication.files.length} 项变更均未执行。` :
			`已提交 ${publication.committedGroups.length} 组变更，请查看下面每个文件的结果。`,
		action: needsReconcile ? "先等待系统核对发布结果；结果确认前，请勿重复发布。" :
			publication.currentContextChanges?.some(change => /无法访问/.test(change)) ? "先恢复知识库连接或授权，再让知识管家重新生成候选并审核。" :
			"让知识管家按当前知识库重新生成候选，再审核发布。重复确认这批旧候选不会解决冲突。",
	};
}
