import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * 自定义 Provider 控制面（借鉴 PuddingClaw 的 ProviderRegistry 模式，映射到
 * pi 原生分层）：自定义 OpenAI-compatible provider/模型持久化在 pi 的
 * `models.json`（`<agentDir>/models.json`，顶层 `{ providers: { id: … } }`），
 * 凭证不进 models.json——走平台自有 auth.json（共享 ModelRuntime 的凭证
 * 存储，<home>/secrets/auth.json，与 pi CLI 解耦 §10.6）。
 *
 * 借鉴点：原子写 + 0600 + 数据落在仓库外；模型手填与 API 发现并存。
 * 避坑点：不做明文 credentials.json（复用 pi 凭证体系）；不背遗留迁移包袱。
 */

export interface CustomModelInput {
	id: string;
	name?: string;
	/** 是否推理模型（thinking）。 */
	reasoning?: boolean;
	/** Explicit provider capability declaration; never inferred from model names. */
	vision?: boolean;
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

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

export function modelsJsonPath(): string {
	return path.join(getAgentDir(), "models.json");
}

export class CustomProviderConflictError extends Error {
	constructor() {
		super("自定义 Provider 目录已变化，请刷新后重试");
		this.name = "CustomProviderConflictError";
	}
}

export class CustomProviderFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CustomProviderFormatError";
	}
}

/** models.json rename 已发生，但父目录同步失败；最终提交须由冷启动核对。 */
export class CustomProviderDurabilityError extends Error {
	constructor(options: ErrorOptions) {
		super("自定义 Provider 目录提交持久性未确认，请重启后核对", options);
		this.name = "CustomProviderDurabilityError";
	}
}

async function readModelsRaw(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}
	return null;
}

function revisionOf(raw: string | null): string {
	return createHash("sha256").update(raw === null ? "missing" : `present:${raw}`).digest("hex");
}

async function readModelsSnapshot(file = modelsJsonPath()): Promise<{ data: ModelsJson; raw: string | null; revision: string }> {
	const raw = await readModelsRaw(file);
	if (raw === null) return { data: {}, raw, revision: revisionOf(raw) };
	let parsed: unknown;
	try { parsed = JSON.parse(raw) as unknown; }
	catch { throw new CustomProviderFormatError("models.json 不是有效 JSON"); }
	if (!isRecord(parsed)) throw new CustomProviderFormatError("models.json 必须是 JSON 对象");
	if (parsed.providers !== undefined) {
		if (!isRecord(parsed.providers)) throw new CustomProviderFormatError("models.json providers 必须是对象");
		for (const [id, provider] of Object.entries(parsed.providers)) {
			if (!isRecord(provider)) throw new CustomProviderFormatError(`models.json providers.${id} 必须是对象`);
			if (provider.models !== undefined && !Array.isArray(provider.models)) throw new CustomProviderFormatError(`models.json providers.${id}.models 必须是数组`);
			if (Array.isArray(provider.models) && provider.models.some((model) => !isRecord(model) || typeof model.id !== "string" || !model.id.trim())) {
				throw new CustomProviderFormatError(`models.json providers.${id}.models 的模型 id 必须是非空字符串`);
			}
		}
	}
	return { data: parsed as ModelsJson, raw, revision: revisionOf(raw) };
}

async function defaultSyncModelsDirectory(directory: string): Promise<void> {
	const handle = await open(directory, "r");
	try { await handle.sync(); }
	finally { await handle.close(); }
}

let syncModelsDirectory = defaultSyncModelsDirectory;

/** Fault seam for durability tests; reset with undefined in finally. */
export function setModelsDirectorySyncForTests(sync?: (directory: string) => Promise<void>): void {
	syncModelsDirectory = sync ?? defaultSyncModelsDirectory;
}

/** 先同步 0600 临时文件，再 rename 并同步父目录；失败不能报告确定提交。 */
async function writeModelsJson(data: ModelsJson, file: string, sourceRaw: string | null): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
	let renamed = false;
	try {
		const handle = await open(tmp, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`);
			await handle.sync();
		} finally { await handle.close(); }
		if ((await readModelsRaw(file)) !== sourceRaw) throw new CustomProviderConflictError();
		await rename(tmp, file);
		renamed = true;
		await syncModelsDirectory(path.dirname(file));
	} catch (error) {
		if (renamed) {
			uncertainModelsFiles.add(file);
			throw new CustomProviderDurabilityError({ cause: error });
		}
		throw error;
	} finally {
		await rm(tmp, { force: true }).catch(() => undefined);
	}
}

const mutationTails = new Map<string, Promise<void>>();
const uncertainModelsFiles = new Set<string>();

export function assertCustomProviderCatalogWritable(): void {
	if (uncertainModelsFiles.has(modelsJsonPath())) {
		throw new CustomProviderDurabilityError({ cause: new Error("同进程目录提交尚未确认") });
	}
}

async function mutateModelsJson<T>(action: (file: string) => Promise<T>): Promise<T> {
	const file = modelsJsonPath();
	const previous = mutationTails.get(file) ?? Promise.resolve();
	const run = previous.then(() => {
		assertCustomProviderCatalogWritable();
		return action(file);
	});
	const tail = run.then(() => undefined, () => undefined);
	mutationTails.set(file, tail);
	try { return await run; }
	finally { if (mutationTails.get(file) === tail) mutationTails.delete(file); }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** models.json 里单个 provider 条目的形状（宽松：只读已知字段，保留其余）。 */
type ProviderEntry = Record<string, unknown>;

function providerEntriesOf(data: ModelsJson): Record<string, ProviderEntry> {
	const out: Record<string, ProviderEntry> = {};
	for (const [id, provider] of Object.entries(data.providers ?? {})) {
		if (isRecord(provider)) out[id] = { ...provider };
	}
	return out;
}

/**
 * 合并平台能力声明到 models.json 的 modelOverrides（pi 官方顶层覆盖层）。
 *
 * 只增补平台声明的字段，不删除用户在同一个模型上手写的其它 override；同一字段
 * 以平台声明为准（它们是对上游目录缺陷的纠正，不是可选项）。无变化时不写盘，
 * 避免每次冷启动都无谓改写共享目录并触发 runtime 重建。
 */
export async function applyThinkingCapabilityOverrides(
	overrides: Record<string, { supportsReasoningEffort?: boolean; thinkingLevelMap?: Record<string, string | null> }>,
): Promise<{ changed: number }> {
	if (Object.keys(overrides).length === 0) return { changed: 0 };
	return mutateModelsJson(async (file) => {
		const { data, raw } = await readModelsSnapshot(file);
		const providers = providerEntriesOf(data);
		let changed = 0;
		for (const [ref, entry] of Object.entries(overrides)) {
			const slash = ref.indexOf("/");
			if (slash <= 0 || slash === ref.length - 1) continue;
			const providerId = ref.slice(0, slash);
			const modelId = ref.slice(slash + 1);
			const provider = providers[providerId] ?? {};
			const existingOverrides = isRecord(provider.modelOverrides) ? { ...provider.modelOverrides } : {};
			const existing = isRecord(existingOverrides[modelId]) ? existingOverrides[modelId] as Record<string, unknown> : {};
			const existingCompat = isRecord(existing.compat) ? existing.compat : {};
			const existingMap = isRecord(existing.thinkingLevelMap) ? existing.thinkingLevelMap : {};
			// 幂等判定逐字段比较平台管理的键：existing 可能还带用户手写的 name /
			// maxTokensField 等，整体比较会让每次启动都误判为有变化。
			const unchanged =
				(entry.thinkingLevelMap === undefined || Object.entries(entry.thinkingLevelMap).every(([k, v]) => existingMap[k] === v))
				&& (entry.supportsReasoningEffort === undefined || existingCompat.supportsReasoningEffort === entry.supportsReasoningEffort);
			if (unchanged) continue;
			const patch: Record<string, unknown> = {};
			if (entry.thinkingLevelMap) patch.thinkingLevelMap = { ...existingMap, ...entry.thinkingLevelMap };
			if (entry.supportsReasoningEffort !== undefined) {
				patch.compat = { ...existingCompat, supportsReasoningEffort: entry.supportsReasoningEffort };
			}
			existingOverrides[modelId] = { ...existing, ...patch };
			providers[providerId] = { ...provider, modelOverrides: existingOverrides };
			changed += 1;
		}
		if (changed === 0) return { changed: 0 };
		await writeModelsJson({ ...data, providers }, file, raw);
		return { changed };
	});
}

/** 列出 models.json 里的自定义 provider（含每个的模型清单）。 */
export async function listCustomProvidersSnapshot(): Promise<{ providers: CustomProviderRecord[]; revision: string }> {
	const { data, revision } = await readModelsSnapshot();
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
					vision: Array.isArray(m.input) && m.input.includes("image"),
					...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
					...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
				})),
		});
	}
	return { providers: out.sort((a, b) => a.id.localeCompare(b.id)), revision };
}

export async function listCustomProviders(): Promise<CustomProviderRecord[]> {
	return (await listCustomProvidersSnapshot()).providers;
}

/**
 * 新增/覆盖一个自定义 provider（整体替换该 id 的 models.json 条目）。
 * 凭证不在此处：apiKey 由 /api/providers/:id/key 走 pi 凭证存储。
 */
export async function upsertCustomProvider(id: string, input: CustomProviderInput, expectedRevision?: string): Promise<CustomProviderRecord> {
	if (!ID_PATTERN.test(id)) throw new Error(`provider id「${id}」非法：小写字母/数字/连字符，字母开头`);
	if (!input.name?.trim()) throw new Error("provider name 必填");
	if (!input.baseUrl?.trim()) throw new Error("baseUrl 必填");
	if (!/^https?:\/\//.test(input.baseUrl.trim())) throw new Error("baseUrl 必须是 http(s) URL");
	if (!input.api?.trim()) throw new Error("api（调用协议）必填");
	if (!Array.isArray(input.models) || input.models.length === 0) throw new Error("至少登记一个模型");
	const seen = new Set<string>();
	for (const m of input.models) {
		if (!m.id?.trim()) throw new Error("模型 id 必填");
		if (m.vision !== undefined && typeof m.vision !== "boolean") throw new Error("模型图片能力必须为boolean");
		if (seen.has(m.id)) throw new Error(`模型 id 重复：${m.id}`);
		seen.add(m.id);
	}

	return mutateModelsJson(async (file) => {
		const { data, raw, revision } = await readModelsSnapshot(file);
		if (expectedRevision !== undefined && expectedRevision !== revision) throw new CustomProviderConflictError();
		const providers = providerEntriesOf(data);
		// 同 id 条目整体替换，但保留 models.json 支持、本表单未建模的字段
		// （modelOverrides 等）——否则一次自定义 Provider 编辑就会静默抹掉平台
		// 能力声明或用户手写的 per-model 覆盖。
		const previous = providers[id] ?? {};
		providers[id] = {
			...previous,
			name: input.name.trim(),
			baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
			api: input.api.trim(),
			models: input.models.map((m) => ({
				id: m.id.trim(),
				name: m.name?.trim() || m.id.trim(),
				reasoning: m.reasoning === true,
				input: m.vision === true ? ["text", "image"] : ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.contextWindow && m.contextWindow > 0 ? Math.floor(m.contextWindow) : 128_000,
				maxTokens: m.maxTokens && m.maxTokens > 0 ? Math.floor(m.maxTokens) : 8_192,
			})),
		};
		await writeModelsJson({ ...data, providers }, file, raw);
		return {
			id,
			name: input.name.trim(),
			baseUrl: input.baseUrl.trim().replace(/\/+$/, ""),
			api: input.api.trim(),
			models: input.models,
		};
	});
}

/** 删除自定义 provider 的目录条目；跨凭证文件的删除事务由 ProviderDeletionCoordinator 编排。 */
export async function deleteCustomProvider(id: string, expectedRevision?: string, beforeDelete?: () => Promise<void>, rollbackDelete?: () => Promise<void>): Promise<boolean> {
	return mutateModelsJson(async (file) => {
		const { data, raw, revision } = await readModelsSnapshot(file);
		if (expectedRevision !== undefined && expectedRevision !== revision) throw new CustomProviderConflictError();
		if (!data.providers || !(id in data.providers)) return false;
		const providers = { ...data.providers };
		delete providers[id];
		try {
			await beforeDelete?.();
			await writeModelsJson({ ...data, providers }, file, raw);
		} catch (error) {
			if (rollbackDelete && !(error instanceof CustomProviderDurabilityError)) {
				try { await rollbackDelete(); }
				catch (rollbackError) { throw new AggregateError([error, rollbackError], "Provider 删除失败且凭证回退失败；需人工核对目录与密钥"); }
			}
			throw error;
		}
		return true;
	});
}
