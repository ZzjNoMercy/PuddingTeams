import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { imageDimensions, parseImageExtraction, type ImageExtractionArtifact } from "./image-extraction.js";
import { KnowledgeObjectStore } from "./objects.js";
import { KnowledgeSourceStore, knowledgeSourceManifestHash } from "./sources.js";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");

test("图片协议：尺寸/区域/空结果/坏JSON/字节限额不产生伪就绪", () => {
 assert.deepEqual(imageDimensions(png, "image/png"), { width: 1, height: 1 });
 assert.throws(() => imageDimensions(png.subarray(0, 20), "image/png"), /图片头/);
 const huge = Buffer.from(png); huge.writeUInt32BE(16385, 16); assert.throws(() => imageDimensions(huge, "image/png"), /像素|边长/);
 assert.throws(() => parseImageExtraction('{"segments":[]}'), /没有可核对/);
 assert.throws(() => parseImageExtraction('not JSON'));
 assert.throws(() => parseImageExtraction(JSON.stringify({segments:[{text:"事实",region:{x:.9,y:0,width:.2,height:1}}]})), /区域定位/);
 assert.throws(() => parseImageExtraction(JSON.stringify({segments:[{text:" "}]})), /为空/);
 assert.throws(() => parseImageExtraction("x".repeat(128*1024+1)), /超限/);
 assert.deepEqual(parseImageExtraction('```json\n{"segments":[{"text":"姓名不清","region":null,"warnings":["无法辨认"]}],"warnings":[]}\n```').segments,
  [{text:"姓名不清",warnings:["无法辨认"]}]);
});

test("图片来源：原件不可变、衍生/模型/区域独立固定、取消提交栅栏不落来源", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pt-image-source-"));
 try {
  const objects = new KnowledgeObjectStore(path.join(root,"objects")), store = new KnowledgeSourceStore({stateDir:root,objects});
  const [raw] = await store.createUploads("owner",[{filename:"图.png",mediaType:"image/png",data:png.toString("base64")}]); assert(raw);
  const artifact: ImageExtractionArtifact = {version:1,extractorId:"pi-vision",extractorVersion:"1",modelRef:"fixture/vision",configHash:"f".repeat(64),
   originalHash:raw.originalHash,width:1,height:1,segments:[{text:"姓名：张三\n日期不清",region:{x:0,y:0,width:1,height:.5},warnings:["需核对日期"]},{text:"第二段",warnings:[]}],warnings:["模型提取"],createdAt:new Date().toISOString()};
  const derived=await store.createImageExtraction("owner",raw.id,artifact);
  assert.notEqual(derived.id,raw.id); assert.equal(derived.derivedFrom,raw.id); assert.equal(derived.originalHash,raw.originalHash);
  assert.equal(derived.originalHash,createHash("sha256").update(png).digest("hex")); assert.notEqual(derived.textHash,derived.originalHash);
  assert.deepEqual(await store.get("owner",raw.id),raw); assert.deepEqual((await store.readOriginal("owner",derived.id)).bytes,png);
  assert.equal((await store.readText("owner",derived.id)).text,"姓名：张三\n日期不清\n\n第二段");
  assert.equal(derived.locations[1]!.startLine,4); assert(derived.warnings.includes("需核对日期"));
  assert.equal(JSON.parse((await objects.get(derived.extraction!.artifactHash)).toString()).configHash,artifact.configHash);
  assert.notEqual(knowledgeSourceManifestHash([derived]),knowledgeSourceManifestHash([{...derived,extraction:{...derived.extraction!,modelRef:"changed"}}]));
  await assert.rejects(()=>store.readText("other",derived.id),/不存在/);
  await assert.rejects(()=>store.createImageExtraction("owner",raw.id,{...artifact,originalHash:"wrong"}),/身份/);
  await assert.rejects(()=>store.createImageExtraction("owner",raw.id,artifact,{assertCurrent:async()=>{},commitGuard:()=>{throw new Error("cancelled at commit");}}),/cancelled/);
  const db=new DatabaseSync(path.join(root,"sources.sqlite")); try {assert.equal((db.prepare("SELECT COUNT(*) AS n FROM knowledge_sources").get() as {n:number}).n,2);} finally {db.close();}
  const get=objects.get.bind(objects); objects.get=async(hash)=>{if(hash===derived.extraction!.artifactHash)throw new Error("missing extraction");return get(hash);};
  await assert.rejects(()=>store.manifest("owner",[derived.id]),/missing extraction/);
 } finally {await rm(root,{recursive:true,force:true});}
});
