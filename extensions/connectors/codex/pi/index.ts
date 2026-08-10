/**
 * Codex Connector 的 pi 门面（双宿主包的 pi 半边，§9.5）。
 *
 * 在 pi 里注册 codex_delegate 工具：把任务交给本机 Codex CLI
 * （codex exec --json，独立隔离会话）执行，流式回报进度，返回终态文本。
 * 完整的房间能力（manager-worker 编排、HITL、workspace 交接）由
 * PuddingTeams 提供；这里是 pi 侧的单次委托入口。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnWorker } from "@puddingteams/pwcp/spawn";
import { JsonlLineParser } from "@puddingteams/pwcp/jsonl-lines";
import { CodexEventReducer } from "../core/codex-normalize.js";

const Params = Type.Object({
	task: Type.String({ description: "交给 Codex 执行的完整任务描述（独立会话，无当前对话上下文）" }),
	cwd: Type.Optional(Type.String({ description: "Codex 的工作目录；默认当前目录" })),
	model: Type.Optional(Type.String({ description: "模型（-m）；留空用 codex 默认" })),
});

export default function codexConnector(pi: ExtensionAPI) {
	pi.registerTool({
		name: "codex_delegate",
		label: "Codex Delegate",
		description:
			"把任务委托给本机 Codex CLI（codex exec，全新隔离会话）执行并返回最终结果。" +
			"适合需要第二个 agent 独立完成的子任务：代码修改、批量重构、交叉验证。" +
			"它看不到当前对话，task 里要给足上下文。",
		promptSnippet: "Delegate a task to a local Codex CLI agent in an isolated session",
		parameters: Params,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = params.cwd ?? ctx.cwd;
			const args = ["exec", "--json", "--skip-git-repo-check", "-C", cwd, "-s", "workspace-write"];
			if (params.model) args.push("-m", params.model);
			args.push(params.task);

			const reducer = new CodexEventReducer();
			const parser = new JsonlLineParser();
			const details = () => ({ threadId: reducer.threadId, usage: reducer.usage, exitCode: res.exitCode });
			const res = await spawnWorker({
				command: "codex",
				args,
				env: process.env,
				cwd,
				signal,
				timeoutMs: 900_000,
				onStdout: (chunk) => {
					for (const raw of parser.push(chunk)) {
						const progress = reducer.push(raw);
						if (progress) onUpdate?.({ content: [{ type: "text", text: progress }], details: undefined });
					}
				},
			});
			for (const raw of parser.flush()) reducer.push(raw);

			if (res.spawnError) {
				return {
					content: [{ type: "text", text: `无法启动 codex：${res.spawnError.message}（确认已安装 Codex CLI 并 codex login）` }],
					details: details(),
				};
			}
			if (res.timedOut) {
				return { content: [{ type: "text", text: "codex 执行超时（900s），已终止。" }], details: details() };
			}
			if (res.killed) {
				return { content: [{ type: "text", text: "codex 任务已取消。" }], details: details() };
			}
			const boundary = reducer.boundary("codex");
			if (boundary.type === "completed") {
				return {
					content: [{ type: "text", text: boundary.result.content ?? "（codex 无文本输出）" }],
					details: details(),
				};
			}
			const err = boundary.type === "failed" ? boundary.result.error : "未知错误";
			return {
				content: [{ type: "text", text: `codex 执行失败（退出码 ${res.exitCode}）：${err}` }],
				details: details(),
			};
		},
	});
}
