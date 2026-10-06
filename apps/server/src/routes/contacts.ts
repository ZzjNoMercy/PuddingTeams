import type { FastifyInstance, FastifyReply } from "fastify";
import { ContactsError, ContactsProjection } from "../knowledge/contacts.js";
import { localViewerIdentity } from "./identity.js";
import { listContactAvatarOptions, readContactAvatarOption } from "../contact-avatar-defaults.js";
function fail(reply: FastifyReply, error: unknown) {
 const code = error instanceof Error && "code" in error ? String(error.code) : "context_unavailable";
 return reply.code(code === "not_found" ? 404 : ["invalid_input", "invalid_path"].includes(code) ? 400 : code === "too_large" ? 413 : ["revision_conflict", "baseline_conflict"].includes(code) ? 409 : 503).send({ code, error: error instanceof Error ? error.message : "通讯录读取失败" });
}
function revision(value?: string) { if (value === undefined) return undefined; const n = Number(value); if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) throw new ContactsError("invalid_input", "资料版本无效"); return n; }
export function registerContactsRoutes(app: FastifyInstance, projection: ContactsProjection) {
 app.get("/api/contacts/avatar-options", async (_req, reply) => {
  try { return { options: await listContactAvatarOptions() }; } catch (error) { return fail(reply, error); }
 });
 app.get<{ Params: { id: string } }>("/api/contacts/avatar-options/:id/image", async (req, reply) => {
  try {
   const image = await readContactAvatarOption(req.params.id);
   return reply.header("Content-Type", "image/png").header("X-Content-Type-Options", "nosniff").header("Cache-Control", "public, max-age=86400").header("ETag", `"${image.hash}"`).send(image.bytes);
  } catch (error) { return fail(reply, error); }
 });
 app.put<{ Params: { id: string }; Querystring: { vault?: string }; Body: { expectedHash: string; image: string | null } | { expectedHash: string; builtinId: string } }>("/api/contacts/:id/avatar", { bodyLimit: 3 * 1024 * 1024 }, async (req, reply) => {
  try {
   const body = req.body;
   if (!body || typeof body.expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedHash) ||
    ("builtinId" in body ? typeof body.builtinId !== "string" || "image" in body : !("image" in body) || body.image !== null && typeof body.image !== "string")) throw new ContactsError("invalid_input", "请选择内置头像、上传图片或恢复姓名头像");
   return await projection.setAvatar(localViewerIdentity().user.id, req.query.vault ?? "", req.params.id, req.body);
  } catch (error) { return fail(reply, error); }
 });
 app.get<{ Querystring: { vault?: string; q?: string; group?: string; revision?: string } }>("/api/contacts/graph", async (req, reply) => {
  try {
   const view = await projection.load(localViewerIdentity().user.id, req.query.vault ?? "", revision(req.query.revision));
   const q = (req.query.q ?? "").trim().toLowerCase();
   if (q.length > 200) throw new ContactsError("invalid_input", "搜索参数无效");
   const filtered = view.people.filter(person => (!req.query.group || person.groups.includes(req.query.group)) && [person.name, person.company, person.role, ...person.topics].join(" ").toLowerCase().includes(q));
   filtered.sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
   const visible = filtered.slice(0, 300), ids = new Set([...visible.map(person => person.id), view.self.id]);
   return { vault: view.binding.id, revision: view.revision, total: view.people.length, matched: filtered.length, truncated: filtered.length > visible.length,
    groups: [...new Set(view.people.flatMap(person => person.groups))].sort(), warnings: view.warnings,
    people: visible.map(({ email: _email, phone: _phone, summary: _summary, relations: _relations, ...person }) => person),
    self: { id: view.self.id }, edges: view.graphEdges.filter(edge => ids.has(edge.from) && ids.has(edge.to)) };
  } catch (error) { return fail(reply, error); }
 });
 app.get<{ Params: { id: string }; Querystring: { vault?: string; revision?: string; status?: string; offset?: string } }>("/api/contacts/graph/edges/:id", async (req, reply) => {
  try {
   const expected = revision(req.query.revision);
   if (expected === undefined) throw new ContactsError("invalid_input", "请先刷新图谱");
   const view = await projection.load(localViewerIdentity().user.id, req.query.vault ?? "", expected);
   const evidence = view.graphEvidence.get(req.params.id);
   if (!evidence || !view.graphEdges.some(edge => edge.id === req.params.id)) throw new ContactsError("not_found", "此连线已移除，请刷新图谱");
   const status = req.query.status ?? "all";
   if (!["all", "done", "planned", "cancelled", "unknown"].includes(status)) throw new ContactsError("invalid_input", "往来筛选无效");
   const offset = revision(req.query.offset) ?? 0;
   const items = evidence.interactions.filter(item => status === "all" || item.status === status);
   if (offset > items.length) throw new ContactsError("invalid_input", "往来页码无效");
   const page = items.slice(offset, offset + 20);
   await view.assertCurrent();
   return { revision: view.revision, edge: evidence.edge, relations: evidence.relations, interactions: page, total: items.length, nextOffset: offset + page.length < items.length ? offset + page.length : null };
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
