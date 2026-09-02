import { test } from "node:test";
import assert from "node:assert";
import {
	buildWorkspaceFffExtension,
	resolveWorkerCodeSearch,
	stripUnmanagedPlatformExtensions,
	stripUnmanagedPiFff,
	workspaceSearchKey,
} from "./code-search.js";
import type { ExtensionAPI, ExtensionContext, LoadExtensionsResult, SessionShutdownEvent, SessionStartEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

test("Worker 搜索策略：inherit 跟随 Harness，显式覆盖优先", () => {
	assert.equal(resolveWorkerCodeSearch(undefined, "builtin"), "builtin");
	assert.equal(resolveWorkerCodeSearch("inherit", "fff"), "fff");
	assert.equal(resolveWorkerCodeSearch("builtin", "fff"), "builtin");
	assert.equal(resolveWorkerCodeSearch("fff", "builtin"), "fff");
});

test("FFF workspace key 同路径不同身份、同身份不同路径均隔离", () => {
	const a = workspaceSearchKey({ id: "a", canonicalPath: "/repo" });
	assert.notEqual(a, workspaceSearchKey({ id: "b", canonicalPath: "/repo" }));
	assert.notEqual(a, workspaceSearchKey({ id: "a", canonicalPath: "/repo-moved" }));
	assert.match(a, /^[a-f0-9]{32}$/);
});

test("过滤 pi 全局发现的非受控 pi-fff", () => {
	const keep = { path: "/x/other.ts", resolvedPath: "/x/other.ts" };
	const drop = { path: "/x/node_modules/@ff-labs/pi-fff/src/index.ts", resolvedPath: "/x/node_modules/@ff-labs/pi-fff/src/index.ts" };
	const input = { extensions: [keep, drop], errors: [], runtime: {} } as unknown as LoadExtensionsResult;
	assert.deepEqual(stripUnmanagedPiFff(input).extensions, [keep]);
});

test("过滤 pi 全局发现的 MCP adapter，避免绕过平台 Server 选择", () => {
	const keep = { path: "/x/other.ts", resolvedPath: "/x/other.ts" };
	const adapter = { path: "/x/node_modules/pi-mcp-adapter/index.ts", resolvedPath: "/x/node_modules/pi-mcp-adapter/index.ts" };
	const input = { extensions: [keep, adapter], errors: [], runtime: {} } as unknown as LoadExtensionsResult;
	assert.deepEqual(stripUnmanagedPlatformExtensions(input).extensions, [keep]);
});

test("受控 FFF 拒绝跨 Workspace path/cursor，且不暴露模式切换命令", async () => {
	const tools = new Map<string, ToolDefinition>();
	const commands: string[] = [];
	const inline = await buildWorkspaceFffExtension({
		stateRoot: mkdtempSync(path.join(tmpdir(), "pt-fff-state-")),
		workspace: { id: "workspace-a", canonicalPath: "/workspace/a", trusted: true },
	});
	if (typeof inline === "function") throw new Error("expected named inline extension");
	const api = {
		getFlag: () => undefined,
		registerFlag: () => undefined,
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: (name: string) => commands.push(name),
		on: () => undefined,
	} as unknown as ExtensionAPI;
	await inline.factory(api);
	assert.ok(tools.has("grep"));
	assert.ok(tools.has("multi_grep"));
	assert.ok(!commands.includes("fff-mode"));
	const grep = tools.get("grep")! as ToolDefinition & { execute: (...args: unknown[]) => Promise<unknown> };
	await assert.rejects(() => grep.execute("call", { pattern: "secret", path: "/other/repo" }), /当前 Workspace/);
	await assert.rejects(() => grep.execute("call", { pattern: "secret", cursor: "fff_c1" }), /cursor 不属于当前 Workspace/);
});

test("受控 FFF 拒绝 path 与 multi_grep constraints 通过符号链接逃出 Workspace", async () => {
	const workspace = mkdtempSync(path.join(tmpdir(), "pt-fff-symlink-workspace-"));
	const outside = mkdtempSync(path.join(tmpdir(), "pt-fff-symlink-outside-"));
	symlinkSync(outside, path.join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
	const tools = new Map<string, ToolDefinition>();
	const inline = await buildWorkspaceFffExtension({
		stateRoot: mkdtempSync(path.join(tmpdir(), "pt-fff-state-")),
		workspace: { id: "workspace-symlink", canonicalPath: workspace, trusted: true },
	});
	if (typeof inline === "function") throw new Error("expected named inline extension");
	await inline.factory({
		getFlag: () => undefined,
		registerFlag: () => undefined,
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: () => undefined,
		on: () => undefined,
	} as unknown as ExtensionAPI);
	const grep = tools.get("grep")! as ToolDefinition & { execute: (...args: unknown[]) => Promise<unknown> };
	const multiGrep = tools.get("multi_grep")! as ToolDefinition & { execute: (...args: unknown[]) => Promise<unknown> };
	await assert.rejects(
		() => grep.execute("call", { pattern: "secret", path: "escape" }),
		/符号链接/,
	);
	await assert.rejects(
		() => multiGrep.execute("call", { patterns: ["secret"], constraints: "escape\/**" }),
		/符号链接/,
	);
});

test("受控 FFF 将 session_start cwd 钉死为登记的 canonical Workspace", async () => {
	const workspace = mkdtempSync(path.join(tmpdir(), "pt-fff-workspace-"));
	const wrongRoot = mkdtempSync(path.join(tmpdir(), "pt-fff-wrong-root-"));
	const marker = `inside-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	writeFileSync(path.join(workspace, "inside.txt"), marker);
	writeFileSync(path.join(wrongRoot, "outside.txt"), marker);
	const tools = new Map<string, ToolDefinition>();
	let start: ((event: SessionStartEvent, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	let shutdown: ((event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	const inline = await buildWorkspaceFffExtension({
		stateRoot: mkdtempSync(path.join(tmpdir(), "pt-fff-state-")),
		workspace: { id: "workspace-cwd", canonicalPath: workspace, trusted: true },
	});
	if (typeof inline === "function") throw new Error("expected named inline extension");
	const api = {
		getFlag: () => undefined,
		registerFlag: () => undefined,
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: () => undefined,
		on: (event: string, handler: typeof start) => {
			if (event === "session_start") start = handler;
			if (event === "session_shutdown") shutdown = handler as typeof shutdown;
		},
	} as unknown as ExtensionAPI;
	await inline.factory(api);
	assert.ok(start, "FFF 必须注册 session_start");
	const ctx = {
		cwd: wrongRoot,
		ui: { notify() {}, setStatus() {}, addAutocompleteProvider() {} },
		sessionManager: { getEntries: () => [] },
	} as unknown as ExtensionContext;
	await start!({ type: "session_start", reason: "startup" }, ctx);
	try {
		const grep = tools.get("grep")!;
		const result = await grep.execute("call", { pattern: marker }, undefined, undefined, ctx);
		const text = result.content.find((block) => block.type === "text")?.text ?? "";
		assert.match(text, /inside\.txt/);
		assert.doesNotMatch(text, /outside\.txt/);
	} finally {
		await shutdown?.({ type: "session_shutdown", reason: "quit" }, ctx);
	}
});
