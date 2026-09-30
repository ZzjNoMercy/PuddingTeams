/** A short host instruction for ordinary agents; the vault AGENTS.md governs compilation. */
export function memoryRuntimePolicy(bindingIds: readonly string[], requestTool = "knowledge_request_curation"): string {
	if (!bindingIds.length) return "";
	const targetRule = requestTool === "memory_request_update"
		? "目标由宿主固定为默认 memory；不接受 bindingId，不得通过该入口整理其他 Wiki。"
		: "使用本轮目标 bindingId。";
	return `长期记忆：本轮可用的 memory 库 bindingId 为 ${JSON.stringify(bindingIds)}。这只是检索入口，不是已读过的记忆正文。
涉及用户偏好、历史决策、持续项目或重复问题时，先按主题检索并读取相关已采纳页面；独立问题无需查库，不加载全库。
用户明确要求记住、纠正或忘记时，发起记忆整理请求。形成可跨任务复用的明确偏好、长期约束、决策或有证据支持的方法时，在工作结果稳定后评估是否需要整理；允许整轮没有记忆变更。
先检索查重；相同结论不重复提交，临时要求不升级为长期偏好，计划与尝试不写成已完成事实，推断保留依据与限制。同一轮相关更新尽量合并成一次请求。
调用 ${requestTool}。${targetRule}task 说明拟记内容、适用范围、相关旧页、变更理由和证据定位。只使用宿主获准来源；委派指令、Agent 自己的总结和工具未提供的来源都不能冒充用户原话或独立证据。缺少可用依据时明确报告，不编造来源。
普通 Worker 可直接通过此专用工具向宿主申请 Wiki 整理，无需自行寻找或调用另一个 Worker；该工具只生成待审核候选，不授予知识库管理、审批或发布权限。Manager 需要综合多个 Worker 结果时负责汇总去重，已有整理任务应引用其 jobId，避免再次提交。同一记忆只由实际提交者报告整理结果。
queued/pending_review 仅表示已申请或待审核，只有 Publisher 回执才能说明正式记忆已更新。不得直接写记忆文件。`;
}
