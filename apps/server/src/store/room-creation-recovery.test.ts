import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TeamsStore } from "./teams.js";
import { PiSessionStore } from "../pi-bridge/session-store.js";

function crashDuringRoomCreation(dir: string, phase: "after_session" | "after_window"): void {
	const moduleUrl = new URL("./teams.ts", import.meta.url).href;
	const child = `
		import { TeamsStore } from ${JSON.stringify(moduleUrl)};
		import { writeFileSync } from "node:fs";
		import path from "node:path";
		const dir = process.argv[1];
		const phase = process.argv[2];
		const store = new TeamsStore({ state: path.join(dir, "state"), assets: dir, managedWorkspaces: path.join(dir, "managed") }, dir);
		await store.init();
		await store.upsertAgent({ name: "alpha", description: "alpha", invoke: { type: "command", command: "alpha", runArgs: [] } });
		if (phase === "after_window") store.settleRoomCreation = async () => process.exit(74);
		await store.createWindow({
			type: "direct", members: ["alpha"], journalSession: true, requireEnabledMembers: true,
			createSession: async (id) => {
				writeFileSync(path.join(dir, id + ".session"), id, { flush: true });
				if (phase === "after_session") process.exit(73);
				return { id };
			},
			rollbackSession: async (id) => { throw new Error("rollback must not run after process exit: " + id); },
		});
	`;
	const childResult = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child, dir, phase], {
		cwd: path.resolve(import.meta.dirname, "../.."),
		encoding: "utf8",
		timeout: 20_000,
	});
	assert.equal(childResult.status, phase === "after_session" ? 73 : 74, childResult.stderr || childResult.error?.message);
}

test("建房进程在 Session 与窗口两侧退出后，启动只清理有预约且无归属的 Session", async () => {
	for (const phase of ["after_session", "after_window"] as const) {
		const dir = mkdtempSync(path.join(tmpdir(), `pt-room-crash-${phase}-`));
		try {
			crashDuringRoomCreation(dir, phase);
			const journalFile = path.join(dir, "state", "room-creation-journal.json");
			const pending = (JSON.parse(readFileSync(journalFile, "utf8")) as { pending: Record<string, unknown> }).pending;
			const [sessionId] = Object.keys(pending);
			assert.ok(sessionId && existsSync(path.join(dir, `${sessionId}.session`)), "退出前预约和 Session 必须都已落盘");
			const unrelated = path.join(dir, "unrelated.session");
			writeFileSync(unrelated, "not a room creation reservation");
			const restarted = new TeamsStore({ state: path.join(dir, "state"), assets: dir, managedWorkspaces: path.join(dir, "managed") }, dir);
			await restarted.init();
			if (phase === "after_session") {
				await assert.rejects(
					() => restarted.reconcileRoomCreations(async () => { throw new Error("injected recovery cleanup failure"); }),
					/injected recovery cleanup failure/,
				);
				assert.ok(Object.hasOwn((JSON.parse(readFileSync(journalFile, "utf8")) as { pending: Record<string, unknown> }).pending, sessionId), "清理失败时预约不得消失");
			}
			const removed: string[] = [];
			const result = await restarted.reconcileRoomCreations(async (id) => {
				removed.push(id);
				unlinkSync(path.join(dir, `${id}.session`));
			});
			assert.deepEqual(removed, phase === "after_session" ? [sessionId] : []);
			assert.deepEqual(result, phase === "after_session" ? { kept: 0, removed: 1 } : { kept: 1, removed: 0 });
			assert.equal(existsSync(path.join(dir, `${sessionId}.session`)), phase === "after_window");
			assert.ok(existsSync(unrelated), "没有专用预约的 Session 不得被全局清扫");
			assert.deepEqual((JSON.parse(readFileSync(journalFile, "utf8")) as { pending: Record<string, unknown> }).pending, {});
			assert.deepEqual(await restarted.reconcileRoomCreations(async () => { throw new Error("must be idempotent"); }), { kept: 0, removed: 0 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("真实 PiSessionStore JSONL 在建房两侧进程退出后按预约恢复", async () => {
	const teamsUrl = new URL("./teams.ts", import.meta.url).href;
	const sessionsUrl = new URL("../pi-bridge/session-store.ts", import.meta.url).href;
	for (const phase of ["after_session", "after_window"] as const) {
		const dir = mkdtempSync(path.join(tmpdir(), `pt-real-room-crash-${phase}-`));
		try {
			const child = `
				import { TeamsStore } from ${JSON.stringify(teamsUrl)};
				import { PiSessionStore } from ${JSON.stringify(sessionsUrl)};
				import path from "node:path";
				const dir = process.argv[1];
				const phase = process.argv[2];
				const teams = new TeamsStore({ state: path.join(dir, "state"), assets: dir, managedWorkspaces: path.join(dir, "managed") }, dir);
				await teams.init();
				await teams.upsertAgent({ name: "alpha", description: "alpha", invoke: { type: "command", command: "alpha", runArgs: [] } });
				const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), teams);
				if (phase === "after_window") teams.settleRoomCreation = async () => process.exit(76);
				await teams.createWindow({
					type: "direct", members: ["alpha"], journalSession: true, requireEnabledMembers: true,
					createSession: async (id) => {
						const created = await sessions.create(undefined, { type: "direct", members: ["alpha"], cwd: dir }, id);
						if (phase === "after_session") process.exit(75);
						return created;
					},
					rollbackSession: (id) => sessions.remove(id),
				});
			`;
			const childResult = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child, dir, phase], {
				cwd: path.resolve(import.meta.dirname, "../.."),
				encoding: "utf8",
				timeout: 30_000,
				env: { ...process.env, PI_CODING_AGENT_DIR: path.join(dir, "agent-dir") },
			});
			assert.equal(childResult.status, phase === "after_session" ? 75 : 76, childResult.stderr || childResult.error?.message);
			const pending = (JSON.parse(readFileSync(path.join(dir, "state", "room-creation-journal.json"), "utf8")) as { pending: Record<string, unknown> }).pending;
			const [sessionId] = Object.keys(pending);
			assert.ok(sessionId);
			const restarted = new TeamsStore({ state: path.join(dir, "state"), assets: dir, managedWorkspaces: path.join(dir, "managed") }, dir);
			await restarted.init();
			const sessions = new PiSessionStore(dir, path.join(dir, "sessions"), restarted);
			assert.ok((await sessions.list()).some((session) => session.id === sessionId), "Pi SDK 的 Session JSONL 必须已可冷启动列出");
			const result = await restarted.reconcileRoomCreations((id) => sessions.remove(id));
			assert.deepEqual(result, phase === "after_session" ? { kept: 0, removed: 1 } : { kept: 1, removed: 0 });
			assert.equal((await sessions.list()).some((session) => session.id === sessionId), phase === "after_window");
			assert.equal(Boolean((await restarted.windowForSession(sessionId))), phase === "after_window");
			await sessions.disposeAll();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});
