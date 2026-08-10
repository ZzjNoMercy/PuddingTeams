import { test, type TestContext } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { strToU8, zipSync } from "fflate";
import { registerResourcesRoutes } from "./resources.js";

/**
 * 资源库路由测试：CRUD、导入（目录/单文件/缺 SKILL.md/重名）、slug 校验、
 * list 复扫 diagnostics。库根 = getAgentDir()，测试用 PI_CODING_AGENT_DIR
 * 指到临时目录做隔离（SDK 在调用时读取该环境变量）。
 */

function useAgentDir(t: TestContext): string {
	const dir = mkdtempSync(path.join(tmpdir(), "pt-resources-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(() => {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
	});
	return dir;
}

function makeApp(): FastifyInstance {
	const app = Fastify();
	registerResourcesRoutes(app);
	return app;
}

const SKILL_BODY = { content: "做某件事的步骤。\n\n1. 先这样\n2. 再那样", description: "测试技能" };

test("resources: skill CRUD 全链路", async (t) => {
	useAgentDir(t);
	const app = makeApp();

	const created = await app.inject({ method: "POST", url: "/api/resources/skills", payload: { name: "my-skill", ...SKILL_BODY } });
	assert.equal(created.statusCode, 201);
	const createdBody = created.json();
	assert.equal(createdBody.skill.name, "my-skill");
	assert.equal(createdBody.skill.description, "测试技能");
	assert.ok(createdBody.skill.path.endsWith(path.join("skills", "my-skill", "SKILL.md")));
	assert.deepEqual(createdBody.diagnostics, []);

	const list = await app.inject({ method: "GET", url: "/api/resources/skills" });
	assert.equal(list.statusCode, 200);
	assert.deepEqual(list.json().skills.map((s: { name: string }) => s.name), ["my-skill"]);

	const one = await app.inject({ method: "GET", url: "/api/resources/skills/my-skill" });
	assert.equal(one.statusCode, 200);
	assert.equal(one.json().skill.content, SKILL_BODY.content);

	const updated = await app.inject({
		method: "PUT",
		url: "/api/resources/skills/my-skill",
		payload: { ...SKILL_BODY, description: "改过的描述", disableModelInvocation: true },
	});
	assert.equal(updated.statusCode, 200);
	assert.equal(updated.json().skill.description, "改过的描述");
	assert.equal(updated.json().skill.disableModelInvocation, true);
	assert.equal((await app.inject({ method: "GET", url: "/api/resources/skills" })).json().skills[0].disableModelInvocation, true);

	const removed = await app.inject({ method: "DELETE", url: "/api/resources/skills/my-skill" });
	assert.equal(removed.statusCode, 204);
	assert.equal((await app.inject({ method: "GET", url: "/api/resources/skills/my-skill" })).statusCode, 404);
	assert.equal((await app.inject({ method: "DELETE", url: "/api/resources/skills/my-skill" })).statusCode, 404);
});

test("resources: 重名 409 与 slug 校验 400", async (t) => {
	useAgentDir(t);
	const app = makeApp();
	await app.inject({ method: "POST", url: "/api/resources/skills", payload: { name: "dup", ...SKILL_BODY } });
	const dup = await app.inject({ method: "POST", url: "/api/resources/skills", payload: { name: "dup", ...SKILL_BODY } });
	assert.equal(dup.statusCode, 409);

	for (const bad of ["Bad", "-lead", "under_score", "a".repeat(65), ""]) {
		const res = await app.inject({ method: "POST", url: "/api/resources/skills", payload: { name: bad, ...SKILL_BODY } });
		assert.equal(res.statusCode, 400, `slug ${JSON.stringify(bad)} 应 400`);
	}

	await app.inject({ method: "POST", url: "/api/resources/templates", payload: { name: "dup", content: "x $1" } });
	assert.equal(
		(await app.inject({ method: "POST", url: "/api/resources/templates", payload: { name: "dup", content: "x $1" } })).statusCode,
		409,
	);
	assert.equal(
		(await app.inject({ method: "POST", url: "/api/resources/templates", payload: { name: "Bad", content: "x" } })).statusCode,
		400,
	);
});

test("resources: skill 导入（目录 / 单文件 / 缺 SKILL.md / 重名）", async (t) => {
	const dir = useAgentDir(t);
	const app = makeApp();
	const staging = mkdtempSync(path.join(tmpdir(), "pt-import-"));

	// 目录导入（含 SKILL.md）。
	const skillDir = path.join(staging, "imp-skill");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: imp-skill\ndescription: 导入的\n---\n\n正文\n");
	const imported = await app.inject({ method: "POST", url: "/api/resources/skills/import", payload: { path: skillDir } });
	assert.equal(imported.statusCode, 201);
	assert.equal(imported.json().skill.name, "imp-skill");
	assert.equal(imported.json().skill.description, "导入的");

	// 目录缺 SKILL.md → 400。
	const noSkill = path.join(staging, "no-skill");
	mkdirSync(noSkill);
	writeFileSync(path.join(noSkill, "README.md"), "x");
	assert.equal(
		(await app.inject({ method: "POST", url: "/api/resources/skills/import", payload: { path: noSkill } })).statusCode,
		400,
	);

	// 单 .md 文件导入。
	const single = path.join(staging, "single-file.md");
	writeFileSync(single, "---\ndescription: 单文件\n---\n\n内容 $1\n");
	const fromFile = await app.inject({ method: "POST", url: "/api/resources/skills/import", payload: { path: single } });
	assert.equal(fromFile.statusCode, 201);
	assert.equal(fromFile.json().skill.name, "single-file");
	assert.ok(fromFile.json().skill.path.endsWith(path.join("skills", "single-file", "SKILL.md")));

	// 重名 409 / 路径不存在 400。
	assert.equal(
		(await app.inject({ method: "POST", url: "/api/resources/skills/import", payload: { path: skillDir } })).statusCode,
		409,
	);
	assert.equal(
		(await app.inject({ method: "POST", url: "/api/resources/skills/import", payload: { path: path.join(dir, "nope") } })).statusCode,
		400,
	);
});

function postZip(app: FastifyInstance, url: string, zip: Uint8Array | Buffer) {
	return app.inject({
		method: "POST",
		url,
		headers: { "content-type": "application/zip" },
		payload: Buffer.from(zip),
	});
}

function skillMd(name: string, description = "zip 导入"): string {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`;
}

test("resources: zip 导入单技能（含 helper 脚本整组落盘）", async (t) => {
	const dir = useAgentDir(t);
	const app = makeApp();

	const zip = zipSync({
		"yt-transcript/SKILL.md": strToU8(skillMd("yt-transcript")),
		"yt-transcript/scripts/fetch.py": strToU8("print('fetch')\n"),
		"yt-transcript/references/format.md": strToU8("# 格式\n"),
		"yt-transcript/.DS_Store": strToU8("junk"),
		"__MACOSX/yt-transcript/._SKILL.md": strToU8("junk"),
	});
	const res = await postZip(app, "/api/resources/skills/import-zip", zip);
	assert.equal(res.statusCode, 201, res.body);
	const body = res.json();
	assert.deepEqual(body.imported.map((s: { name: string }) => s.name), ["yt-transcript"]);
	assert.deepEqual(body.skipped, []);
	assert.equal(body.imported[0].description, "zip 导入");

	// helper 脚本与嵌套文件一并落盘；垃圾文件被忽略。
	const root = path.join(dir, "skills", "yt-transcript");
	assert.equal(readFileSync(path.join(root, "scripts", "fetch.py"), "utf-8"), "print('fetch')\n");
	assert.ok(existsSync(path.join(root, "references", "format.md")));
	assert.ok(!existsSync(path.join(root, ".DS_Store")));
	assert.ok(!existsSync(path.join(dir, "skills", "__MACOSX")));

	// 导入的技能进 list。
	const list = await app.inject({ method: "GET", url: "/api/resources/skills" });
	assert.deepEqual(list.json().skills.map((s: { name: string }) => s.name), ["yt-transcript"]);
});

test("resources: zip 批量导入（多技能 / 嵌套根目录 / frontmatter name / 重名跳过）", async (t) => {
	const dir = useAgentDir(t);
	const app = makeApp();
	// 预置一个重名技能。
	mkdirSync(path.join(dir, "skills", "dup-skill"), { recursive: true });
	writeFileSync(path.join(dir, "skills", "dup-skill", "SKILL.md"), skillMd("dup-skill", "已有"));

	const zip = zipSync({
		// 嵌套一层根目录打包。
		"bundle/alpha/SKILL.md": strToU8(skillMd("alpha")),
		"bundle/alpha/notes.md": strToU8("notes\n"),
		// 目录名与 frontmatter name 不一致时以 frontmatter 为准。
		"bundle/dir-name/SKILL.md": strToU8(skillMd("fm-name")),
		// 与库中已有技能重名 → skipped，不影响其他技能。
		"bundle/dup-skill/SKILL.md": strToU8(skillMd("dup-skill")),
	});
	const res = await postZip(app, "/api/resources/skills/import-zip", zip);
	assert.equal(res.statusCode, 201, res.body);
	const body = res.json();
	assert.deepEqual(body.imported.map((s: { name: string }) => s.name).sort(), ["alpha", "fm-name"]);
	assert.deepEqual(body.skipped, [{ name: "dup-skill", reason: "skill 已存在" }]);
	assert.ok(existsSync(path.join(dir, "skills", "alpha", "notes.md")));
	assert.ok(existsSync(path.join(dir, "skills", "fm-name", "SKILL.md")));
	assert.ok(!existsSync(path.join(dir, "skills", "bundle")));
});

test("resources: zip 单 .md 文件按单文件技能导入", async (t) => {
	const dir = useAgentDir(t);
	const app = makeApp();
	const zip = zipSync({ "solo.md": strToU8("---\ndescription: 单文件\n---\n\n内容\n") });
	const res = await postZip(app, "/api/resources/skills/import-zip", zip);
	assert.equal(res.statusCode, 201, res.body);
	assert.deepEqual(res.json().imported.map((s: { name: string }) => s.name), ["solo"]);
	assert.ok(existsSync(path.join(dir, "skills", "solo", "SKILL.md")));
});

test("resources: zip 无技能 / 坏 zip / zip-slip → 400", async (t) => {
	const dir = useAgentDir(t);
	const app = makeApp();

	// 无 SKILL.md 且多个 .md → 400。
	const multi = zipSync({ "a.md": strToU8("a"), "b.md": strToU8("b") });
	assert.equal((await postZip(app, "/api/resources/skills/import-zip", multi)).statusCode, 400);
	// 空 zip → 400。
	assert.equal((await postZip(app, "/api/resources/skills/import-zip", zipSync({}))).statusCode, 400);
	// 坏 zip → 400。
	assert.equal((await postZip(app, "/api/resources/skills/import-zip", Buffer.from("not a zip"))).statusCode, 400);
	// zip-slip 条目 → 整包拒绝 400，且不落盘任何文件。
	const slip = zipSync({
		"good/SKILL.md": strToU8(skillMd("good")),
		"../evil.txt": strToU8("pwned"),
	});
	const slipRes = await postZip(app, "/api/resources/skills/import-zip", slip);
	assert.equal(slipRes.statusCode, 400, slipRes.body);
	assert.ok(!existsSync(path.join(dir, "skills", "good")));
	assert.ok(!existsSync(path.join(dir, "evil.txt")));
});

test("resources: import 端点 path 以 .zip 结尾时走 zip 导入", async (t) => {
	const dir = useAgentDir(t);
	const app = makeApp();
	const staging = mkdtempSync(path.join(tmpdir(), "pt-import-zip-"));
	const zipPath = path.join(staging, "skills.zip");
	writeFileSync(zipPath, zipSync({ "path-zip/SKILL.md": strToU8(skillMd("path-zip")) }));

	const res = await app.inject({ method: "POST", url: "/api/resources/skills/import", payload: { path: zipPath } });
	assert.equal(res.statusCode, 201, res.body);
	assert.deepEqual(res.json().imported.map((s: { name: string }) => s.name), ["path-zip"]);
	assert.ok(existsSync(path.join(dir, "skills", "path-zip", "SKILL.md")));

	// .zip 路径不存在 → 400。
	assert.equal(
		(await app.inject({ method: "POST", url: "/api/resources/skills/import", payload: { path: path.join(staging, "nope.zip") } }))
			.statusCode,
		400,
	);
});

test("resources: template CRUD 与导入", async (t) => {
	useAgentDir(t);
	const app = makeApp();

	const created = await app.inject({
		method: "POST",
		url: "/api/resources/templates",
		payload: { name: "review", content: "审查 $1 的代码", description: "代码审查", argumentHint: "<path>" },
	});
	assert.equal(created.statusCode, 201);
	assert.equal(created.json().template.argumentHint, "<path>");

	const list = await app.inject({ method: "GET", url: "/api/resources/templates" });
	assert.deepEqual(list.json().templates.map((x: { name: string }) => x.name), ["review"]);
	assert.equal(list.json().templates[0].description, "代码审查");

	const one = await app.inject({ method: "GET", url: "/api/resources/templates/review" });
	assert.equal(one.json().template.content, "审查 $1 的代码");

	const updated = await app.inject({
		method: "PUT",
		url: "/api/resources/templates/review",
		payload: { content: "审查 $@", description: "改" },
	});
	assert.equal(updated.statusCode, 200);
	assert.equal((await app.inject({ method: "GET", url: "/api/resources/templates/review" })).json().template.content, "审查 $@");

	assert.equal((await app.inject({ method: "PUT", url: "/api/resources/templates/ghost", payload: { content: "x" } })).statusCode, 404);

	// 导入单 .md 文件；目录 → 400。
	const staging = mkdtempSync(path.join(tmpdir(), "pt-import-tpl-"));
	const tpl = path.join(staging, "imported-tpl.md");
	writeFileSync(tpl, "---\ndescription: 导入模板\n---\n\n模板 $1\n");
	const imported = await app.inject({ method: "POST", url: "/api/resources/templates/import", payload: { path: tpl } });
	assert.equal(imported.statusCode, 201);
	assert.equal(imported.json().template.name, "imported-tpl");
	assert.equal(
		(await app.inject({ method: "POST", url: "/api/resources/templates/import", payload: { path: staging } })).statusCode,
		400,
	);

	assert.equal((await app.inject({ method: "DELETE", url: "/api/resources/templates/review" })).statusCode, 204);
	assert.equal((await app.inject({ method: "GET", url: "/api/resources/templates/review" })).statusCode, 404);
});

test("resources: 坏 SKILL.md 在 list diagnostics 中暴露", async (t) => {
	const dir = useAgentDir(t);
	const app = makeApp();
	// 缺 description：SDK 复扫给出 warning 且技能不入列。
	const broken = path.join(dir, "skills", "broken-skill");
	mkdirSync(broken, { recursive: true });
	writeFileSync(path.join(broken, "SKILL.md"), "---\nname: broken-skill\n---\n\n没有描述\n");

	const list = await app.inject({ method: "GET", url: "/api/resources/skills" });
	assert.equal(list.statusCode, 200);
	assert.deepEqual(list.json().skills, []);
	assert.ok(list.json().diagnostics.length > 0);

	// 单条读取仍可用（便于编辑修复）。
	const one = await app.inject({ method: "GET", url: "/api/resources/skills/broken-skill" });
	assert.equal(one.statusCode, 200);
	assert.equal(one.json().skill.content, "没有描述");
	// 修复后重新入列。
	const fixed = await app.inject({
		method: "PUT",
		url: "/api/resources/skills/broken-skill",
		payload: { content: "修好了", description: "修复" },
	});
	assert.equal(fixed.statusCode, 200);
	assert.deepEqual((await app.inject({ method: "GET", url: "/api/resources/skills" })).json().skills.map((s: { name: string }) => s.name), ["broken-skill"]);
});
