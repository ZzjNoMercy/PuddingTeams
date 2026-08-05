// Minimal worker fixture for testing team_task: reads {message, model?,
// session_id?} on stdin and returns a completed JSON payload on stdout.
// Mirrors the PuddingClaw CLI contract (schema_version/status/reply/
// final_response/session_id).
let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
	let parsed;
	try {
		parsed = JSON.parse(input);
	} catch {
		parsed = {};
	}
	const message = typeof parsed.message === "string" ? parsed.message : "";
	const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : "echo-session-1";
	const model = typeof parsed.model === "string" ? parsed.model : undefined;
	const result = {
		schema_version: "1",
		run_id: "run-echo",
		session_id: sessionId,
		status: "completed",
		outcome: "completed",
		reply: `[echo${model ? ` / ${model}` : ""}] ${message}`,
		final_response: `echo worker 收到：${message}`,
	};
	process.stdout.write(JSON.stringify(result));
});
