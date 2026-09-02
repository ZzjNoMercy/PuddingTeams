import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

interface ClientLike {
	connect(transport: unknown, options?: { timeout?: number }): Promise<void>;
	listTools(params?: undefined, options?: { timeout?: number }): Promise<{ tools: Array<{ name: string }> }>;
	close(): Promise<void>;
}

interface ClientModule {
	Client: new (info: { name: string; version: string }) => ClientLike;
	StreamableHTTPClientTransport: new (url: URL) => unknown;
}

function sendSse(res: ServerResponse, payload: unknown, sessionId?: string): void {
	res.writeHead(200, {
		"cache-control": "no-cache, no-transform",
		"content-type": "text/event-stream",
		...(sessionId ? { "mcp-session-id": sessionId } : {}),
	});
	res.end(`event: message\r\ndata: ${JSON.stringify(payload)}\r\n\r\n`);
}

async function loadClientModule(): Promise<ClientModule> {
	const require = createRequire(import.meta.url);
	const adapterEntry = require.resolve("pi-mcp-adapter");
	const clientCjs = createRequire(adapterEntry).resolve("@modelcontextprotocol/client");
	const clientEsm = path.join(path.dirname(clientCjs), "index.mjs");
	return await import(pathToFileURL(clientEsm).href) as ClientModule;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("等待 MCP GET stream 超时");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function exerciseServer(sessionId?: string): Promise<{ getCount: number; tools: string[] }> {
	let getCount = 0;
	const server = createServer((req, res) => {
		if (req.method === "GET") {
			getCount += 1;
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(": ready\n\n");
			return;
		}

		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
				id?: string | number;
				method?: string;
			};
			switch (message.method) {
				case "initialize":
					sendSse(res, {
						jsonrpc: "2.0",
						id: message.id,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: { tools: { listChanged: true } },
							serverInfo: { name: "test-mcp", version: "1.0.0" },
						},
					}, sessionId);
					break;
				case "notifications/initialized":
					res.writeHead(202, { "content-type": "application/json" });
					res.end();
					break;
				case "tools/list":
					sendSse(res, {
						jsonrpc: "2.0",
						id: message.id,
						result: { tools: [{ name: "ping", inputSchema: { type: "object" } }] },
					});
					break;
				default:
					res.writeHead(202, { "content-type": "application/json" });
					res.end();
			}
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert(address && typeof address === "object");
	const { Client, StreamableHTTPClientTransport } = await loadClientModule();
	const client = new Client({ name: "puddingteams-test", version: "1.0.0" });
	try {
		await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)), { timeout: 1_000 });
		const result = await client.listTools(undefined, { timeout: 1_000 });
		if (sessionId) await waitUntil(() => getCount > 0);
		await client.close();
		return { getCount, tools: result.tools.map((tool) => tool.name) };
	} finally {
		await client.close().catch(() => undefined);
		await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

test("sessionless Streamable HTTP 保持 POST-only，避免独立 GET 阻塞工具发现", async () => {
	const result = await exerciseServer();
	assert.deepEqual(result.tools, ["ping"]);
	assert.equal(result.getCount, 0);
});

test("有 MCP Session 时仍建立 GET SSE 通知流", async () => {
	const result = await exerciseServer("session-1");
	assert.deepEqual(result.tools, ["ping"]);
	assert.equal(result.getCount, 1);
});
