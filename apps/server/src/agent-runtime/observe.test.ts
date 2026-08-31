import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitBaseline, observeGitArtifacts } from "./observe.js";

/**
 * §15.4 observe 轨：任务前取 git 基线，完成后只收新增变更条目。
 * 真实 git（本机可用）；不构造提交，untracked 即可被 porcelain 列出。
 */

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

test("observe: git 工作区的新增变更文件被收集为 ArtifactRef{origin:observe}", async () => {
	const dir = freshDir("pt-observe-");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	const baseline = await gitBaseline(dir, process.env);
	assert.ok(baseline !== null, "git 工作区必须能取到基线");

	writeFileSync(path.join(dir, "hello.ts"), "export const x = 1;\n");
	mkdirSync(path.join(dir, "src"));
	writeFileSync(path.join(dir, "src", "util.ts"), "export const y = 2;\n");

	const artifacts = await observeGitArtifacts(dir, process.env, baseline);
	const paths = artifacts.map((a) => a.path).sort();
	assert.deepEqual(paths, ["hello.ts", "src/util.ts"]);
	for (const a of artifacts) {
		assert.equal(a.origin, "observe");
		assert.ok(a.name, "name 必须非空");
	}
});

test("observe: 基线里已存在的脏文件不误报（平台自身开发改动场景）", async () => {
	const dir = freshDir("pt-observe-dirty-");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	// 任务前工作区已经是脏的（相当于平台仓库里未提交的开发改动）。
	writeFileSync(path.join(dir, "pre-existing.ts"), "export {};\n");
	const baseline = await gitBaseline(dir, process.env);

	// 任务只新增了 new.ts。
	writeFileSync(path.join(dir, "new.ts"), "export {};\n");
	const artifacts = await observeGitArtifacts(dir, process.env, baseline);
	assert.deepEqual(artifacts.map((a) => a.path), ["new.ts"]);
});

test("observe: Worker 提交后工作树 clean，仍按任务前 HEAD 收集已提交 Artifact", async () => {
	const dir = freshDir("pt-observe-commit-");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "e2e@example.invalid"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "E2E"], { cwd: dir });
	writeFileSync(path.join(dir, "base.txt"), "base\n");
	execFileSync("git", ["add", "base.txt"], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });
	const baseline = await gitBaseline(dir, process.env);

	writeFileSync(path.join(dir, "committed.txt"), "result\n");
	execFileSync("git", ["add", "committed.txt"], { cwd: dir });
	execFileSync("git", ["commit", "-qm", "result"], { cwd: dir });
	assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), "");

	const artifacts = await observeGitArtifacts(dir, process.env, baseline);
	assert.deepEqual(artifacts.map((a) => a.path), ["committed.txt"]);
});

test("observe: .pudding/handoff/ 导出目录不属于 observe 范围", async () => {
	const dir = freshDir("pt-observe-handoff-");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	const baseline = await gitBaseline(dir, process.env);
	mkdirSync(path.join(dir, ".pudding", "handoff", "del-1"), { recursive: true });
	writeFileSync(path.join(dir, ".pudding", "handoff", "del-1", "report.md"), "# report\n");
	writeFileSync(path.join(dir, "code.ts"), "export {};\n");

	const artifacts = await observeGitArtifacts(dir, process.env, baseline);
	assert.deepEqual(artifacts.map((a) => a.path), ["code.ts"]);
});

test("observe: 非 git 目录基线为 null，返回空清单（不报错）", async () => {
	const dir = freshDir("pt-observe-nogit-");
	writeFileSync(path.join(dir, "a.txt"), "x\n");
	const baseline = await gitBaseline(dir, process.env);
	assert.equal(baseline, null);
	const artifacts = await observeGitArtifacts(dir, process.env, baseline);
	assert.deepEqual(artifacts, []);
});
