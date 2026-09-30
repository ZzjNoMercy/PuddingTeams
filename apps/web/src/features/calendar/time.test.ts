import test from "node:test";
import assert from "node:assert/strict";
import { plusDay, resolveWallTime, wallTime, weekStart } from "./time";
test("calendar wall-clock conversion rejects DST gap, disambiguates fold, preserves cross-midnight", () => {
	assert.equal(resolveWallTime("2026-09-30T23:30", "Asia/Shanghai"), "2026-09-30T15:30:00.000Z");
	assert.throws(() => resolveWallTime("2026-03-08T02:30", "America/New_York"), /不存在/);
	assert.throws(() => resolveWallTime("2026-11-01T01:30", "America/New_York"), /两次/);
	assert.equal(resolveWallTime("2026-11-01T01:30", "America/New_York", "earlier"), "2026-11-01T05:30:00.000Z");
	assert.equal(resolveWallTime("2026-11-01T01:30", "America/New_York", "later"), "2026-11-01T06:30:00.000Z");
	assert.equal(wallTime("2026-10-01T16:30:00Z", "Asia/Shanghai"), "2026-10-02T00:30");
	assert.equal(plusDay("2026-12-31", 1), "2027-01-01"); assert.equal(weekStart("2026-09-30"), "2026-09-28");
});
