import { test } from "node:test";
import assert from "node:assert/strict";
import { groupScopes, scopeAction, scopeDomain, scopeRisk, scopeTotal } from "./feishu-scopes.js";

test("scope 按业务域分组并省略组内前缀", () => {
	const groups = groupScopes("base:record:read base:record:delete calendar:calendar:read offline_access");
	assert.deepEqual(groups.map(group => group.domain), ["base", "calendar", "offline_access"]);
	const base = groups[0];
	assert.equal(base.label, "多维表格");
	assert.deepEqual(base.scopes, ["base:record:delete", "base:record:read"]);
	assert.equal(scopeAction("base:record:read", "base"), "record:read");
	assert.equal(scopeAction("offline_access", "offline_access"), "offline_access");
	assert.equal(scopeTotal(groups), 4);
});

test("风险分类区分只读、写入与删除/管理", () => {
	assert.equal(scopeRisk("base:record:read"), "read");
	assert.equal(scopeRisk("base:record:create"), "write");
	assert.equal(scopeRisk("im:chat.members:write_only"), "write");
	assert.equal(scopeRisk("base:record:delete"), "danger");
	assert.equal(scopeRisk("docs:permission.member:transfer"), "danger");
	assert.equal(scopeRisk("im:message:recall"), "danger");
	assert.equal(scopeRisk("im:message:readonly"), "read");
});

test("组内风险数量与排序稳定，重复 scope 不重复计数", () => {
	const [group] = groupScopes("im:message:read im:message:send im:message:recall im:message:read");
	assert.equal(group.scopes.length, 3);
	assert.equal(group.write, 1);
	assert.equal(group.danger, 1);
	assert.equal(group.scopes[0], "im:message:recall");
});

test("未知业务域回退为原始前缀且有冒号才算域", () => {
	assert.equal(scopeDomain("somethingnew:thing:read"), "somethingnew");
	assert.equal(groupScopes("somethingnew:thing:read")[0].label, "somethingnew");
});
