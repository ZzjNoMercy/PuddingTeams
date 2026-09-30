import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { RoomActivityProjector } from "../src/routes/room-activity.ts";

const roomCount = 4;
const messagesPerRoom = 10_000;
const dir = await mkdtemp(path.join(tmpdir(), "teams-room-activity-benchmark-"));

try {
	const rooms = [];
	for (let room = 0; room < roomCount; room++) {
		const file = path.join(dir, `room-${room}.jsonl`);
		const content = Array.from({ length: messagesPerRoom }, (_, index) => JSON.stringify({
			type: "message",
			id: `${room}-${index}`,
			timestamp: new Date(Date.UTC(2026, 8, 23) + index * 1_000).toISOString(),
			message: {
				role: index % 2 ? "assistant" : "user",
				content: [{ type: "text", text: `room ${room} message ${index}` }],
			},
		})).join("\n") + "\n";
		await writeFile(file, content);
		rooms.push({ id: `room-${room}`, sessions: [{ id: `session-${room}`, sessionFile: file }] });
	}

	const statePath = path.join(dir, "room-activity.json");
	const measure = async (projector) => {
		const started = performance.now();
		for (const room of rooms) await projector.project(room.id, room.sessions);
		return Number((performance.now() - started).toFixed(2));
	};
	const initialMs = await measure(new RoomActivityProjector(statePath));
	const restarted = new RoomActivityProjector(statePath);
	const restartMs = await measure(restarted);
	const warmMs = await measure(restarted);
	process.stdout.write(`${JSON.stringify({ roomCount, messagesPerRoom, initialMs, restartMs, warmMs })}\n`);
} finally {
	await rm(dir, { recursive: true, force: true });
}
