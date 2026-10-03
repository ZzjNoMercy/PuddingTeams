export const curatorJobLabels: Record<string, string> = {
	queued: "准备整理", running: "正在整理", submitting: "正在提交候选",
	pending_review: "完成 · 已生成候选", no_changes: "完成 · 无文件变更",
	needs_attention: "需要处理", failed: "整理失败", cancelled: "已取消",
};

export function curatorJobStatusLabel(status: string, failureCode?: string): string {
	return status === "failed" && failureCode === "model_timeout"
		? "整理超时"
		: curatorJobLabels[status] ?? (status || "整理记录");
}

export function isCuratorJobActive(status: string): boolean {
	return ["queued", "running", "submitting"].includes(status);
}

export function canCancelCuratorJob(status: string): boolean {
	return ["queued", "running", "needs_attention"].includes(status);
}

export function curatorJobHref(jobId: string, bindingId?: string): string {
	const query = new URLSearchParams({ job: jobId });
	if (bindingId) query.set("vault", bindingId);
	return `/knowledge?${query}`;
}

/** Registration retries preserve frozen bytes; Worker execution resumes in its chat. */
export function curatorJobRetryLabel(job: { status: string; executionMode: "worker" | "background"; canRetryRegistration?: boolean }): string | null {
	if (!["failed", "needs_attention", "cancelled"].includes(job.status)) return null;
	if (job.canRetryRegistration) return "重试登记候选";
	return job.executionMode === "background" ? "重试解析与整理" : null;
}

export function curatorSourceChatHref(origin: { windowId: string; sessionId: string } | undefined, rooms: readonly { id: string; type: string; sessions: readonly { id: string }[] }[] | null): string | null {
	if (!origin || !rooms) return null;
	const room = rooms.find((item) => item.id === origin.windowId);
	if (!room?.sessions.some((session) => session.id === origin.sessionId)) return null;
	const query = new URLSearchParams({ session: origin.sessionId });
	if (room.type === "solo") return `/?${query}`;
	query.set("room", room.id);
	return `/chats?${query}`;
}

export function curatorFailureReason(code: string, executionMode?: "worker" | "background"): string {
	if (executionMode === "worker") {
		const reason = ({
			model_timeout: "整理超时，任务已停止，尚未生成审核候选。请返回来源聊天继续。",
			model_error: "模型请求失败，请检查管理员的模型配置后返回来源聊天继续。",
			model_output_limit: "模型输出达到限制，未形成可提交候选。请返回来源聊天继续。",
			model_aborted: "模型执行已中止，未形成可提交候选。请返回来源聊天继续。",
			worker_no_submission: "管理员结束了本轮执行，但没有提交候选。请返回来源聊天继续。",
			server_restart: "服务重启中断了整理，请返回来源聊天继续。",
			candidate_manifest_conflict: "候选内容校验发生冲突，未进入审核。请返回来源聊天继续。",
		} as Record<string, string>)[code];
		if (reason) return reason;
	}
	return ({
		model_timeout: "整理超时，任务已停止，尚未生成审核候选。可以重试。",
		model_error: "模型请求失败，请检查管理员的模型配置后重试。",
		model_output_limit: "模型输出达到限制，未形成可提交候选。",
		model_aborted: "模型执行已中止，未形成可提交候选。",
		worker_no_submission: "管理员结束了本轮执行，但没有提交候选。",
		server_restart: "服务重启中断了整理，请重试。",
		candidate_manifest_conflict: "候选内容校验发生冲突，未进入审核。",
		candidate_registration_failed: "候选已固定，但登记审核批次失败。可重试登记，无需重新运行整理。",
	} as Record<string, string>)[code] ?? code;
}

export const taskStatusLabels: Record<string, string> = {
	queued: "等待开始", running: "正在整理", submitting: "准备审核", pending: "待审核", approved:"待发布", publishing: "正在发布", published: "已发布",
	failed: "未完成", unavailable: "需要处理", partial: "部分更新", conflict: "需要确认", returned: "待修改", rejected: "已拒绝", closed: "已关闭", nochanges: "无需修改", cancelled: "已取消",
};
export function taskResultLabel(result?: { added: number; updated: number; deleted: number; directories: number; attachments: number }): string {
	if (!result) return "—";
	return [result.added ? `新增 ${result.added} 篇` : "", result.updated ? `更新 ${result.updated} 篇` : "", result.deleted ? `删除 ${result.deleted} 篇` : "", result.directories ? `目录 ${result.directories} 项` : "", result.attachments ? `附件 ${result.attachments} 个` : ""].filter(Boolean).join(" · ") || "没有资料变更";
}
export function taskStatusMessage(job: { displayStatus: string; canRetryRegistration?: boolean; failureCode?: string; publication?: {state: string} }): [string, string] {
	if (job.publication?.state === "unknown") return ["更新结果待核对", "部分更新结果尚未确认，请查看各项记录后处理。不能据此重新发布。"] ;
	if (job.canRetryRegistration) return ["修改已保留，尚未送达审核", "继续提交即可，无需重新整理资料。"];
	if (job.displayStatus === "failed") return ["这次整理没有完成", job.failureCode === "model_timeout" ? "整理时间较长，本次已停止。还没有生成可审核的修改。" : job.failureCode === "model_error" ? "管理员暂时无法连接模型。请检查设置后继续整理。" : "未能完成这次资料整理。你可以查看来源，继续处理。"];
	return ({ queued: ["资料已收到，等待开始", "可以先离开，开始整理后进度会在这里更新。"], running: ["正在整理这份资料", "完成后会列出准备新增或更新的资料。"], submitting: ["正在准备审核内容", "修改正在保存，完成后即可审核。"], pending: ["修改已准备好，等你确认", "审核通过后，这些资料才会更新到知识库。"], approved:["已审核，等待更新知识库", "修改已获确认，尚未完成发布。可以查看处理结果。"], publishing: ["正在更新知识库", "你已确认修改，更新结果会显示在这里。"], published: ["资料已更新到知识库", "现在可以直接查阅本次更新的资料。"], returned: ["已退回，等待重新整理", "修改意见已保存，可以查看关联任务的进度。"], rejected: ["你已拒绝这次修改", "知识库没有因此次任务发生变化。"], conflict: ["更新需要重新确认", "资料或审核状态发生了变化，请查看修改并处理。"], partial: ["部分资料已更新", "仍有资料未能完成更新，请查看各项结果。"], closed: ["这次更新已关闭", "保留本次记录，可以继续查看来源和处理结果。"], nochanges: ["本次无需修改", "这次整理没有新增或更新资料。"], cancelled: ["整理已停止", "本次整理已取消，未生成新的资料修改。"], unavailable: ["审核记录暂不可用", "修改尚未确认，请刷新或检查记录。"] } as Record<string,[string,string]>)[job.displayStatus] ?? ["正在读取任务状态", "请稍后刷新查看。"];
}
