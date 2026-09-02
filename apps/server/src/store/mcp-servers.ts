import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServerEntry } from "pi-mcp-adapter";
import type { CredentialsStore } from "./credentials.js";

const MCP_SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SECRET_KEY = /^[A-Z][A-Z0-9_]*$/;
const SECRET_REFERENCE = /\$\{[A-Z][A-Z0-9_]*\}/;
const SENSITIVE_HEADER = /^(?:authorization|cookie|proxy-authorization|x-api-key|api-key)$/i;
const SENSITIVE_ENV_KEY = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASS|API_KEY|PRIVATE_KEY|ACCESS_KEY)(?:$|_)/i;

export interface McpServerRecord {
	id: string;
	displayName: string;
	description?: string;
	definition: ServerEntry;
	secretKeys: string[];
	createdAt: string;
	updatedAt: string;
}

interface McpServersFile {
	version: 1;
	servers: McpServerRecord[];
}

export interface McpServerInput {
	id: string;
	displayName: string;
	description?: string;
	definition: ServerEntry;
	/** 明文只用于本次写入，落盘记录仅保留 secretKeys。空串删除。 */
	secrets?: Record<string, string>;
}

function stringRecord(value: unknown, label: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须是字符串对象`);
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") throw new Error(`${label}.${key} 必须是字符串`);
		result[key] = item;
	}
	return result;
}

/**
 * 平台托管的 MCP Server definition。只接受 adapter 的安全常用子集；明文
 * bearerToken / OAuth clientSecret 必须走 secrets + 环境变量引用，不能进入
 * config/mcp-servers.json。
 */
export function normalizeMcpServerDefinition(input: unknown): ServerEntry {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("definition 必须是对象");
	const raw = input as Record<string, unknown>;
	if (raw.bearerToken !== undefined) throw new Error("bearerToken 不得明文保存；请使用 bearerTokenEnv + secrets");
	if (raw.oauth && typeof raw.oauth === "object" && !Array.isArray(raw.oauth) && (raw.oauth as Record<string, unknown>).clientSecret !== undefined) {
		throw new Error("oauth.clientSecret 不得明文保存；请使用不含 clientSecret 的 OAuth 配置");
	}
	const command = typeof raw.command === "string" ? raw.command.trim() : "";
	const url = typeof raw.url === "string" ? raw.url.trim() : "";
	if (Boolean(command) === Boolean(url)) throw new Error("definition 必须且只能配置 command 或 url");
	if (url) {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error("definition.url 必须是有效 URL");
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("definition.url 只支持 http/https");
	}
	if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((item) => typeof item !== "string"))) {
		throw new Error("definition.args 必须是字符串数组");
	}
	if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || !raw.cwd.trim())) throw new Error("definition.cwd 必须是非空字符串");
	if (raw.bearerTokenEnv !== undefined && (typeof raw.bearerTokenEnv !== "string" || !SECRET_KEY.test(raw.bearerTokenEnv))) {
		throw new Error("definition.bearerTokenEnv 必须是 UPPER_SNAKE 环境变量名");
	}
	const env = stringRecord(raw.env, "definition.env");
	const headers = stringRecord(raw.headers, "definition.headers");
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (SENSITIVE_HEADER.test(key) && !SECRET_REFERENCE.test(value)) {
			throw new Error(`definition.headers.${key} 疑似包含凭据；请改用 \${KEY} 引用并在 secrets 中保存`);
		}
	}
	for (const [key, value] of Object.entries(env ?? {})) {
		if (SENSITIVE_ENV_KEY.test(key) && value && !SECRET_REFERENCE.test(value)) {
			throw new Error(`definition.env.${key} 疑似包含凭据；请改用 \${${key}} 引用并在 secrets 中保存`);
		}
	}
	const definition: ServerEntry = {
		...(command ? { command } : { url }),
		...(raw.args !== undefined ? { args: [...raw.args as string[]] } : {}),
		...(typeof raw.cwd === "string" ? { cwd: raw.cwd.trim() } : {}),
		...(env ? { env } : {}),
		...(headers ? { headers } : {}),
		...(raw.auth === "oauth" || raw.auth === "bearer" || raw.auth === false ? { auth: raw.auth } : {}),
		...(typeof raw.bearerTokenEnv === "string" ? { bearerTokenEnv: raw.bearerTokenEnv } : {}),
		...(raw.oauth === false || (raw.oauth && typeof raw.oauth === "object" && !Array.isArray(raw.oauth))
			? { oauth: structuredClone(raw.oauth) as ServerEntry["oauth"] }
			: {}),
		...(raw.lifecycle === "lazy" || raw.lifecycle === "eager" || raw.lifecycle === "keep-alive" || raw.lifecycle === "lazy-keep-alive"
			? { lifecycle: raw.lifecycle }
			: {}),
		...(typeof raw.requestTimeoutMs === "number" && Number.isFinite(raw.requestTimeoutMs) && raw.requestTimeoutMs > 0
			? { requestTimeoutMs: Math.floor(raw.requestTimeoutMs) }
			: {}),
		...(raw.protocolVersion === "legacy" || raw.protocolVersion === "auto" || raw.protocolVersion === "2026-07-28"
			? { protocolVersion: raw.protocolVersion }
			: {}),
		...(raw.exposeResources === true ? { exposeResources: true } : {}),
		...(Array.isArray(raw.includeTools) && raw.includeTools.every((item) => typeof item === "string") ? { includeTools: raw.includeTools } : {}),
		...(Array.isArray(raw.excludeTools) && raw.excludeTools.every((item) => typeof item === "string") ? { excludeTools: raw.excludeTools } : {}),
	};
	return definition;
}

function interpolateSecrets(value: string, secrets: Record<string, string>): string {
	return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (match, key: string) => secrets[key] ?? match);
}

/** 全局 MCP Server Catalog；Server 事实与 Agent 选择分离。 */
export class McpServerStore {
	private readonly file: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(configDir: string, private readonly secrets: CredentialsStore) {
		this.file = path.join(configDir, "mcp-servers.json");
	}

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	private async read(): Promise<McpServersFile> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf-8")) as Partial<McpServersFile>;
			if (parsed.version !== 1 || !Array.isArray(parsed.servers)) throw new Error("mcp-servers.json 结构无效");
			const servers = parsed.servers.map((value, index) => {
				if (!value || typeof value !== "object") throw new Error(`mcp-servers.json servers[${index}] 结构无效`);
				const server = value as Partial<McpServerRecord>;
				if (typeof server.id !== "string" || !MCP_SERVER_ID.test(server.id)) throw new Error(`mcp-servers.json servers[${index}].id 无效`);
				if (typeof server.displayName !== "string" || !server.displayName.trim()) throw new Error(`mcp-servers.json servers[${index}].displayName 无效`);
				if (server.description !== undefined && typeof server.description !== "string") throw new Error(`mcp-servers.json servers[${index}].description 无效`);
				if (!Array.isArray(server.secretKeys) || server.secretKeys.some((key) => typeof key !== "string" || !SECRET_KEY.test(key))) {
					throw new Error(`mcp-servers.json servers[${index}].secretKeys 无效`);
				}
				if (typeof server.createdAt !== "string" || typeof server.updatedAt !== "string") throw new Error(`mcp-servers.json servers[${index}] 时间字段无效`);
				return {
					id: server.id,
					displayName: server.displayName.trim(),
					...(server.description?.trim() ? { description: server.description.trim() } : {}),
					definition: normalizeMcpServerDefinition(server.definition),
					secretKeys: [...new Set(server.secretKeys)].sort(),
					createdAt: server.createdAt,
					updatedAt: server.updatedAt,
				};
			});
			return { version: 1, servers };
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, servers: [] };
			throw err;
		}
	}

	private async write(data: McpServersFile): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		const temp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
		await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
		await rename(temp, this.file);
	}

	async list(): Promise<McpServerRecord[]> {
		return (await this.read()).servers.map((server) => structuredClone(server));
	}

	async get(id: string): Promise<McpServerRecord | undefined> {
		return (await this.list()).find((server) => server.id === id);
	}

	private normalizeInput(input: McpServerInput, existing?: McpServerRecord): McpServerRecord {
		const id = input.id?.trim();
		if (!MCP_SERVER_ID.test(id)) throw new Error("MCP Server id 只能包含字母、数字、连字符或下划线，且不超过 64 字符");
		const displayName = input.displayName?.trim();
		if (!displayName) throw new Error("displayName 必填");
		if ([...displayName].length > 80) throw new Error("displayName 不能超过 80 个字符");
		const description = input.description?.trim();
		const now = new Date().toISOString();
		return {
			id,
			displayName,
			...(description ? { description } : {}),
			definition: normalizeMcpServerDefinition(input.definition),
			secretKeys: existing?.secretKeys ?? [],
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
	}

	private async applySecrets(id: string, input: Record<string, string> | undefined): Promise<string[]> {
		if (input !== undefined) {
			for (const [key, value] of Object.entries(input)) {
				if (!SECRET_KEY.test(key)) throw new Error(`secret key「${key}」必须是 UPPER_SNAKE`);
				if (typeof value !== "string") throw new Error(`secret「${key}」必须是字符串`);
			}
			await this.secrets.setSecrets(id, input);
		}
		return (await this.secrets.listConfigured(id)).sort();
	}

	async create(input: McpServerInput): Promise<McpServerRecord> {
		return this.serialize(async () => {
			const data = await this.read();
			if (data.servers.some((server) => server.id === input.id?.trim())) throw new Error(`MCP Server 已存在：${input.id}`);
			const record = this.normalizeInput(input);
			record.secretKeys = await this.applySecrets(record.id, input.secrets);
			data.servers.push(record);
			data.servers.sort((a, b) => a.displayName.localeCompare(b.displayName));
			await this.write(data);
			return structuredClone(record);
		});
	}

	async update(id: string, input: Omit<McpServerInput, "id">): Promise<McpServerRecord> {
		return this.serialize(async () => {
			const data = await this.read();
			const index = data.servers.findIndex((server) => server.id === id);
			if (index < 0) throw new Error(`MCP Server 不存在：${id}`);
			const record = this.normalizeInput({ ...input, id }, data.servers[index]);
			record.secretKeys = await this.applySecrets(id, input.secrets);
			data.servers[index] = record;
			data.servers.sort((a, b) => a.displayName.localeCompare(b.displayName));
			await this.write(data);
			return structuredClone(record);
		});
	}

	async remove(id: string): Promise<boolean> {
		return this.serialize(async () => {
			const data = await this.read();
			const next = data.servers.filter((server) => server.id !== id);
			if (next.length === data.servers.length) return false;
			await this.write({ version: 1, servers: next });
			await this.secrets.removeAgentSecrets(id);
			return true;
		});
	}

	/** 解析指定 Agent 的 Server 子集；顺序由调用方选择但 key 使用稳定 id。 */
	async definitionsFor(ids: readonly string[]): Promise<Record<string, ServerEntry>> {
		const records = new Map((await this.list()).map((record) => [record.id, record]));
		const result: Record<string, ServerEntry> = {};
		for (const id of [...new Set(ids)]) {
			const record = records.get(id);
			if (!record) throw new Error(`Agent 引用了不存在的 MCP Server：${id}`);
			const definition = structuredClone(record.definition);
			const secrets = await this.secrets.getSecrets(id);
			definition.env = Object.fromEntries(
				Object.entries({ ...(definition.env ?? {}), ...secrets }).map(([key, value]) => [key, interpolateSecrets(value, secrets)]),
			);
			if (definition.headers) {
				definition.headers = Object.fromEntries(Object.entries(definition.headers).map(([key, value]) => [key, interpolateSecrets(value, secrets)]));
			}
			if (definition.url) definition.url = interpolateSecrets(definition.url, secrets);
			if (definition.args) definition.args = definition.args.map((value) => interpolateSecrets(value, secrets));
			if (definition.cwd) definition.cwd = interpolateSecrets(definition.cwd, secrets);
			if (definition.bearerTokenEnv && secrets[definition.bearerTokenEnv]) {
				definition.bearerToken = secrets[definition.bearerTokenEnv];
				delete definition.bearerTokenEnv;
			}
			result[id] = definition;
		}
		return result;
	}
}
