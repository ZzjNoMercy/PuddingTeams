import type { FastifyInstance, FastifyReply } from "fastify";
import { CalendarError, CalendarStore } from "../calendar/store.js";
import { localViewerIdentity } from "./identity.js";
import type { CalendarService } from "../calendar/service.js";

function failure(reply: FastifyReply, error: unknown) {
	if (error instanceof CalendarError) return reply.code(error.code === "not_found" ? 404 : error.code === "invalid_input" ? 400 : 409).send({ error: error.message, code: error.code });
	if (error instanceof Error && "code" in error && ["not_found", "invalid_input", "revision_conflict", "root_changed", "context_unavailable"].includes(String(error.code))) return reply.code(error.code === "not_found" ? 404 : error.code === "invalid_input" ? 400 : error.code === "revision_conflict" ? 409 : 503).send({ error: error.message, code: error.code });
	return reply.code(500).send({ error: "日历暂不可用，请重试", code: "calendar_unavailable" });
}
export function registerCalendarRoutes(app: FastifyInstance, store: CalendarStore, ownerId = () => localViewerIdentity().user.id, service?: CalendarService): void {
	app.get("/api/calendar/sources", async () => ({ sources: [{ id: "platform", name: "平台日历", writable: true }], reminders: false }));
	app.get("/api/calendar/events", async (_req, reply) => { try { return { events: await (service ?? store).list(ownerId()) }; } catch (error) { return failure(reply, error); } });
	app.get<{ Params: { id: string } }>("/api/calendar/events/:id", async (req, reply) => { try { return { event: await (service ?? store).get(ownerId(), req.params.id) }; } catch (error) { return failure(reply, error); } });
	if (service) {
		app.get<{ Querystring: { q?: string; vault?: string } }>("/api/calendar/people", async (req, reply) => { try { return await service.people(ownerId(), req.query.q ?? "", req.query.vault); } catch (error) { return failure(reply, error); } });
		app.post<{ Params: { id: string } }>("/api/calendar/events/:id/interaction/retry", async (req, reply) => { try { return { event: await service.retry(ownerId(), req.params.id) }; } catch (error) { return failure(reply, error); } });
		app.post<{ Params: { id: string }; Body: { status?: unknown; operationId?: unknown; expectedRevision?: unknown } }>("/api/calendar/events/:id/status", async (req, reply) => {
			try {
				const status = req.body?.status;
				if (status !== "confirmed" && status !== "done" && status !== "cancelled") throw new CalendarError("invalid_input", "日程状态无效，须为 confirmed/done/cancelled");
				return { event: await service.setStatus(ownerId(), req.params.id, req.body?.operationId, req.body?.expectedRevision, status) };
			} catch (error) { return failure(reply, error); }
		});
	}
	for (const action of ["create", "update", "cancel"] as const) {
		app.route<{ Params: { id?: string }; Body: { operationId?: unknown; expectedRevision?: unknown; event?: unknown } }>({
			method: action === "create" ? "POST" : action === "update" ? "PUT" : "DELETE",
			url: action === "create" ? "/api/calendar/events" : "/api/calendar/events/:id",
			handler: async (req, reply) => {
				try { const event = await (service ?? store).mutate(ownerId(), action, req.params.id, req.body?.operationId, req.body?.expectedRevision, req.body?.event); return { event }; }
				catch (error) { return failure(reply, error); }
			},
		});
	}
}
