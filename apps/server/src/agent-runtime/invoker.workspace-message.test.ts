import { test } from "node:test";
import assert from "node:assert/strict";
import { messageForWorkspaceExecution } from "./invoker.js";

test("isolated_worktree 委托明确当前 cwd 已隔离，禁止 Worker 再建嵌套仓库", () => {
	const message = messageForWorkspaceExecution("create docs/result.md", {
		mode: "isolated_worktree",
		source: "manager_derived",
		reason: "write safely",
		baselineStrategy: "git_tree",
		promoteOnAcceptance: true,
	});
	assert.match(message, /current working directory is already the platform-created isolated checkout/);
	assert.match(message, /Do not run git clone, git worktree add/);
	assert.match(message, /use its existing writable \.git/);
});

test("非 isolated_worktree 委托不改写业务消息", () => {
	const original = "inspect only";
	assert.equal(messageForWorkspaceExecution(original, {
		mode: "read_only_shared",
		source: "manager_derived",
		reason: "read only",
		baselineStrategy: "filesystem_manifest",
		promoteOnAcceptance: false,
	}), original);
});
