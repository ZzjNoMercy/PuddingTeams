import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExtensionMutationJournal } from "./extension-mutation-journal.js";

test("Extension 待对账记录在包变更前以 0600 提交", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pt-extension-journal-"));
	const file = path.join(dir, "extension-mutation-pending.json");
	const journal = new ExtensionMutationJournal(file);
	assert.deepEqual(await journal.begin(["pi-b", "manager", "pi-b"]), ["manager", "pi-b"]);
	assert.equal((await stat(file)).mode & 0o777, 0o600);
	await journal.complete();
});

test("Extension 待对账记录 rename 后目录同步失败时保留记录并拒绝下一次变更", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "pt-extension-journal-sync-"));
	const file = path.join(dir, "extension-mutation-pending.json");
	const journal = new ExtensionMutationJournal(file);
	Reflect.set(journal, "syncDirectory", async () => { throw new Error("simulated directory fsync failure"); });
	await assert.rejects(() => journal.begin(["pi-b"]), /directory fsync failure/);
	assert.deepEqual(JSON.parse(await readFile(file, "utf-8")).agentIds, ["pi-b"]);
	await assert.rejects(() => journal.begin(["manager"]), /仍待对账/);
});
