import test from "node:test";
import assert from "node:assert/strict";
import { dayBoundary, plusDay, repeatedWallTime, resolveWallTime, wallTime, weekStart } from "./time";
test("calendar wall-clock conversion rejects DST gap, disambiguates fold, preserves cross-midnight", () => {
	assert.equal(resolveWallTime("2026-09-30T23:30", "Asia/Shanghai"), "2026-09-30T15:30:00.000Z");
	assert.throws(() => resolveWallTime("2026-03-08T02:30", "America/New_York"), /不存在/);
	assert.throws(() => resolveWallTime("2026-11-01T01:30", "America/New_York"), /两次/);
	assert.equal(resolveWallTime("2026-11-01T01:30", "America/New_York", "earlier"), "2026-11-01T05:30:00.000Z");
	assert.equal(resolveWallTime("2026-11-01T01:30", "America/New_York", "later"), "2026-11-01T06:30:00.000Z");
	assert.equal(wallTime("2026-10-01T16:30:00Z", "Asia/Shanghai"), "2026-10-02T00:30");
	assert.equal(plusDay("2026-12-31", 1), "2027-01-01"); assert.equal(weekStart("2026-09-30"), "2026-09-28");
});
test("only DST folds ask the user, so domestic time zones never see the choice", () => {
	assert.equal(repeatedWallTime("2026-11-01T01:30", "America/New_York"), true);
	assert.equal(repeatedWallTime("2026-11-01T03:30", "America/New_York"), false);
	assert.equal(repeatedWallTime("2026-03-08T02:30", "America/New_York"), false);
	assert.equal(repeatedWallTime("2026-10-16T18:00", "Asia/Shanghai"), false);
	assert.equal(repeatedWallTime("2026-10-16T18:00", "Not/AZone"), false);
	assert.equal(repeatedWallTime("", "Asia/Shanghai"), false);
});
test("remote calendar query boundaries follow local dates through DST", () => {
	assert.equal(dayBoundary("2026-10-01", "Asia/Shanghai"), "2026-09-30T16:00:00.000Z");
	const duration = (day: string) => (Date.parse(dayBoundary(plusDay(day, 1), "America/New_York")) - Date.parse(dayBoundary(day, "America/New_York"))) / 3600000;
	assert.equal(duration("2026-03-08"), 23);
	assert.equal(duration("2026-11-01"), 25);
	assert.equal(wallTime(dayBoundary("2026-09-06", "America/Santiago"), "America/Santiago"), "2026-09-06T01:00");
});
