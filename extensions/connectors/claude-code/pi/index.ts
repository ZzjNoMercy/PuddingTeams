/**
 * Claude Code Connector 的 pi 门面（双宿主包的 pi 半边，§9.5）。
 *
 * 在 pi 里注册 claude_delegate 工具：把任务交给本机 Claude Code CLI
 * （claude -p --output-format stream-json，独立隔离会话）执行，流式回报
 * 进度，返回终态文本。完整的房间能力（manager-worker 编排、HITL、
 * workspace 交接）由 PuddingTeams 提供；这里是 pi 侧的单次委托入口。
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnWorker } from "@puddingteams/pwcp/spawn";
import { JsonlLineParser } from "@puddingteams/pwcp/jsonl-lines";
import { ClaudeCodeEventReducer } from "../core/claude-code-normalize.js";

const Params = Type.Object({
	task: Type.String({ description: "交给 Claude Code 执行的完整任务描述（独立会话，无当前对话上下文）" }),
	cwd: Type.Optional(Type.String({ description: "Claude Code 的工作目录；默认当前目录" })),
	model: Type.Optional(Type.String({ description: "模型（--model）；留空用 claude 默认" })),
});

export default function claudeCodeConnector(pi: ExtensionAPI) {
	pi.registerTool({
		name: "claude_delegate",
		label: "Claude Delegate",
		description:
			"把任务委托给本机 Claude Code CLI（claude -p，全新隔离会话）执行并返回最终结果。" +
			"适合需要第二个 agent 独立完成的子任务：代码修改、批量重构、交叉验证。" +
			"它看不到当前对话，task 里要给足上下文。",
		promptSnippet: "Delegate a task to a local Claude Code CLI agent in an isolated session",
		parameters: Params,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = params.cwd ?? ctx.cwd;
			// stream-json 必须配 --verbose（CLI 约束）；独立会话 id 由本工具生成。
			const sessionId = randomUUID();
			const args = [
				"-p",
				params.task,
				"--output-format",
				"stream-json",
				"--verbose",
				"--permission-mode",
				"bypassPermissions",
				"--session-id",
				sessionId,
			];
			if (params.model) args.push("--model", params.model);

			const reducer = new ClaudeCodeEventReducer();
			const parser = new JsonlLineParser();
			const details = () => ({ sessionId: reducer.sessionId, exitCode: res.exitCode });
			const res = await spawnWorker({
				command: "claude",
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
					content: [{ type: "text", text: `无法启动 claude：${res.spawnError.message}（确认已安装 Claude Code CLI 并完成 claude 登录）` }],
					details: details(),
				};
			}
			if (res.timedOut) {
				return { content: [{ type: "text", text: "claude 执行超时（900s），已终止。" }], details: details() };
			}
			if (res.killed) {
				return { content: [{ type: "text", text: "claude 任务已取消。" }], details: details() };
			}
			const boundary = reducer.boundary("claude-code");
			if (boundary?.type === "completed" && res.exitCode === 0) {
				return {
					content: [{ type: "text", text: boundary.result.content ?? "（claude 无文本输出）" }],
					details: details(),
				};
			}
			// 缺 result 边界（协议错误）或进程退出码非零都归一为失败文本。
			const err =
				boundary?.type === "failed"
					? boundary.result.error
					: boundary
						? "进程异常退出"
						: "未收到 result 边界事件（协议错误）";
			return {
				content: [{ type: "text", text: `claude 执行失败（退出码 ${res.exitCode}）：${err}` }],
				details: details(),
			};
		},
	});
}
