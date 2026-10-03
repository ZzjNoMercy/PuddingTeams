import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { directConversationHistory } from "./direct-history.js";

test("无 Worker 句柄时从持久聊天恢复用户和回复，排除当前消息、状态卡和未来分支", () => {
	const manager = SessionManager.inMemory("/tmp");
	manager.appendCustomMessageEntry("pudding:user_message", "原始饭局请求", true, { operationId: "original", executionText: "原始饭局请求\n附件：冻结原件" });
	manager.appendCustomMessageEntry("pudding:task_assign", "执行中", true, {});
	manager.appendCustomMessageEntry("pudding:task_result", "过时的失败结果", true, { taskId: "original-task" });
	manager.appendCustomMessageEntry("pudding:task_result", "已查重，等待继续", true, { taskId: "original-task" });
	manager.appendCustomMessageEntry("pudding:knowledge_job", "失败卡", true, {});
	manager.appendCustomMessageEntry("pudding:user_message", "继续", true, { operationId: "current" });
	manager.appendCustomMessageEntry("pudding:user_message", "后来的消息", true, { operationId: "future" });
	const history = directConversationHistory(manager.getBranch(), "current");
	assert.deepEqual(history.map(({ role, content }) => ({ role, content })), [
		{ role: "user", content: "原始饭局请求\n附件：冻结原件" }, { role: "assistant", content: "已查重，等待继续" },
	]);
	assert(history.every(turn => Number.isFinite(turn.timestamp)));
	assert.throws(() => directConversationHistory(manager.getBranch(), "not-durable"), /尚未落盘/);
});
