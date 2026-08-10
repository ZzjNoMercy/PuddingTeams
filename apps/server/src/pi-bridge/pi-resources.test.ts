import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPiResources, previewPiResources } from "./pi-resources.js";
import type { PiResourceConfig } from "../store/teams.js";

/**
 * 白名单装配测试（§10.5）：库资源（pi 全局目录）默认不启用，enabledSkills /
 * enabledPrompts 勾选后才进 getSkills()/getPrompts()；workspace（.pi/）与
 * skillPaths 额外挂载的资源不受白名单管。
 */

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function writeSkill(root: string, name: string, description: string): void {
	const dir = path.join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`);
}

function writeTemplate(root: string, name: string, description: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(path.join(root, `${name}.md`), `---\ndescription: ${description}\n---\n\n模板 $1\n`);
}

interface Fixture {
	agentDir: string;
	cwd: string;
	extraSkills: string;
	extraPrompts: string;
}

function makeFixture(): Fixture {
	const agentDir = freshDir("pt-wl-agent-");
	const cwd = freshDir("pt-wl-cwd-");
	const extraSkills = freshDir("pt-wl-extra-skills-");
	const extraPrompts = freshDir("pt-wl-extra-prompts-");
	writeSkill(path.join(agentDir, "skills"), "lib-skill", "库技能");
	writeSkill(path.join(cwd, ".pi", "skills"), "ws-skill", "工作区技能");
	writeSkill(extraSkills, "ext-skill", "额外技能");
	writeTemplate(path.join(agentDir, "prompts"), "lib-tpl", "库模板");
	writeTemplate(path.join(cwd, ".pi", "prompts"), "ws-tpl", "工作区模板");
	writeTemplate(extraPrompts, "ext-tpl", "额外模板");
	return { agentDir, cwd, extraSkills, extraPrompts };
}

async function skillNames(fixture: Fixture, resources?: PiResourceConfig): Promise<string[]> {
	const loader = await loadPiResources({ cwd: fixture.cwd, agentDir: fixture.agentDir, resources });
	return loader
		.getSkills()
		.skills.map((s) => s.name)
		.sort();
}

async function promptNames(fixture: Fixture, resources?: PiResourceConfig): Promise<string[]> {
	const loader = await loadPiResources({ cwd: fixture.cwd, agentDir: fixture.agentDir, resources });
	return loader
		.getPrompts()
		.prompts.map((p) => p.name)
		.sort();
}

/** 成员断言：本机 ~/.agents/skills 等额外来源可能混入清单，只校验关注项。 */
function assertMembership(names: string[], present: string[], absent: string[]): void {
	for (const name of present) assert.ok(names.includes(name), `应包含 ${name}，实际：${names.join(", ")}`);
	for (const name of absent) assert.ok(!names.includes(name), `不应包含 ${name}，实际：${names.join(", ")}`);
}

test("pi-resources: 缺省不启用任何库资源，workspace 资源不受影响", async () => {
	const fixture = makeFixture();
	assertMembership(await skillNames(fixture, undefined), ["ws-skill"], ["lib-skill"]);
	assertMembership(await skillNames(fixture, {}), ["ws-skill"], ["lib-skill"]);
	assertMembership(await promptNames(fixture, undefined), ["ws-tpl"], ["lib-tpl"]);
});

test("pi-resources: 勾选后库资源出现", async () => {
	const fixture = makeFixture();
	assertMembership(await skillNames(fixture, { enabledSkills: ["lib-skill"] }), ["lib-skill", "ws-skill"], []);
	assertMembership(await promptNames(fixture, { enabledPrompts: ["lib-tpl"] }), ["lib-tpl", "ws-tpl"], []);
});

test("pi-resources: skillPaths/promptTemplatePaths 额外挂载不受白名单管", async () => {
	const fixture = makeFixture();
	assertMembership(await skillNames(fixture, { skillPaths: [fixture.extraSkills] }), ["ext-skill", "ws-skill"], ["lib-skill"]);
	assertMembership(await promptNames(fixture, { promptTemplatePaths: [fixture.extraPrompts] }), ["ext-tpl", "ws-tpl"], ["lib-tpl"]);
	// 与白名单叠加：额外挂载照常，库资源仍需勾选。
	assertMembership(
		await skillNames(fixture, { skillPaths: [fixture.extraSkills], enabledSkills: ["lib-skill"] }),
		["ext-skill", "lib-skill", "ws-skill"],
		[],
	);
});

test("pi-resources: 关闭 workspace 开关后只剩显式挂载与勾选的库资源", async () => {
	const fixture = makeFixture();
	assertMembership(
		await skillNames(fixture, { loadWorkspaceSkills: false, enabledSkills: ["lib-skill"] }),
		["lib-skill"],
		["ws-skill"],
	);
	assertMembership(await promptNames(fixture, { loadWorkspacePrompts: false }), [], ["ws-tpl", "lib-tpl"]);
});

test("pi-resources: preview 标注 description/source/enabled", async () => {
	const fixture = makeFixture();
	const preview = await previewPiResources({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		resources: { enabledSkills: ["lib-skill"], skillPaths: [fixture.extraSkills] },
	});
	const byName = new Map(preview.skills.map((s) => [s.name, s]));
	assert.deepEqual(byName.get("lib-skill"), {
		name: "lib-skill",
		description: "库技能",
		path: byName.get("lib-skill")!.path,
		source: "global",
		enabled: true,
	});
	assert.equal(byName.get("ws-skill")!.source, "workspace");
	assert.equal(byName.get("ws-skill")!.enabled, true);
	assert.equal(byName.get("ext-skill")!.source, "extra");
	assert.equal(byName.get("ext-skill")!.enabled, true);

	// 未勾选时 preview 仍列出库资源但 enabled=false（供配置页渲染开关）。
	const off = await previewPiResources({ cwd: fixture.cwd, agentDir: fixture.agentDir, resources: {} });
	const lib = off.skills.find((s) => s.name === "lib-skill")!;
	assert.equal(lib.source, "global");
	assert.equal(lib.enabled, false);
	const tpl = off.prompts.find((p) => p.name === "lib-tpl")!;
	assert.deepEqual({ source: tpl.source, enabled: tpl.enabled, description: tpl.description }, {
		source: "global",
		enabled: false,
		description: "库模板",
	});
});
