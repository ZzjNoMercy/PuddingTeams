import type { FastifyInstance } from "fastify";
import {
	deleteCustomProvider,
	listCustomProviders,
	upsertCustomProvider,
	type CustomProviderInput,
} from "../pi-bridge/custom-providers.js";
import { resetSharedModelRuntime, sharedModelRuntime } from "../pi-bridge/model-runtime.js";
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

/** GET {baseUrl}/models 探针：OpenAI-compatible 没有通用健康检查端点。 */
async function probeModelsEndpoint(
	baseUrl: string,
	apiKey: string | undefined,
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
		return { ok: true, status: res.status, latencyMs, body: await res.text() };
	} catch (err) {
		return {
			ok: false,
			latencyMs: Date.now() - started,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export async function registerProvidersRoutes(app: FastifyInstance, store: PiSessionStore): Promise<void> {
	app.get("/api/providers/custom", async () => ({ providers: await listCustomProviders() }));

	app.put<{ Params: { id: string }; Body: Partial<CustomProviderInput> }>(
		"/api/providers/custom/:id",
		async (req, reply) => {
			try {
				const provider = await upsertCustomProvider(req.params.id, {
					name: req.body?.name ?? "",
					baseUrl: req.body?.baseUrl ?? "",
					api: req.body?.api ?? "",
					models: Array.isArray(req.body?.models) ? req.body.models : [],
				});
				resetSharedModelRuntime();
				return { provider };
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	);

	app.delete<{ Params: { id: string } }>("/api/providers/custom/:id", async (req, reply) => {
		// 先清凭证再删条目（顺序无关正确性，删条目后 getAuth 解析不到该 provider）。
		await store.removeProviderKey(req.params.id).catch(() => undefined);
		const deleted = await deleteCustomProvider(req.params.id);
		if (!deleted) return reply.code(404).send({ error: "自定义 provider 不存在" });
		resetSharedModelRuntime();
		return { ok: true };
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
		const probe = await probeModelsEndpoint(baseUrl, apiKey);
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
