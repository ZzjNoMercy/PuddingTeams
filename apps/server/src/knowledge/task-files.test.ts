import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TaskWorkspace, TaskWorkspaceError } from "./task-files.js";

const createWorkspace = async (): Promise<TaskWorkspace> => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-task-"));
	const ws = new TaskWorkspace(root);
	await mkdir(ws.library, { recursive: true });
	await mkdir(ws.sources, { recursive: true });
	await ws.hostWrite("AGENTS.md", "# Rules\n", 0o444);
	await ws.hostWrite("sources/note.md", "source\n", 0o444);
	return ws;
};

test("候选只允许写 library 下的 Markdown，读取留证据且不能进入宿主私有区", async () => {
	const workspace = await createWorkspace();
	await workspace.write("library/wiki/a.md", "# A\n");
	assert.equal((await workspace.read("library/wiki/a.md")).content, "# A\n");
	assert.equal((await workspace.evidence()).length, 1);
	assert.equal((await workspace.list(".")).some((entry: { name: string }) => entry.name === "library"), true);
	await assert.rejects(workspace.write("sources/note.md", "x"), (error: unknown) => error instanceof TaskWorkspaceError && error.code === "read_only");
	await assert.rejects(workspace.write("AGENTS.md", "x"), (error: unknown) => error instanceof TaskWorkspaceError);
	await assert.rejects(workspace.write("library/a.txt", "x"), /Markdown/);
	await assert.rejects(workspace.read("../secret.md"), /越出|无效/);
	await assert.rejects(workspace.read(".host/reads.jsonl"), /宿主|无效/);
});

test("扫描只收 Markdown 并排序；符号链接拒绝", async () => {
	const workspace = await createWorkspace();
	await workspace.write("library/b.md", "# B\n");
	await workspace.write("library/a.md", "# A\n");
	await workspace.write("library/asset.png", "not-an-image").catch(() => undefined);
	assert.deepEqual((await workspace.scanPages()).map((page: { path: string }) => page.path), ["a.md", "b.md"]);
	await writeFile(path.join(path.dirname(workspace.root), `outside-${path.basename(workspace.root)}.md`), "outside\n");
	await symlink(path.join(path.dirname(workspace.root), `outside-${path.basename(workspace.root)}.md`), path.join(workspace.library, "escape.md"));
	await assert.rejects(workspace.scanPages(), /符号链接/);
});

test("超大候选与超量候选拒绝", async () => {
	const workspace = await createWorkspace();
	await workspace.write("library/huge.md", "x");
	await writeFile(path.join(workspace.library, "huge.md"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
	await assert.rejects(workspace.scanPages(), /超过 2 MiB/);
});

test("提交后封存，编辑要求唯一匹配，证据可重读", async () => {
	const workspace = await createWorkspace();
	await workspace.write("library/edit.md", "alpha beta alpha\n");
	await assert.rejects(workspace.edit("library/edit.md", "alpha", "gamma"), /多次/);
	await workspace.edit("library/edit.md", "beta", "BETA");
	assert.equal((await workspace.read("library/edit.md")).content, "alpha BETA alpha\n");
	await workspace.seal();
	await assert.rejects(workspace.write("library/edit.md", "late"), (error: unknown) => error instanceof TaskWorkspaceError && error.code === "sealed");
	assert.equal((await workspace.evidence()).length >= 2, true);
});
