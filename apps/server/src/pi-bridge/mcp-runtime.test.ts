import assert from "node:assert/strict";
import test from "node:test";
import type { ServerEntry } from "pi-mcp-adapter";
import {
	applyManagedMcpStartupPolicy,
	buildManagedMcpExtension,
	MANAGED_MCP_EXTENSION_NAME,
	MANAGED_MCP_SETTINGS,
} from "./mcp-runtime.js";

test("受管 MCP 在会话启动时连接，并把发现的工具直接注册给 Pi", () => {
	const source: Record<string, ServerEntry> = {
		remote: { url: "https://mcp.example.test/mcp" },
		lazy: { command: "mcp-server", lifecycle: "lazy" },
		kept: { command: "persistent-server", lifecycle: "keep-alive" },
	};
	const resolved = applyManagedMcpStartupPolicy(source);

	assert.equal(MANAGED_MCP_SETTINGS.directTools, true);
	assert.equal(MANAGED_MCP_SETTINGS.scriptMode, false);
	assert.equal(MANAGED_MCP_SETTINGS.requestTimeoutMs, 10_000);
	assert.equal(resolved.remote?.lifecycle, "eager");
	assert.equal(resolved.lazy?.lifecycle, "eager");
	assert.equal(resolved.kept?.lifecycle, "keep-alive");
	assert.equal(source.remote?.lifecycle, undefined, "运行策略不得改写 Catalog 原始 definition");
});

test("MCP Catalog 解析失败只禁用 MCP，不阻止 Agent/Worker Extension 装配", async () => {
	const extension = await buildManagedMcpExtension({
		definitionsFor: async () => {
			throw new Error("broken MCP secret");
		},
	}, ["broken"]);
	assert.ok("factory" in extension);
	assert.equal(extension.name, MANAGED_MCP_EXTENSION_NAME);

	const original = console.error;
	const messages: string[] = [];
	console.error = (...args: unknown[]) => messages.push(args.map(String).join(" "));
	try {
		assert.doesNotThrow(() => extension.factory({} as never));
	} finally {
		console.error = original;
	}
	assert.equal(messages.length, 1);
	assert.match(messages[0]!, /Agent will continue without MCP tools: broken MCP secret/);
});
