import type { FastifyInstance, FastifyReply } from "fastify";
import { ContactsError, ContactsProjection } from "../knowledge/contacts.js";
import { localViewerIdentity } from "./identity.js";
function fail(reply: FastifyReply, error: unknown) {
 const code = error instanceof Error && "code" in error ? String(error.code) : "context_unavailable";
 return reply.code(code === "not_found" ? 404 : code === "invalid_input" ? 400 : code === "revision_conflict" ? 409 : 503).send({ code, error: error instanceof Error ? error.message : "通讯录读取失败" });
}
function revision(value?: string) { if (value === undefined) return undefined; const n = Number(value); if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) throw new ContactsError("invalid_input", "资料版本无效"); return n; }
export function registerContactsRoutes(app: FastifyInstance, projection: ContactsProjection) {
 app.get<{ Querystring: { vault?: string; q?: string; group?: string; revision?: string } }>("/api/contacts/graph", async (req, reply) => {
  try {
   const view = await projection.load(localViewerIdentity().user.id, req.query.vault ?? "", revision(req.query.revision));
   const q = (req.query.q ?? "").trim().toLowerCase();
   if (q.length > 200) throw new ContactsError("invalid_input", "搜索参数无效");
   const filtered = view.people.filter(person => (!req.query.group || person.groups.includes(req.query.group)) && [person.name, person.company, person.role, ...person.topics].join(" ").toLowerCase().includes(q));
   filtered.sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
   const visible = filtered.slice(0, 300), ids = new Set(visible.map(person => person.id));
   return { vault: view.binding.id, revision: view.revision, total: view.people.length, matched: filtered.length, truncated: filtered.length > visible.length,
    groups: [...new Set(view.people.flatMap(person => person.groups))].sort(), warnings: view.warnings,
    people: visible.map(({ email: _email, phone: _phone, summary: _summary, relations: _relations, ...person }) => person),
    edges: view.graphEdges.filter(edge => ids.has(edge.from) && ids.has(edge.to)) };
  } catch (error) { return fail(reply, error); }
 });
 app.get<{ Querystring: { vault?: string; q?: string; group?: string; sort?: string } }>("/api/contacts", async (req, reply) => {
  try {
   const view = await projection.load(localViewerIdentity().user.id, req.query.vault ?? "");
   const q = (req.query.q ?? "").trim().toLowerCase();
   if (q.length > 200 || req.query.sort && !["recent", "name"].includes(req.query.sort)) throw new ContactsError("invalid_input", "搜索或排序参数无效");
   const filtered = view.people.filter(person => (!req.query.group || person.groups.includes(req.query.group)) && [person.name, person.company, person.role, ...person.topics].join(" ").toLowerCase().includes(q));
   filtered.sort((a, b) => (req.query.sort !== "name" ? (b.lastContact ? Date.parse(b.lastContact) : -Infinity) - (a.lastContact ? Date.parse(a.lastContact) : -Infinity) : 0) || a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
   return { vault: view.binding.id, revision: view.revision, total: view.people.length, matched: filtered.length, truncated: filtered.length > 1000,
    groups: [...new Set(view.people.flatMap(person => person.groups))].sort(), warnings: view.warnings,
    people: filtered.slice(0, 1000).map(({ email: _email, phone: _phone, summary: _summary, relations: _relations, ...person }) => person) };
  } catch (error) { return fail(reply, error); }
 });
 app.get<{ Params: { id: string }; Querystring: { vault?: string; revision?: string } }>("/api/contacts/:id", async (req, reply) => {
  try {
   const view = await projection.load(localViewerIdentity().user.id, req.query.vault ?? "", revision(req.query.revision));
   const person = view.people.find(person => person.id === req.params.id);
   if (!person) throw new ContactsError("not_found", "此人物已移除或不可访问");
   return { person, revision: view.revision };
  } catch (error) { return fail(reply, error); }
 });
 app.get<{ Params: { id: string }; Querystring: { vault?: string; path?: string; hash?: string } }>("/api/contacts/:id/source", async (req, reply) => {
  try { return { source: await projection.source(localViewerIdentity().user.id, req.query.vault ?? "", req.params.id, req.query.path ?? "", req.query.hash ?? "") }; }
  catch (error) { return fail(reply, error); }
 });
}
