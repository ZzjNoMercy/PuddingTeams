#!/usr/bin/env node
/**
 * echo CLI fixture：声明式 Connector 样例（§10.3 第 1 级）的本地可执行
 * 脚本，零依赖。输出 JSONL 事件流，配合包 manifest 的 declarative mapping
 * 被核心 DeclarativeDriver 归一成 PWCP 边界事件。
 *
 *   node cli.mjs --version                  → 打印 echo-cli 0.1.0
 *   node cli.mjs run <message>              → 新 session 的 JSONL 事件流
 *   node cli.mjs resume <sessionId> <msg>   → 复用传入 sessionId 的事件流
 */
const [, , cmd, ...rest] = process.argv;

if (cmd === "--version") {
	console.log("echo-cli 0.1.0");
	process.exit(0);
}

function emit(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

if (cmd === "run" || cmd === "resume") {
	const message = cmd === "run" ? (rest[0] ?? "") : (rest[1] ?? "");
	const sessionId = cmd === "resume" ? rest[0] : `echo-${Date.now()}`;
	emit({ type: "session.started", session_id: sessionId, run_id: `run-${Math.random().toString(36).slice(2, 10)}` });
	emit({ type: "progress", text: "echo 处理中" });
	emit({ type: "message.completed", text: `ECHO: ${message}` });
	emit({ type: "done", usage: { input_tokens: 10, output_tokens: 5 } });
	process.exit(0);
}

console.error(`未知命令：${cmd ?? "(空)"}（支持 --version / run / resume）`);
process.exit(2);
