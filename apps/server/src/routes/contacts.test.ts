import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, mkdir, writeFile, rm, rename, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import { KnowledgeAcceptanceStore } from "../knowledge/acceptance.js";
import { KnowledgeObjectStore } from "../knowledge/objects.js";
import { KnowledgeObservationService } from "../knowledge/observation.js";
import { KnowledgeSearchIndex } from "../knowledge/search-index.js";
import { ContactsProjection } from "../knowledge/contacts.js";
import { copySchemaPreset } from "../knowledge/schema-presets.js";
import { registerContactsRoutes } from "./contacts.js";
import { localViewerIdentity } from "./identity.js";
async function fixture(files: Record<string, string>) {
 const base = await mkdtemp(path.join(tmpdir(), "pt-contacts-")), root = path.join(base, "people");
 await mkdir(root); await writeFile(path.join(root, "wiki.schema.json"), JSON.stringify(copySchemaPreset("people")));
 for (const [relative, content] of Object.entries(files)) { const file = path.join(root, relative); await mkdir(path.dirname(file), {recursive:true}); await writeFile(file,content); }
 const bindings = new KnowledgeBindingRegistry(path.join(base,"state")), objects = new KnowledgeObjectStore(path.join(base,"objects")), acceptance = new KnowledgeAcceptanceStore(path.join(base,"accepted"));
 const observation = new KnowledgeObservationService(acceptance, {objects}), searchIndex = new KnowledgeSearchIndex(path.join(base,"cache"),objects);
 const binding = await bindings.create({ownerId:localViewerIdentity().user.id,name:"人脉",description:"隔离夹具",rootPath:root});
 const app = Fastify(); registerContactsRoutes(app,new ContactsProjection({bindings,objects,acceptance,observation,searchIndex}));
 return {base,root,app,binding,bindings,objects};
}
const note = (fields: string, body = "") => `---\n${fields}\n---\n${body}\n`;
test("人脉图谱只投影人物间明确链接，保留同名身份与来源，不推断共同机构/项目/往来", async () => {
 const f = await fixture({
  "People/a.md":note("id: a\ntype: person\ntitle: 同名\norg: 共同机构\nemail: private@example.com\nphone: '123'", "- introduced_by: [[People/b|介绍人]]\n- introduced_by: [[People/b]]\n普通引用 [[People/a]]\n[[Projects/shared]]\n[[unknown]]\n[[duplicate]]\n```md\n[[People/c]]\n```\n`[[People/c]]`"),
  "People/b.md":note("id: b\ntype: person\ntitle: 同名\norg: 共同机构", "[[People/a]]\n[项目](../Projects/shared.md)"),
  "People/c.md":note("id: c\ntype: person\ntitle: 未连接的人\norg: 共同机构", "[[Projects/shared]]"),
  "Orgs/shared.md":note("type: org\ntitle: 共同机构"),
  "Affiliations/a.md":note("type: affiliation\ntitle: 同名甲的任职\nrole: 研究员\nstatus: current", "- held_by: [[People/a]]\n- at_org: [[Orgs/shared]]"),
  "Affiliations/b.md":note("type: affiliation\ntitle: 同名乙的任职\nrole: 研究员\nstatus: current", "- held_by: [[People/b]]\n- at_org: [[Orgs/shared]]"),
  "Affiliations/c.md":note("type: affiliation\ntitle: 未连接人物的任职\nrole: 研究员\nstatus: current", "- held_by: [[People/c]]\n- at_org: [[Orgs/shared]]"),
  "People/duplicate.md":note("id: d\ntype: person\ntitle: 重名路径"),
  "Records/duplicate.md":note("type: record\ntitle: 另一同名路径"),
  "Projects/shared.md":note("type: project\ntitle: 共同项目", "[[People/a]] [[People/b]] [[People/c]]"),
  "Interactions/shared.md":note("type: interaction\ntitle: 共同往来\nstatus: done\noccurredAt: 2026-01-01T09:00:00Z", "- involves: [[People/a]] [[People/c]]"),
 });
 try {
  const response = await f.app.inject(`/api/contacts/graph?vault=${f.binding.id}`); assert.equal(response.statusCode,200);
  const graph = response.json(); assert.equal(graph.total,4); assert.equal(graph.edges.length,2); assert.equal(graph.people.filter((p:{name:string}) => p.name === "同名").length,2);
  assert.equal(graph.people.filter((p:{company:string}) => p.company === "共同机构").length,3);
  assert(!JSON.stringify(graph).includes("private@example.com")); assert(!graph.people.some((p:{phone?:string}) => p.phone));
  const a = graph.people.find((p:{source:{path:string}}) => p.source.path === "People/a.md"), b = graph.people.find((p:{source:{path:string}}) => p.source.path === "People/b.md");
  const introduction = graph.edges.find((e:{kind:string}) => e.kind === "introduced_by"); assert.equal(introduction.from,a.id); assert.equal(introduction.to,b.id); assert.equal(introduction.source.contentHash,a.source.contentHash); assert.match(introduction.snippet,/介绍人/);
  const backlink = graph.edges.find((e:{kind:string}) => e.kind === "mentions"); assert.equal(backlink.from,b.id); assert.equal(backlink.to,a.id); assert.equal(backlink.label,"人物链接");
  const filtered = (await f.app.inject(`/api/contacts/graph?${new URLSearchParams({vault:f.binding.id,q:"未连接的人"})}`)).json(); assert.equal(filtered.people.length,1); assert.deepEqual(filtered.edges,[]);
  assert.equal((await f.app.inject(`/api/contacts/graph?vault=${f.binding.id}&revision=bad`)).statusCode,400);
  await rm(path.join(f.root,"People/b.md"));
  assert.equal((await f.app.inject(`/api/contacts/graph?vault=${f.binding.id}&revision=${graph.revision}`)).statusCode,409);
  assert.equal((await f.app.inject(`/api/contacts/graph?vault=${f.binding.id}`)).json().edges.length,0);
  await f.bindings.revoke(localViewerIdentity().user.id,f.binding.id,f.binding.bindingRevision);
  assert.equal((await f.app.inject(`/api/contacts/graph?vault=${f.binding.id}`)).statusCode,404);
 } finally { await f.app.close(); await rm(f.base,{recursive:true,force:true}); }
});
test("图谱截断明确报告真实匹配数，不返回未显示节点的边；不同库身份隔离", async () => {
 const files: Record<string,string> = {};
 for (let i=0;i<301;i++) files[`People/p${i}.md`] = note(`id: p${i}\ntype: person\ntitle: P${String(i).padStart(3,"0")}`,i === 0 ? "[[People/p300]]" : "");
 const f = await fixture(files);
 try {
  const graph=(await f.app.inject(`/api/contacts/graph?vault=${f.binding.id}`)).json(); assert.equal(graph.total,301); assert.equal(graph.matched,301); assert.equal(graph.people.length,300); assert.equal(graph.truncated,true); assert.deepEqual(graph.edges,[]);
  const root2=path.join(f.base,"other"); await mkdir(root2); await writeFile(path.join(root2,"p0.md"),files["People/p0.md"]!);
  const other=await f.bindings.create({ownerId:localViewerIdentity().user.id,name:"另一库",description:"隔离",rootPath:root2});
  const isolated=(await f.app.inject(`/api/contacts/graph?vault=${other.id}`)).json(); assert.equal(isolated.people.length,1); assert.notEqual(isolated.people[0].id,graph.people[0].id); assert.deepEqual(isolated.edges,[]);
 } finally { await f.app.close(); await rm(f.base,{recursive:true,force:true}); }
});
test("初始化但没有人物的 Wiki 返回真实空态；未声明 person 不自动推断", async () => {
 const f = await fixture({"index.md":"# 人脉\n", "draft.md":"# 王甲\n公司：示例"});
 try { const response = await f.app.inject(`/api/contacts?vault=${f.binding.id}`); assert.equal(response.statusCode,200); assert.deepEqual(response.json().people,[]); assert.equal(response.json().total,0); assert.equal((await f.app.inject("/api/contacts")).statusCode,400); assert.equal((await f.app.inject({method:"POST",url:"/api/contacts",payload:{name:"不能直接写人物"}})).statusCode,404); }
 finally { await f.app.close(); await rm(f.base,{recursive:true,force:true}); }
});
test("通讯录保留同名人物；完成且有日期才算往来，普通反链/计划/动态不推算最近联系", async () => {
 const f = await fixture({
  "People/a.md":note("id: a\ntype: person\ntitle: 同名人物\nphone: '00123'\nupdated: 2099-01-01\ntags: [研究]", "人物简介。\n\n- belongs_to: [[Groups/g]]\n- shares: [[Topics/t]]"),
  "People/b.md":note("id: b\ntype: person\ntitle: 同名人物"),
  "Orgs/a.md":note("id: org-a\ntype: org\ntitle: 第一机构"),
  "Orgs/b.md":note("id: org-b\ntype: org\ntitle: 第二机构"),
  "Affiliations/a.md":note("id: aff-a\ntype: affiliation\ntitle: 第一机构任职", "- held_by: [[People/a]]\n- at_org: [[Orgs/a]]"),
  "Affiliations/b.md":note("id: aff-b\ntype: affiliation\ntitle: 第二机构任职", "- held_by: [[People/b]]\n- at_org: [[Orgs/b]]"),
  "Groups/g.md":note("type: group\ntitle: 行业圈层"), "Topics/t.md":note("type: topic\ntitle: 共同话题"),
  "Interactions/done.md":note("id: interaction-1\ntype: interaction\ntitle: 已发生往来\nstatus: done\noccurredAt: 2026-01-02T09:00:00+08:00", "- involves: [[People/a]] 与 [[People/a|重复引用]]"),
  "Interactions/planned.md":note("type: interaction\ntitle: 安排会面\nstatus: planned\noccurredAt: 2099-01-01T09:00:00Z", "- involves: [[People/a]]"),
  "Interactions/unknown.md":note("type: interaction\ntitle: 无完成状态\noccurredAt: 2026-02-02T09:00:00Z", "- involves: [[People/a]]"),
  "Interactions/code.md":note("type: interaction\ntitle: 代码示例\nstatus: done\noccurredAt: 2026-03-02T09:00:00Z", "```md\n- involves: [[People/a]]\n```\n`involves: [[People/a]]`"),
  "Records/mention.md":note("type: record\ntitle: 别人转述\ncapturedAt: 2026-02-03", "提及 [[People/a]]"),
  "meeting.md":note("type: meeting\ntitle: 明确参会\nstatus: done\noccurredAt: 2026-01-03T09:00:00Z\nparticipants:\n  - '[[People/a]]'"),
 });
 try {
  const list = (await f.app.inject(`/api/contacts?vault=${f.binding.id}`)).json(); assert.equal(list.total,2); assert.notEqual(list.people[0].id,list.people[1].id);
  const person = list.people.find((item:{company:string})=>item.company==="第一机构"); assert.equal(person.role,"第一机构：身份未记录（状态未记录）"); assert.equal(person.lastContact,"2026-01-03T09:00:00Z"); assert.deepEqual(person.groups,["行业圈层"]); assert.deepEqual(person.topics,["研究","共同话题"]);
  const detail = (await f.app.inject(`/api/contacts/${person.id}?vault=${f.binding.id}&revision=${list.revision}`)).json().person; assert.equal(detail.phone,"00123");
  assert.equal(detail.relations.filter((item:{occurredAt:string|null})=>item.occurredAt).length,2); assert(!detail.relations.some((item:{source:{title:string}})=>item.source.title==="代码示例"));
  assert.equal(detail.relations.find((item:{source:{title:string}})=>item.source.title==="别人转述").label,"被提及");
  assert.equal(detail.relations.find((item:{source:{title:string}})=>item.source.title==="安排会面").label,"计划往来");
  const filtered = (await f.app.inject(`/api/contacts?vault=${f.binding.id}&q=${encodeURIComponent("第一机构")}&group=${encodeURIComponent("行业圈层")}`)).json(); assert.equal(filtered.people.length,1);
  const source = await f.app.inject(`/api/contacts/${person.id}/source?${new URLSearchParams({vault:f.binding.id,path:person.source.path,hash:person.source.contentHash})}`); assert.equal(source.statusCode,200); assert.match(source.json().source.content,/phone: '00123'/);
 } finally { await f.app.close(); await rm(f.base,{recursive:true,force:true}); }
});
test("同步修改/rename 保持人物身份；旧来源拒绝，删除与撤权清除列表/详情/关系", async () => {
 const f = await fixture({"People/a.md":note("id: a\ntype: person\ntitle: 原姓名"),"related.md":note("type: record\ntitle: 资料","提及 [[People/a]]")});
 try {
  const first = (await f.app.inject(`/api/contacts?vault=${f.binding.id}`)).json(), person=first.people[0];
  await rename(path.join(f.root,"People/a.md"),path.join(f.root,"People/moved.md"));
  await writeFile(path.join(f.root,"People/moved.md"),note("id: a\ntype: person\ntitle: 修改后姓名"));
  const next = (await f.app.inject(`/api/contacts?vault=${f.binding.id}`)).json(); assert.equal(next.people[0].id,person.id); assert.equal(next.people[0].name,"修改后姓名");
  assert.equal((await f.app.inject(`/api/contacts/${person.id}?vault=${f.binding.id}&revision=${first.revision}`)).statusCode,409);
  assert.equal((await f.app.inject(`/api/contacts/${person.id}/source?${new URLSearchParams({vault:f.binding.id,path:person.source.path,hash:person.source.contentHash})}`)).statusCode,409);
  await rm(path.join(f.root,"People/moved.md")); assert.equal((await f.app.inject(`/api/contacts?vault=${f.binding.id}`)).json().total,0); assert.equal((await f.app.inject(`/api/contacts/${person.id}?vault=${f.binding.id}`)).statusCode,404);
  await f.bindings.revoke(localViewerIdentity().user.id,f.binding.id,f.binding.bindingRevision); assert.equal((await f.app.inject(`/api/contacts?vault=${f.binding.id}`)).statusCode,404);
  assert.equal(await readFile(path.join(f.root,"related.md"),"utf8"),note("type: record\ntitle: 资料","提及 [[People/a]]"));
 } finally { await f.app.close(); await rm(f.base,{recursive:true,force:true}); }
});
test("同名不同库不能串读；篡改快照不降级为空态", async () => {
 const f = await fixture({"a.md":note("id: a\ntype: person\ntitle: 王甲")});
 try {
  const first = (await f.app.inject(`/api/contacts?vault=${f.binding.id}`)).json(), person=first.people[0];
  const root2 = path.join(f.base,"other"); await mkdir(root2); await writeFile(path.join(root2,"a.md"),note("id: a\ntype: person\ntitle: 王甲"));
  const binding2=await f.bindings.create({ownerId:localViewerIdentity().user.id,name:"另一库",description:"独立人物",rootPath:root2});
  assert.equal((await f.app.inject(`/api/contacts/${person.id}?vault=${binding2.id}`)).statusCode,404);
  await writeFile(path.join(f.base,"objects",person.source.contentHash.slice(0,2),`${person.source.contentHash}.md`),"损坏快照");
  const error = await f.app.inject(`/api/contacts?vault=${f.binding.id}`); assert.equal(error.statusCode,503); assert.equal(error.json().people,undefined);
 } finally { await f.app.close(); await rm(f.base,{recursive:true,force:true}); }
});

test("公司共享、多公司任职保留身份对应；歧义关系不投影，同公司不推断人物关系", async () => {
 const f = await fixture({
  "People/a.md":note("id: a\ntype: person\ntitle: 王甲"),
  "People/b.md":note("id: b\ntype: person\ntitle: 李乙"),
  "Orgs/x.md":note("id: x\ntype: org\ntitle: 示例公司"),
  "Orgs/y.md":note("id: y\ntype: org\ntitle: 另一公司"),
  "Affiliations/ax.md":note("id: ax\ntype: affiliation\ntitle: 王甲在示例公司\nrole: 创始人\nstatus: current", "- held_by: [[People/a]]\n- at_org: [[Orgs/x]]"),
  "Affiliations/ay.md":note("id: ay\ntype: affiliation\ntitle: 王甲在另一公司\nrole: 大股东", "- held_by: [[People/a]]\n- at_org: [[Orgs/y]]"),
  "Affiliations/bx.md":note("id: bx\ntype: affiliation\ntitle: 李乙在示例公司\nrole: 员工\nstatus: former\nendDate: 2025-01-01", "- held_by: [[People/b]]\n- at_org: [[Orgs/x]]"),
  "Affiliations/invalid.md":note("id: invalid\ntype: affiliation\ntitle: 未确认所属", "- held_by: [[People/a]]\n- at_org: [[Orgs/x]] 和 [[Orgs/y]]"),
 });
 try {
  const list=(await f.app.inject(`/api/contacts?vault=${f.binding.id}`)).json();
  assert.equal(list.total,2); const a=list.people.find((p:{name:string})=>p.name==="王甲"),b=list.people.find((p:{name:string})=>p.name==="李乙");
  assert.equal(a.affiliations.length,2); assert.equal(b.affiliations.length,1);
  assert.equal(a.affiliations[0].org.path,b.affiliations[0].org.path);
  assert.equal(a.affiliations.find((x:{org:{title:string}})=>x.org.title==="另一公司").role,"大股东");
  assert.equal(a.affiliations.find((x:{org:{title:string}})=>x.org.title==="另一公司").status,null);
  assert.match(b.role,/历史/); assert.equal(b.affiliations[0].endDate,"2025-01-01");
  assert.equal(list.warnings.length,1); assert.equal((await f.app.inject(`/api/contacts?vault=${f.binding.id}&q=${encodeURIComponent("示例公司")}`)).json().matched,2);
  assert.deepEqual(list.edges??[],[],"同公司不自动生成同事/认识关系");
  const org=a.affiliations[0].org; assert.equal((await f.app.inject(`/api/contacts/${a.id}/source?${new URLSearchParams({vault:f.binding.id,path:org.path,hash:org.contentHash})}`)).statusCode,200);
  await writeFile(path.join(f.root,"Orgs/x.md"),note("id: x\ntype: org\ntitle: 更名公司"));
  const changed=(await f.app.inject(`/api/contacts?vault=${f.binding.id}`)).json(); assert.equal(changed.people.filter((p:{company:string})=>p.company.includes("更名公司")).length,2);
  assert.equal((await f.app.inject(`/api/contacts/${a.id}/source?${new URLSearchParams({vault:f.binding.id,path:org.path,hash:org.contentHash})}`)).statusCode,409);
 } finally { await f.app.close(); await rm(f.base,{recursive:true,force:true}); }
});
