import assert from "node:assert/strict";
import test from "node:test";
import { matchesManagedHealth, pidAlive } from "../bin/process-state.js";

test("a process hidden by permissions remains live in CLI run state", () => {
	const denied = () => { const error = new Error("operation not permitted"); error.code = "EPERM"; throw error; };
	assert.equal(pidAlive(12345, denied), true);
});

test("only an absent PID is treated as stopped", () => {
	const absent = () => { const error = new Error("no such process"); error.code = "ESRCH"; throw error; };
	assert.equal(pidAlive(12345, absent), false);
	assert.equal(pidAlive(12345, () => undefined), true);
});

test("a live PID alone cannot authorize stopping a different listener", () => {
	const runState = { runId: "owned-run" };
	const health = { ok: true, service: "puddingteams-server", runId: "owned-run", dataHomeId: "owned-home" };
	assert.equal(matchesManagedHealth(runState, health, "owned-home"), true);
	assert.equal(matchesManagedHealth(runState, { ...health, runId: "other-run" }, "owned-home"), false);
	assert.equal(matchesManagedHealth(runState, { ...health, dataHomeId: "other-home" }, "owned-home"), false);
	assert.equal(matchesManagedHealth({ runId: "" }, health, "owned-home"), false);
});
