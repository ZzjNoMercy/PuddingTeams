import path from "node:path";
import type { DelegationRecord } from "./delegation-store.js";
import type { WorkspaceChangeSet, WorkspaceExecutionScope } from "./workspace-execution.js";

/** Project platform observations into the model-visible body without promoting
 * changed paths into artifacts, existence checks, or content acceptance. */
export function workspaceHandoffNote(
	delegation: Pick<DelegationRecord, "id" | "workspaceExecutionScopeId">,
	changeSet: WorkspaceChangeSet | undefined,
	scope: WorkspaceExecutionScope | undefined,
): string {
	if (!changeSet || !scope || changeSet.executionScopeId !== scope.id
		|| delegation.workspaceExecutionScopeId !== scope.id || !changeSet.delegationIds.includes(delegation.id)) return "";
	const paths = changeSet.changedPaths.filter((name) => {
		const parts = name.split("/");
		return !path.isAbsolute(name) && !parts.includes("..") && !parts.includes(".")
			&& parts.some((part, i) => part === ".pudding" && parts[i + 1] === "handoff" && !!parts[i + 2]);
	});
	if (!paths.length) return "";
	const limit = 20;
	const observed = paths.slice(0, limit).map((name) => path.resolve(scope.executionRoot, name));
	return `\n\n平台交付路径观测：${JSON.stringify({ workspaceChangeSetId: changeSet.id, mode: changeSet.mode, promotionState: changeSet.promotionState, executionRoot: scope.executionRoot, changedHandoffPaths: observed, omitted: Math.max(0, paths.length - limit) })}`
		+ "\n这些是该 scope 相对基线的累计变更路径，可能包含删除；不是文件存在性或内容验收证明。路径属于执行目录；隔离执行未合入时不能视为目标 Workspace 产物。先核对这些路径的存在性和内容，再决定是否需要搬运；不能仅凭 Worker 文本中的 /workspace 路径推断宿主未落盘。未列出的路径也可能是未改变的已有交付物。";
}
