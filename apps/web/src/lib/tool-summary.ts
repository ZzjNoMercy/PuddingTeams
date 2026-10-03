import type { ToolCallView } from "./types";

/** 汇总调用结果；未完成或中断的调用不能计为成功。 */
export function toolSummary(calls: ReadonlyArray<Pick<ToolCallView, "status" | "isError">>) {
	let succeeded = 0, failed = 0, running = 0, pending = 0, interrupted = 0;
	for (const call of calls) {
		if (call.status === "error" || call.isError) failed++;
		else if (call.status === "done") succeeded++;
		else if (call.status === "running") running++;
		else if (call.status === "pending") pending++;
		else if (call.status === "interrupted") interrupted++;
	}
	const parts = [`使用了 ${calls.length} 个工具`, `成功 ${succeeded} 个`, `失败 ${failed} 个`];
	if (running) parts.push(`运行中 ${running} 个`);
	if (pending) parts.push(`待运行 ${pending} 个`);
	if (interrupted) parts.push(`已中断 ${interrupted} 个`);
	return { text: parts.join("，"), running };
}
