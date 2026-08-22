import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import {
	dataHomeId,
	mergeExecutablePaths,
	parseManagedServerState,
	resolvePuddingTeamsHome,
} from "./runtime.js";

test("桌面宿主缺省复用 ~/.puddingteams", () => {
	assert.equal(resolvePuddingTeamsHome({}, "/Users/alice"), "/Users/alice/.puddingteams");
});

test("桌面宿主接受绝对 PUDDINGTEAMS_HOME，拒绝相对路径", () => {
	assert.equal(resolvePuddingTeamsHome({ PUDDINGTEAMS_HOME: "/Volumes/Data/pt" }, "/Users/alice"), "/Volumes/Data/pt");
	assert.throws(
		() => resolvePuddingTeamsHome({ PUDDINGTEAMS_HOME: "./pt" }, "/Users/alice"),
		/PUDDINGTEAMS_HOME 必须是绝对路径/,
	);
});

test("数据目录指纹稳定且不暴露原路径", () => {
	const id = dataHomeId("/Users/alice/.puddingteams");
	assert.equal(id, dataHomeId(path.resolve("/Users/alice/.puddingteams")));
	assert.equal(id.length, 64);
	assert.ok(!id.includes("alice"));
});

test("解析 CLI server state 的新旧格式", () => {
	assert.deepEqual(parseManagedServerState('{"pid":123,"port":8933}'), { pid: 123, port: 8933 });
	assert.deepEqual(parseManagedServerState("456"), { pid: 456 });
	assert.equal(parseManagedServerState('{"pid":0,"port":8933}'), undefined);
	assert.deepEqual(parseManagedServerState('{"pid":123,"port":70000}'), { pid: 123 });
});

test("PATH 合并保持优先级并去重", () => {
	assert.equal(
		mergeExecutablePaths("/custom:/usr/bin", "/opt/homebrew/bin:/usr/bin", "/bin"),
		["/custom", "/usr/bin", "/opt/homebrew/bin", "/bin"].join(path.delimiter),
	);
});
