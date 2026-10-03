import type { FastifyInstance, FastifyReply } from "fastify";
import { CalendarProviderError, CalendarProviderRegistry } from "../calendar/providers.js";

function failure(reply: FastifyReply, error: unknown) {
	const known = error instanceof CalendarProviderError;
	const code = known ? error.code : "unavailable";
	return reply.code(code === "not_found" ? 404 : code === "invalid_input" ? 400 : code === "not_configured" || code === "authorization_required" ? 401 : code === "permission_required" ? 403 : 502).send({ code, error: known ? error.message : "日历来源暂不可用，请重试" });
}
export function registerCalendarProviderRoutes(app: FastifyInstance, registry: CalendarProviderRegistry) {
	app.addHook("onRequest", async (req, reply) => { if (req.url.startsWith("/api/calendar/providers")) reply.header("Cache-Control", "no-store"); });
	app.get("/api/calendar/providers", async () => ({ providers: registry.list() }));
	type Params = { providerId: string };
	const base = "/api/calendar/providers/:providerId";
	app.get<{ Params: Params }>(`${base}/calendars`, async (req, reply) => { try { return { calendars: await registry.get(req.params.providerId).calendars() }; } catch (e) { return failure(reply, e); } });
	app.get<{ Params: Params; Querystring: { calendarId?: string; start?: string; end?: string } }>(`${base}/events`, async (req, reply) => {
		try {
			const provider = registry.get(req.params.providerId);
			const events = await provider.events(req.query.calendarId ?? "", req.query.start ?? "", req.query.end ?? "");
			return { events: events.map(event => ({ ...event, id: `${provider.descriptor.id}:${encodeURIComponent(event.id)}`, sourceId: `${provider.descriptor.id}:${encodeURIComponent(req.query.calendarId ?? "")}`, providerId: provider.descriptor.id, providerName: provider.descriptor.name, color: provider.descriptor.color, readonly: true })) };
		} catch (e) { return failure(reply, e); }
	});
	const authorization = (id: string) => {
		const auth = registry.get(id).authorization;
		if (!auth) throw new CalendarProviderError("not_found", "此来源不提供用户授权入口");
		return auth;
	};
	// Explicit user action; provider adapters retain their own shared authority.
	app.post<{ Params: Params }>(`${base}/authorizations`, async (req, reply) => {
		try { return { session: await authorization(req.params.providerId).begin() }; } catch (e) { return failure(reply, e); }
	});
	app.get<{ Params: Params & { id: string } }>(`${base}/authorizations/:id`, async (req, reply) => {
		try {
			const session = await authorization(req.params.providerId).status(req.params.id);
			return session ? { session } : reply.code(404).send({ error: "授权入口已过期，请重新发起" });
		} catch (e) { return failure(reply, e); }
	});
	app.delete<{ Params: Params & { id: string } }>(`${base}/authorizations/:id`, async (req, reply) => {
		try { await authorization(req.params.providerId).cancel(req.params.id); return reply.code(204).send(); } catch (e) { return failure(reply, e); }
	});
}
