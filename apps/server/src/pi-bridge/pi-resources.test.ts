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
function assertMembership(names: string[], present: string[], absent: string[], message?: string): void {
	for (const name of present) assert.ok(names.includes(name), `应包含 ${name}，实际：${names.join(", ")}`);
	for (const name of absent) assert.ok(!names.includes(name), message ?? `不应包含 ${name}，实际：${names.join(", ")}`);
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

/**
 * 信任门（迁移方案 §7.2/§6.3）：workspaceAccess 与 Agent 开关取与；
 * denied 来源不进装配/预览候选集，global/extra 来源不受影响。
 */
const ALL_ALLOWED = { context: true, skills: true, prompts: true } as const;
const ALL_DENIED = { context: false, skills: false, prompts: false } as const;

function makeContextFixture(): Fixture & { agentDir: string; cwd: string } {
	const fixture = makeFixture();
	writeFileSync(path.join(fixture.cwd, "AGENTS.md"), "工作区上下文");
	return fixture;
}

test("pi-resources: 信任门全关时 workspace 来源被剔除，global/extra 不受影响", async () => {
	const fixture = makeContextFixture();
	const loader = await loadPiResources({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		resources: { skillPaths: [fixture.extraSkills], promptTemplatePaths: [fixture.extraPrompts] },
		workspaceAccess: ALL_DENIED,
	});
	const skills = loader.getSkills().skills.map((s) => s.name);
	assertMembership(skills, ["ext-skill"], ["ws-skill"]);
	const prompts = loader.getPrompts().prompts.map((p) => p.name);
	assertMembership(prompts, ["ext-tpl"], ["ws-tpl"]);
	assert.equal(loader.getAgentsFiles().agentsFiles.length, 0, "context denied 时不得读 workspace AGENTS.md");
});

test("pi-resources: 信任门逐类放行——只批 skills 时 context/prompts 不进候选集", async () => {
	const fixture = makeContextFixture();
	const loader = await loadPiResources({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		workspaceAccess: { context: false, skills: true, prompts: false },
	});
	assertMembership(loader.getSkills().skills.map((s) => s.name), ["ws-skill"], []);
	assertMembership(loader.getPrompts().prompts.map((p) => p.name), [], ["ws-tpl"]);
	assert.equal(loader.getAgentsFiles().agentsFiles.length, 0);
});

test("pi-resources: 信任门全开等价于旧行为；Agent 开关仍可单独关闭", async () => {
	const fixture = makeContextFixture();
	const open = await loadPiResources({ cwd: fixture.cwd, agentDir: fixture.agentDir, workspaceAccess: ALL_ALLOWED });
	assertMembership(open.getSkills().skills.map((s) => s.name), ["ws-skill"], []);
	assert.ok(open.getAgentsFiles().agentsFiles.length > 0);

	const agentOff = await loadPiResources({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		resources: { loadWorkspaceSkills: false },
		workspaceAccess: ALL_ALLOWED,
	});
	assertMembership(agentOff.getSkills().skills.map((s) => s.name), [], ["ws-skill"], "Agent 开关与信任门取与");
});

test("pi-resources: preview 按信任门过滤 workspace 来源并回显 workspace 标识", async () => {
	const fixture = makeContextFixture();
	const denied = await previewPiResources({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		workspaceAccess: ALL_DENIED,
		workspace: { id: "ws1", trust: { state: "pending", policyVersion: 1 } },
	});
	assert.equal(denied.skills.some((s) => s.source === "workspace"), false);
	assert.equal(denied.prompts.some((p) => p.source === "workspace"), false);
	assert.equal(denied.segments.some((s) => s.source === "workspace-context"), false);
	assert.deepEqual(denied.contextFiles, []);
	assert.equal(denied.workspace?.id, "ws1");

	const open = await previewPiResources({ cwd: fixture.cwd, agentDir: fixture.agentDir, workspaceAccess: ALL_ALLOWED });
	assert.ok(open.segments.some((s) => s.source === "workspace-context"));
	assert.ok(open.skills.some((s) => s.source === "workspace"));
	assert.equal(open.workspace, null, "未传 workspace 标识时 preview.workspace = null（§6.3）");
});


/**
 * append-only 注入（提示词管理方案 §3/§8.1）：运行指令与 collaboration 经
 * appendSystemPromptOverride 追加——pi 内嵌默认提示词不被顶掉，用户已有的
 * APPEND_SYSTEM.md 保持在前、不被覆盖。
 */
test("pi-resources: 运行指令/collaboration append-only，不覆盖 pi base 与 APPEND_SYSTEM.md", async () => {
	const fixture = makeFixture();
	writeFileSync(path.join(fixture.agentDir, "APPEND_SYSTEM.md"), "用户原生追加");
	const loader = await loadPiResources({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		resources: { systemPrompt: "  Agent 运行指令  " },
		collaboration: "群聊协作提示词",
	});
	// 无 SYSTEM.md：base 保持 undefined，由 pi 在请求装配时生成内嵌默认文本（验收 1）。
	assert.equal(loader.getSystemPrompt(), undefined);
	// append 顺序（验收 2）：pi 原生 APPEND_SYSTEM.md 在前，运行指令与 collaboration 只追加。
	assert.deepEqual(loader.getAppendSystemPrompt(), ["用户原生追加", "Agent 运行指令", "群聊协作提示词"]);

	// 空配置时不产生任何追加段。
	const empty = await loadPiResources({ cwd: fixture.cwd, agentDir: freshDir("pt-wl-empty-") });
	assert.deepEqual(empty.getAppendSystemPrompt(), []);
});

/**
 * context 开关（§4/§8.2）：关闭 loadWorkspaceContext 或信任门 denied 时只剔除
 * 显式 Workspace 及目录层级文件，pi global agentDir/AGENTS.md 必须保留（验收 7）。
 */
test("pi-resources: 关闭 workspace context 保留 pi global AGENTS.md", async () => {
	const fixture = makeContextFixture();
	writeFileSync(path.join(fixture.agentDir, "AGENTS.md"), "pi global 上下文");

	const off = await loadPiResources({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		resources: { loadWorkspaceContext: false },
	});
	const offPaths = off.getAgentsFiles().agentsFiles.map((f) => f.path);
	assert.ok(offPaths.some((p) => isUnder(p, fixture.agentDir)), "pi global AGENTS.md 必须保留");
	assert.ok(!offPaths.some((p) => isUnder(p, fixture.cwd)), "workspace AGENTS.md 必须剔除");

	const denied = await loadPiResources({ cwd: fixture.cwd, agentDir: fixture.agentDir, workspaceAccess: ALL_DENIED });
	const deniedPaths = denied.getAgentsFiles().agentsFiles.map((f) => f.path);
	assert.ok(deniedPaths.some((p) => isUnder(p, fixture.agentDir)), "信任门 denied 时 pi global 仍保留");
	assert.ok(!deniedPaths.some((p) => isUnder(p, fixture.cwd)));
});

function isUnder(filePath: string, dir: string): boolean {
	const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
	return filePath === dir || filePath.startsWith(prefix);
}

test("pi-resources: preview 按真实装配顺序分段（pi base → 原生 append → 运行指令 → collaboration → global/workspace context）", async () => {
	const fixture = makeContextFixture();
	writeFileSync(path.join(fixture.agentDir, "AGENTS.md"), "pi global 上下文");
	writeFileSync(path.join(fixture.agentDir, "APPEND_SYSTEM.md"), "用户原生追加");
	const preview = await previewPiResources({
		cwd: fixture.cwd,
		agentDir: fixture.agentDir,
		resources: { systemPrompt: "Agent 运行指令" },
		collaboration: "群聊协作提示词",
		workspaceAccess: ALL_ALLOWED,
	});
	const sources = preview.segments.map((s) => s.source);
	assert.deepEqual(sources, [
		"pi-base",
		"pi-native-append",
		"agent-instructions",
		"window-collaboration",
		"global-context",
		"workspace-context",
	]);
	const append = preview.segments.find((s) => s.source === "pi-native-append")!;
	assert.equal(append.content, "用户原生追加");
	assert.ok(append.path?.endsWith(path.join("APPEND_SYSTEM.md")));
	// effectivePrompt 按真实顺序拼接，不含占位文案。
	assert.equal(
		preview.effectivePrompt,
		["用户原生追加", "Agent 运行指令", "群聊协作提示词"].join("\n\n"),
	);

	// 无 SYSTEM.md 时 pi-base 为占位说明（collapsed），不构成 customPrompt。
	const bare = await previewPiResources({ cwd: fixture.cwd, agentDir: fixture.agentDir, workspaceAccess: ALL_ALLOWED });
	const base = bare.segments.find((s) => s.source === "pi-base")!;
	assert.ok(base.content.includes("pi 内嵌默认提示词"));
	assert.equal(bare.segments.some((s) => s.source === "agent-instructions"), false);
});
