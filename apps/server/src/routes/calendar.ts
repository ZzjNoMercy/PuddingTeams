import type { FastifyInstance, FastifyReply } from "fastify";
import { CalendarError, CalendarStore } from "../calendar/store.js";
import { localViewerIdentity } from "./identity.js";

function failure(reply: FastifyReply, error: unknown) {
	if (error instanceof CalendarError) return reply.code(error.code === "not_found" ? 404 : error.code === "invalid_input" ? 400 : 409).send({ error: error.message, code: error.code });
	return reply.code(500).send({ error: "日历暂不可用，请重试", code: "calendar_unavailable" });
}
export function registerCalendarRoutes(app: FastifyInstance, store: CalendarStore, ownerId = () => localViewerIdentity().user.id): void {
	app.get("/api/calendar/sources", async () => ({ sources: [{ id: "platform", name: "平台日历", writable: true }], reminders: false }));
	app.get("/api/calendar/events", async (_req, reply) => { try { return { events: await store.list(ownerId()) }; } catch (error) { return failure(reply, error); } });
	app.get<{ Params: { id: string } }>("/api/calendar/events/:id", async (req, reply) => { try { return { event: await store.get(ownerId(), req.params.id) }; } catch (error) { return failure(reply, error); } });
	for (const action of ["create", "update", "cancel"] as const) {
		app.route<{ Params: { id?: string }; Body: { operationId?: unknown; expectedRevision?: unknown; event?: unknown } }>({
			method: action === "create" ? "POST" : action === "update" ? "PUT" : "DELETE",
			url: action === "create" ? "/api/calendar/events" : "/api/calendar/events/:id",
			handler: async (req, reply) => {
				try { const event = await store.mutate(ownerId(), action, req.params.id, req.body?.operationId, req.body?.expectedRevision, req.body?.event); return { event }; }
				catch (error) { return failure(reply, error); }
			},
		});
	}
}
