import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 自定义 Provider 控制面（借鉴 PuddingClaw 的 ProviderRegistry 模式，映射到
 * pi 原生分层）：自定义 OpenAI-compatible provider/模型持久化在 pi 的
 * `models.json`（`<agentDir>/models.json`，顶层 `{ providers: { id: … } }`），
 * 凭证不进 models.json——走 pi auth.json（ModelRuntime 凭证存储）。
 *
 * 借鉴点：原子写 + 0600 + 数据落在仓库外；模型手填与 API 发现并存。
 * 避坑点：不做明文 credentials.json（复用 pi 凭证体系）；不背遗留迁移包袱。
 */

export interface CustomModelInput {
	id: string;
	name?: string;
	/** 是否推理模型（thinking）。 */
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

export interface CustomProviderInput {
	name: string;
	baseUrl: string;
	/** 调用协议（Api）：openai-completions / openai-responses / anthropic-messages … */
	api: string;
	models: CustomModelInput[];
}

export interface CustomProviderRecord extends CustomProviderInput {
	id: string;
}

type ModelsJson = {
	providers?: Record<string, Record<string, unknown>>;
	[key: string]: unknown;
};

export function modelsJsonPath(): string {
	return path.join(getAgentDir(), "models.json");
}

async function readModelsJson(): Promise<ModelsJson> {
	try {
		const raw = await readFile(modelsJsonPath(), "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ModelsJson;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	return {};
}

/** 原子写（tmp + rename）+ 0600，对齐 PuddingClaw _atomic_json_write。 */
async function writeModelsJson(data: ModelsJson): Promise<void> {
	const file = modelsJsonPath();
	await mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	await rename(tmp, file);
	await chmod(file, 0o600).catch(() => undefined);
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 列出 models.json 里的自定义 provider（含每个的模型清单）。 */
export async function listCustomProviders(): Promise<CustomProviderRecord[]> {
	const data = await readModelsJson();
	const out: CustomProviderRecord[] = [];
	for (const [id, p] of Object.entries(data.providers ?? {})) {
		const models = Array.isArray(p.models) ? (p.models as Array<Record<string, unknown>>) : [];
		out.push({
			id,
			name: typeof p.name === "string" ? p.name : id,
			baseUrl: typeof p.baseUrl === "string" ? p.baseUrl : "",
			api: typeof p.api === "string" ? p.api : "openai-completions",
			models: models
				.filter((m) => typeof m?.id === "string")
				.map((m) => ({
					id: m.id as string,
					...(typeof m.name === "string" ? { name: m.name } : {}),
					...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
					...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
					...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
				})),
		});
	}
	return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 新增/覆盖一个自定义 provider（整体替换该 id 的 models.json 条目）。
 * 凭证不在此处：apiKey 由 /api/providers/:id/key 走 pi 凭证存储。
 */
export async function upsertCustomProvider(id: string, input: CustomProviderInput): Promise<CustomProviderRecord> {
	if (!ID_PATTERN.test(id)) throw new Error(`provider id「${id}」非法：小写字母/数字/连字符，字母开头`);
	if (!input.name?.trim()) throw new Error("provider name 必填");
	if (!input.baseUrl?.trim()) throw new Error("baseUrl 必填");
	if (!/^https?:\/\//.test(input.baseUrl.trim())) throw new Error("baseUrl 必须是 http(s) URL");
	if (!input.api?.trim()) throw new Error("api（调用协议）必填");
	if (!Array.isArray(input.models) || input.models.length === 0) throw new Error("至少登记一个模型");
	const seen = new Set<string>();
	for (const m of input.models) {
		if (!m.id?.trim()) throw new Error("模型 id 必填");
		if (seen.has(m.id)) throw new Error(`模型 id 重复：${m.id}`);
		seen.add(m.id);
	}

	const data = await readModelsJson();
	const providers = { ...(data.providers ?? {}) };
	providers[id] = {
		name: input.name.trim(),
		baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
		api: input.api.trim(),
		models: input.models.map((m) => ({
			id: m.id.trim(),
			name: m.name?.trim() || m.id.trim(),
			reasoning: m.reasoning === true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.contextWindow && m.contextWindow > 0 ? Math.floor(m.contextWindow) : 128_000,
			maxTokens: m.maxTokens && m.maxTokens > 0 ? Math.floor(m.maxTokens) : 8_192,
		})),
	};
	await writeModelsJson({ ...data, providers });
	return {
		id,
		name: input.name.trim(),
		baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
		api: input.api.trim(),
		models: input.models,
	};
}

/** 删除自定义 provider（只移除 models.json 条目；凭证由前端先删 key）。 */
export async function deleteCustomProvider(id: string): Promise<boolean> {
	const data = await readModelsJson();
	if (!data.providers || !(id in data.providers)) return false;
	const providers = { ...data.providers };
	delete providers[id];
	await writeModelsJson({ ...data, providers });
	return true;
}
