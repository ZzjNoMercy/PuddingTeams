import test from "node:test";
import assert from "node:assert/strict";
import { appendCalendarSelections, calendarSourceLabel } from "./sources";

test("追加日历保留已选顺序和显示开关，跨来源同 ID 不冲突，不重复添加", () => {
	const original = [{ providerId: "feishu", id: "same", name: "工作", visible: false }];
	const added = [{ providerId: "feishu", id: "same", name: "重复", visible: true }, { providerId: "other", id: "same", name: "工作", visible: true }, { providerId: "feishu", id: "new", name: "个人", visible: true }];
	const result = appendCalendarSelections(original, [...added, added[2]]);
	assert.deepEqual(result, [original[0], added[1], added[2]]);
	assert.equal(result[0].visible, false); assert.equal(original.length, 1);
});
test("来源名称区分平台和各外部日历，不把外部来源写死为飞书", () => {
	assert.equal(calendarSourceLabel({ sourceId: "platform" }), "平台日历");
	assert.equal(calendarSourceLabel({ sourceId: "feishu:one", providerName: "飞书", sourceName: "工作" }), "飞书 · 工作");
	assert.equal(calendarSourceLabel({ sourceId: "other:one", providerName: "其他系统", sourceName: "工作" }), "其他系统 · 工作");
	assert.equal(calendarSourceLabel({ sourceId: "unknown" }), "外部日历 · 日历");
});
