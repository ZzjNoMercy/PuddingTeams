import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TeamsStore } from "../src/store/teams.ts";
import { PiSessionStore } from "../src/pi-bridge/session-store.ts";

const script = fileURLToPath(import.meta.url);
const serverPackageDir = path.resolve(path.dirname(script), "..");
const projectRoot = path.resolve(path.dirname(script), "../../..");
const runtimeServer = process.env.PUDDINGTEAMS_RUNTIME_SERVER ?? path.join(projectRoot, "packages/puddingteams-cli/runtime/apps/server/src/server.bundle.mjs");
assert.ok(path.isAbsolute(runtimeServer), "PUDDINGTEAMS_RUNTIME_SERVER must be absolute");

async function createThenExit(home, phase) {
	const cwd = path.join(home, "workspaces", "unscoped");
	await mkdir(cwd, { recursive: true });
	const teams = new TeamsStore({ state: path.join(home, "state"), assets: path.join(home, "assets"), managedWorkspaces: path.join(home, "workspaces", "managed") }, cwd);
	await teams.init();
	await teams.upsertAgent({ name: "alpha", description: "alpha", invoke: { type: "command", command: "alpha", runArgs: [] } });
	const sessions = new PiSessionStore(cwd, path.join(home, "sessions"), teams);
	if (phase === "after_window") teams.settleRoomCreation = async () => process.exit(76);
	await teams.createWindow({
		type: "direct", members: ["alpha"], journalSession: true, requireEnabledMembers: true,
		createSession: async (id) => {
			const created = await sessions.create(undefined, { type: "direct", members: ["alpha"], cwd }, id);
			if (phase === "after_session") process.exit(75);
			return created;
		},
		rollbackSession: (id) => sessions.remove(id),
	});
	throw new Error("crash hook was not reached");
}

async function freePort() {
	const server = createServer();
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	await new Promise((resolve) => server.close(resolve));
	return address.port;
}

async function waitForHealth(port, child, output) {
	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`server exited before health: ${child.exitCode}\n${output()}`);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_000) });
			if (response.ok) return;
		} catch { /* listener not ready */ }
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server health timeout\n${output()}`);
}

async function rehearse(phase) {
	const home = await mkdtemp(path.join(tmpdir(), `pt-runtime-room-${phase}-`));
	let server;
	let serverClosed;
	let output = "";
	try {
		const env = { ...process.env, PUDDINGTEAMS_HOME: home, PI_CODING_AGENT_DIR: path.join(home, "agent-dir") };
		const created = spawnSync(process.execPath, ["--import", "tsx", script, "create", home, phase], {
			cwd: serverPackageDir, env, encoding: "utf8", timeout: 30_000,
		});
		assert.equal(created.status, phase === "after_session" ? 75 : 76, created.stderr || created.error?.message);
		const journal = path.join(home, "state", "room-creation-journal.json");
		const pending = (JSON.parse(await readFile(journal, "utf8"))).pending;
		const [sessionId] = Object.keys(pending);
		assert.ok(sessionId);
		const port = await freePort();
		server = spawn(process.execPath, [runtimeServer], {
			cwd: projectRoot,
			env: { ...env, HOST: "127.0.0.1", PORT: String(port) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		serverClosed = new Promise((resolve) => server.once("exit", resolve));
		server.stdout.on("data", (chunk) => { output += String(chunk); });
		server.stderr.on("data", (chunk) => { output += String(chunk); });
		await waitForHealth(port, server, () => output);
		const [roomsResponse, sessionsResponse] = await Promise.all([
			fetch(`http://127.0.0.1:${port}/api/rooms`),
			fetch(`http://127.0.0.1:${port}/api/sessions`),
		]);
		assert.equal(roomsResponse.status, 200);
		assert.equal(sessionsResponse.status, 200);
		const rooms = (await roomsResponse.json()).rooms;
		const sessions = (await sessionsResponse.json()).sessions;
		const shouldKeep = phase === "after_window";
		assert.equal(rooms.some((room) => room.type === "direct" && room.activeSession === sessionId), shouldKeep);
		assert.equal(sessions.some((session) => session.id === sessionId), shouldKeep);
		assert.deepEqual((JSON.parse(await readFile(journal, "utf8"))).pending, {});
		return { phase, sessionId, kept: shouldKeep, rooms: rooms.length, sessions: sessions.length, health: 200 };
	} finally {
		if (server && server.exitCode === null) {
			server.kill("SIGTERM");
			await Promise.race([serverClosed, new Promise((resolve) => setTimeout(resolve, 5_000))]);
			if (server.exitCode === null) server.kill("SIGKILL");
		}
		await rm(home, { recursive: true, force: true });
	}
}

if (process.argv[2] === "create") await createThenExit(process.argv[3], process.argv[4]);
else {
	const results = [];
	for (const phase of ["after_session", "after_window"]) results.push(await rehearse(phase));
	console.log(JSON.stringify({ runtimeServer, results }, null, 2));
}
