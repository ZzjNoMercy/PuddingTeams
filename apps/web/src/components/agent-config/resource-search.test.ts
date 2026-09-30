import assert from "node:assert/strict";
import { test } from "node:test";
import { filterResources } from "./resource-search";

const rows = Object.freeze([
	Object.freeze({ name: "Design-Review", description: "界面评审", argumentHint: "<Goal>" }),
	Object.freeze({ name: "wiki", description: "资料整理" }),
]);
test("名称、描述与参数提示都可查找，忽略大小写与首尾空格", () => {
	assert.deepEqual(filterResources(rows, " DESIGN "), [rows[0]]);
	assert.deepEqual(filterResources(rows, "资料"), [rows[1]]);
	assert.deepEqual(filterResources(rows, "goal"), [rows[0]]);
});
test("清空搜索恢复完整顺序；无结果不影响源列表或选用名单", () => {
	assert.deepEqual(filterResources(rows, "missing"), []);
	assert.deepEqual(filterResources(rows, "  "), rows);
	assert.equal(rows.length, 2);
	assert.equal(filterResources(rows, "wiki")[0], rows[1]);
});
