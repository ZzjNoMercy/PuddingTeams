import assert from "node:assert/strict";
import test from "node:test";
import { LatestSerialQueue } from "./latest-serial-queue";

test("a later selection waits for an in-flight workspace switch and alone activates", async () => {
	const queue = new LatestSerialQueue();
	const events: string[] = [];
	let signalEntered!: () => void;
	let finishSwitch!: () => void;
	const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
	const switchFinished = new Promise<void>((resolve) => { finishSwitch = resolve; });

	const first = queue.enqueue(async (isCurrent) => {
		events.push("A: switch started");
		signalEntered();
		await switchFinished;
		events.push("A: switch finished");
		if (isCurrent()) events.push("A: activate");
	});
	await entered;
	queue.invalidate();
	const second = queue.enqueue((isCurrent) => {
		events.push("B: location started");
		if (isCurrent()) events.push("B: activate");
	});
	assert.deepEqual(events, ["A: switch started"]);
	finishSwitch();
	await Promise.all([first, second]);
	assert.deepEqual(events, ["A: switch started", "A: switch finished", "B: location started", "B: activate"]);
});

test("a failed location does not prevent the next selection", async () => {
	const queue = new LatestSerialQueue();
	await assert.rejects(queue.enqueue(async () => { throw new Error("location lookup failed"); }), /location lookup failed/);
	queue.invalidate();
	let activated = false;
	await queue.enqueue((isCurrent) => { activated = isCurrent(); });
	assert.equal(activated, true);
});

test("an invalidated selection waiting in the queue never starts", async () => {
	const queue = new LatestSerialQueue();
	let signalEntered!: () => void;
	let release!: () => void;
	const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const first = queue.enqueue(async () => { signalEntered(); await gate; });
	await entered;
	let staleStarted = false;
	const stale = queue.enqueue(() => { staleStarted = true; });
	queue.invalidate();
	release();
	await Promise.all([first, stale]);
	assert.equal(staleStarted, false);
});
