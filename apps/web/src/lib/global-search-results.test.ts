import { test } from "node:test";
import assert from "node:assert/strict";
import { agentResults, filterSearchResults, managerWorkResults, roomResults, sessionTitle, withManagerReturn } from "./global-search-results.js";
import type { AgentConfig, ManagerWorkIndexItem, RoomSummary } from "./types.js";

test("停放项目的 Manager 工作搜索结果指向原 Session 并保留项目名", () => {
	const works = [
		{ sessionId: "old/a", title: "旧项目发布核对", firstMessage: "旧项目发布核对", workspaceId: "a", workspaceName: "项目 A", modifiedAt: "2026-09-24T00:00:00Z", active: false },
		{ sessionId: "current-b", title: "新项目调研", firstMessage: "新项目调研", workspaceId: "b", workspaceName: "项目 B", modifiedAt: "2026-09-24T01:00:00Z", active: true },
	] satisfies ManagerWorkIndexItem[];
	const result = filterSearchResults(managerWorkResults(works), "项目 A");
	assert.equal(result.length, 1);
	assert.equal(result[0]!.href, "/?session=old%2Fa");
	assert.match(result[0]!.description, /项目 A/);
});

test("搜索旧会话定位到所属 Room/Session，同名 Worker 的项目保持可辨", () => {
	const room = (id: string, workspace: string) => ({
		id,
		type: "direct",
		name: "Codex",
		workspace: { name: workspace },
		members: [{ name: "codex", description: "开发" }],
		lastMessagePreview: "最新结果",
		sessions: [
			{ id: `${id}-new`, name: "新工作", firstMessage: "新的问题" },
			{ id: `${id}-old`, name: "历史检查", firstMessage: "检查旧版本" },
		],
	}) as RoomSummary;
	const results = roomResults([room("room-a", "项目 A"), room("room-b", "项目 B")]);
	const old = filterSearchResults(results, "历史检查");
	assert.equal(old.length, 2);
	assert.deepEqual(old.map((result) => result.href), [
		"/chats?room=room-a&session=room-a-old",
		"/chats?room=room-b&session=room-b-old",
	]);
	assert.match(old[0]!.description, /项目 A/);
	assert.match(old[1]!.description, /项目 B/);
	assert.equal(filterSearchResults(results, "最新结果")[0]?.href, "/chats?room=room-a");
	assert.equal(filterSearchResults(results, "检查旧版本")[0]?.href, "/chats?room=room-a&session=room-a-old");
	const agents = agentResults([{ name: "codex", displayName: "Codex", description: "开发" } as AgentConfig]);
	assert.equal(filterSearchResults(agents, "开发")[0]?.href, "/agents/config?name=codex");
});

test("搜索切换 Worker 对话保留 Manager 来源而不污染工作与智能体链接", () => {
	assert.equal(
		withManagerReturn("/chats?room=worker-b&session=old", "manager session/1"),
		"/chats?room=worker-b&session=old&returnSession=manager+session%2F1",
	);
	assert.equal(withManagerReturn("/?session=manager-work", "manager-origin"), "/?session=manager-work");
	assert.equal(withManagerReturn("/agents/config?name=codex", "manager-origin"), "/agents/config?name=codex");
	assert.equal(withManagerReturn("/chats?room=worker-b", null), "/chats?room=worker-b");
});

test("占位会话名不遮蔽已落盘的首条消息", () => {
	assert.equal(sessionTitle("新对话", "(no messages)"), null, "空容器不能进入工作台历史");
	assert.equal(sessionTitle("新对话", "核对上周发布结果"), "核对上周发布结果");
	const rooms = [{
		id: "direct-room",
		type: "direct",
		name: "与 Codex 单聊",
		workspace: { name: "项目 A" },
		members: [{ name: "codex" }],
		sessions: [{ id: "old-session", name: "新对话", firstMessage: "核对上周发布结果" }],
	}, {
		id: "manager-room",
		type: "solo",
		workspace: { name: "项目 A" },
		sessions: [
			{ id: "manager-session", name: "(no messages)", firstMessage: "整理项目进度" },
			{ id: "empty-session", name: "手动命名的空容器", firstMessage: "(no messages)" },
		],
	}] as RoomSummary[];
	assert.equal(filterSearchResults(roomResults(rooms), "上周发布")[0]?.href, "/chats?room=direct-room&session=old-session");
	assert.equal(filterSearchResults(roomResults(rooms), "项目进度")[0]?.href, "/?session=manager-session");
	assert.equal(filterSearchResults(roomResults(rooms), "手动命名的空容器").length, 0);
});

test("Manager 索引失败时当前项目回退仍可按首条消息检索", () => {
	const solo = { id: "solo", type: "solo", workspace: { name: "项目 A" }, sessions: [{ id: "old-a", name: "发布核对", firstMessage: "检查项目 A 安装包" }] } as RoomSummary;
	const results = filterSearchResults(roomResults([solo]), "安装包");
	assert.equal(results[0]?.href, "/?session=old-a");
	assert.match(results[0]!.description, /检查项目 A 安装包/);
});

test("精确标题命中不会被前二十条宽泛工作结果挤掉", () => {
	const works = Array.from({ length: 25 }, (_, index) => ({
		sessionId: `work-${index}`,
		title: `项目 ${index} 的 Codex 工作`,
		firstMessage: `项目 ${index} 的 Codex 工作`,
		workspaceId: "a",
		workspaceName: "项目 A",
		modifiedAt: "2026-09-24T00:00:00Z",
		active: false,
	})) satisfies ManagerWorkIndexItem[];
	const agent = { name: "codex", displayName: "Codex", description: "开发" } as AgentConfig;
	const results = filterSearchResults([...managerWorkResults(works), ...agentResults([agent])], "Codex");
	assert.equal(results.length, 20);
	assert.equal(results[0]?.href, "/agents/config?name=codex");
	assert.equal(results[1]?.href, "/?session=work-0", "同等级工作仍保持原有顺序");
});

test("Manager 工作改名后仍可按首条任务摘要检索", () => {
	const works = [{ sessionId: "old-a", title: "发布核对", firstMessage: "检查项目 A 的安装包", workspaceId: "a", workspaceName: "项目 A", modifiedAt: "2026-09-24T00:00:00Z", active: false }] satisfies ManagerWorkIndexItem[];
	const result = filterSearchResults(managerWorkResults(works), "安装包");
	assert.equal(result[0]?.href, "/?session=old-a");
});
