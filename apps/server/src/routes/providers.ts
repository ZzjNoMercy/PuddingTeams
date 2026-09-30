import type { FastifyInstance } from "fastify";
import {
	CustomProviderConflictError,
	CustomProviderDurabilityError,
	CustomProviderFormatError,
	listCustomProvidersSnapshot,
	upsertCustomProvider,
	type CustomProviderInput,
} from "../pi-bridge/custom-providers.js";
import { resetSharedModelRuntime, sharedModelRuntime } from "../pi-bridge/model-runtime.js";
import { ProviderDeletionCoordinator, ProviderRecoveryRequiredError } from "../pi-bridge/provider-deletion.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";

/**
 * Provider 管理（借鉴 PuddingClaw：连通性测试用最低成本带鉴权探针
 * `GET {baseUrl}/models`，模型发现与测试是两个显式动作；写操作后重建
 * 共享 ModelRuntime，让自定义 provider/模型立即进入目录）。
 */

interface ProbeBody {
	baseUrl?: string;
	/** 显式 key 优先（可测未保存的新 key）；否则用 providerId 已存凭证。 */
	apiKey?: string;
	providerId?: string;
}

async function resolveApiKey(body: ProbeBody): Promise<string | undefined> {
	if (body.apiKey?.trim()) return body.apiKey.trim();
	if (body.providerId?.trim()) {
		try {
			const rt = await sharedModelRuntime();
			const auth = await rt.getAuth(body.providerId.trim());
			return auth?.auth.apiKey;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function probeUrl(baseUrl: string): string {
	return `${baseUrl.trim().replace(/\/+$/, "")}/models`;
}

const MAX_DISCOVERY_RESPONSE_BYTES = 1_048_576;

async function readDiscoveryBody(response: Response): Promise<string> {
	const size = Number(response.headers.get("content-length"));
	if (Number.isFinite(size) && size > MAX_DISCOVERY_RESPONSE_BYTES) {
		await response.body?.cancel();
		throw new Error("模型发现响应过大（超过 1 MiB）");
	}
	if (!response.body) throw new Error("模型发现响应没有正文");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_DISCOVERY_RESPONSE_BYTES) {
				await reader.cancel();
				throw new Error("模型发现响应过大（超过 1 MiB）");
			}
			chunks.push(value);
		}
	} finally { reader.releaseLock(); }
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return new TextDecoder().decode(bytes);
}

/** GET {baseUrl}/models 探针：OpenAI-compatible 没有通用健康检查端点。 */
async function probeModelsEndpoint(
	baseUrl: string,
	apiKey: string | undefined,
	includeBody = false,
): Promise<{ ok: boolean; status?: number; latencyMs: number; error?: string; body?: string }> {
	if (!/^https?:\/\//.test(baseUrl.trim())) {
		return { ok: false, latencyMs: 0, error: "baseUrl 必须是 http(s) URL" };
	}
	const started = Date.now();
	try {
		const res = await fetch(probeUrl(baseUrl), {
			headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
			signal: AbortSignal.timeout(10_000),
		});
		const latencyMs = Date.now() - started;
		if (res.status === 401 || res.status === 403) {
			return { ok: false, status: res.status, latencyMs, error: "鉴权失败（401/403）：API key 无效或权限不足" };
		}
		if (!res.ok) {
			return { ok: false, status: res.status, latencyMs, error: `HTTP ${res.status}` };
		}
		if (!includeBody) {
			void res.body?.cancel().catch(() => undefined);
			return { ok: true, status: res.status, latencyMs };
		}
		return { ok: true, status: res.status, latencyMs, body: await readDiscoveryBody(res) };
	} catch (err) {
		return {
			ok: false,
			latencyMs: Date.now() - started,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function registerProvidersRoutes(app: FastifyInstance, store: PiSessionStore, deletion: ProviderDeletionCoordinator): Promise<void> {
	const recovered = await deletion.recover();
	if (recovered !== "none") { resetSharedModelRuntime(); store.markAllDirty(); }
	app.get("/api/providers/custom", async (_req, reply) => {
		try { return await listCustomProvidersSnapshot(); }
		catch (error) {
			if (error instanceof CustomProviderFormatError) return reply.code(422).send({ error: error.message, code: "provider_catalog_invalid" });
			throw error;
		}
	});

	app.put<{ Params: { id: string }; Body: Partial<CustomProviderInput> & { expectedRevision?: string } }>(
		"/api/providers/custom/:id",
		async (req, reply) => {
			if (!/^[a-f0-9]{64}$/.test(req.body?.expectedRevision ?? "")) return reply.code(400).send({ error: "保存 Provider 需要目录 expectedRevision" });
			try {
				const provider = await deletion.withMutation(() => upsertCustomProvider(req.params.id, {
					name: req.body?.name ?? "",
					baseUrl: req.body?.baseUrl ?? "",
					api: req.body?.api ?? "",
					models: Array.isArray(req.body?.models) ? req.body.models : [],
				}, req.body.expectedRevision));
				resetSharedModelRuntime();
				store.markAllDirty();
				return { provider };
			} catch (err) {
				if (err instanceof ProviderRecoveryRequiredError) return reply.code(503).send({ error: err.message, code: "provider_recovery_required" });
				if (err instanceof CustomProviderDurabilityError) return reply.code(503).send({ error: err.message, code: "provider_write_uncertain" });
				if (err instanceof CustomProviderFormatError) return reply.code(422).send({ error: err.message, code: "provider_catalog_invalid" });
				if (err instanceof CustomProviderConflictError) return reply.code(409).send({ error: err.message, code: "provider_conflict" });
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	);

	app.delete<{ Params: { id: string } }>("/api/providers/custom/:id", async (req, reply) => {
		try {
			const snapshot = await listCustomProvidersSnapshot();
			if (!snapshot.providers.some((provider) => provider.id === req.params.id)) {
				return reply.code(404).send({ error: "自定义 provider 不存在" });
			}
			const expectedRevision = req.headers["x-expected-revision"];
			if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(expectedRevision)) return reply.code(400).send({ error: "删除 Provider 需要目录 x-expected-revision" });
			if (expectedRevision !== snapshot.revision) return reply.code(409).send({ error: "自定义 Provider 目录已变化，请刷新后重试", code: "provider_conflict" });
			// 先撤销凭证再删目录；撤销失败时不能让目录删除看似成功。
			const outcome = await deletion.withMutation(() => deletion.delete(req.params.id, expectedRevision));
			if (!outcome.deleted) return reply.code(404).send({ error: "自定义 provider 不存在" });
			resetSharedModelRuntime();
			store.markAllDirty();
			return outcome.recoveryPending ? reply.code(202).send({ ok: true, recovery: "pending" }) : { ok: true };
		} catch (err) {
			if (err instanceof ProviderRecoveryRequiredError) return reply.code(503).send({ error: err.message, code: "provider_recovery_required" });
			if (err instanceof CustomProviderDurabilityError) return reply.code(503).send({ error: err.message, code: "provider_write_uncertain" });
			if (err instanceof CustomProviderFormatError) return reply.code(422).send({ error: err.message, code: "provider_catalog_invalid" });
			if (err instanceof CustomProviderConflictError) return reply.code(409).send({ error: err.message, code: "provider_conflict" });
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	/** 连通性测试：响应体直接丢弃，只要鉴权通过 + 状态码。 */
	app.post<{ Body: ProbeBody }>("/api/providers/test", async (req, reply) => {
		const baseUrl = req.body?.baseUrl ?? "";
		if (!baseUrl.trim()) return reply.code(400).send({ error: "baseUrl 必填" });
		const apiKey = await resolveApiKey(req.body ?? {});
		const { body: _discarded, ...result } = await probeModelsEndpoint(baseUrl, apiKey);
		return result;
	});

	/** 模型发现：拉 GET /models 的 id 清单，由用户挑选后随 provider 一并登记。 */
	app.post<{ Body: ProbeBody }>("/api/providers/discover", async (req, reply) => {
		const baseUrl = req.body?.baseUrl ?? "";
		if (!baseUrl.trim()) return reply.code(400).send({ error: "baseUrl 必填" });
		const apiKey = await resolveApiKey(req.body ?? {});
		const probe = await probeModelsEndpoint(baseUrl, apiKey, true);
		if (!probe.ok) return { ok: false, error: probe.error, status: probe.status, models: [] };
		try {
			const parsed = JSON.parse(probe.body ?? "{}") as { data?: Array<{ id?: string; name?: string }> };
			const models = (parsed.data ?? [])
				.filter((m) => typeof m?.id === "string" && m.id.length > 0)
				.map((m) => ({ id: m.id as string, name: typeof m.name === "string" ? m.name : undefined }))
				.sort((a, b) => a.id.localeCompare(b.id));
			return { ok: true, latencyMs: probe.latencyMs, models };
		} catch {
			return { ok: false, error: "响应不是 OpenAI /models 格式", models: [] };
		}
	});
}
