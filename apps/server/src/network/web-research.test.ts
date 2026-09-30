import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { CredentialsStore } from "../store/credentials.js";
import { WebResearchSettings, WebSettingsConflict, registerWebResearchSettingsRoutes, webResearchTarget } from "./web-research.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
async function stack(transport?:unknown,key?:()=>Promise<string|undefined>) {
 const dir=await mkdtemp(path.join(os.tmpdir(),"pt-web-research-"));
 const credentials=new CredentialsStore(dir);await credentials.init();
 const targets = [
  {id:"worker-a",name:"Worker A",kind:"worker" as const,supported:true,enabled:true},
  {id:"worker-b",name:"Worker B",kind:"worker" as const,supported:true,enabled:true},
  {id:"manager",name:"Manager",kind:"manager" as const,supported:true,enabled:true},
  {id:"codex",name:"Codex",kind:"worker" as const,supported:false,enabled:true},
  webResearchTarget({name:"wiki",displayName:"知识库管理",builtinId:"wiki",description:"Wiki",connector:{extensionId:"pi",connectorId:"pi",transport:"sdk",config:{}},enabled:true}),
 ];
 let changed=0;
 const settings=new WebResearchSettings(credentials,key?async p=>p==="deepseek"?key():undefined:undefined,transport,{targets:async()=>targets,onAccessChanged:()=>{changed++;}});
 const app=Fastify();registerWebResearchSettingsRoutes(app,settings);return {app,settings,dir,credentials,targets,changed:()=>changed};
}
const success=async()=>({status:200,headers:{},body:Buffer.from(JSON.stringify({output:[{type:"web_search_call",action:{sources:[{url:"https://example.com/source",title:"Source"}]}},{type:"message",content:[{type:"output_text",text:"Evidence",annotations:[]}]}]}))});
test("all local Pi roles including Wiki can configure networking; external connectors cannot",()=>{
 for(const connectorId of ["pi","codex","claude-code","puddingclaw"]){
  const target=webResearchTarget({name:connectorId,description:"role",...(connectorId==="pi"?{builtinId:"wiki" as const}:{}),connector:{extensionId:connectorId,connectorId,transport:connectorId==="pi"?"sdk":"spawn",config:{}}});
  assert.equal(target.supported,connectorId==="pi");assert.equal(target.enabled,true);
 }
 assert.equal(webResearchTarget({name:"manager",description:"manager",pinned:true,invoke:{type:"pi"}}).supported,true);
 assert.equal(webResearchTarget({name:"legacy",description:"legacy",invoke:{type:"command",command:"external",runArgs:[]}}).supported,false);
});
test("Wiki authorization uses the same grant API and live revocation guard",async()=>{
 let calls=0;const {app,settings}=await stack(async()=>{calls++;return {status:200,headers:{"content-type":"text/html"},body:Buffer.from("<main>Public evidence</main>")};});
 try {
  let view=await settings.view();assert.equal(view.targets.find(t=>t.id==="wiki")?.supported,true);assert.deepEqual(await settings.tools("wiki"),[]);
  const saved=await app.inject({method:"PUT",url:"/api/settings/web-research/workers/wiki",payload:{expectedRevision:view.revision,grant:{search:false,fetch:true}}});
  assert.equal(saved.statusCode,200,saved.body);view=saved.json();
  const tools=await settings.tools("wiki") as unknown as RegisteredTool[];assert.deepEqual(tools.map(t=>t.name),["fetch_url"]);
  await tools[0]!.execute("fetch",{url:"https://example.com"});assert.equal(calls,1);
  await settings.saveGrant("wiki",{expectedRevision:view.revision,grant:{search:false,fetch:false}});
  await assert.rejects(tools[0]!.execute("fetch",{url:"https://example.com"}),/未获授权/);assert.equal(calls,1);
 }finally{await app.close();}
});
test("settings API never returns keys, encrypts state, keeps version conflicts atomic and survives restart",async()=>{
 const {app,settings,dir,credentials}=await stack();
 try {
  const initial=(await app.inject({url:"/api/settings/web-research"})).json();
  const saved=await app.inject({method:"PUT",url:"/api/settings/web-research",payload:{expectedRevision:initial.revision,settings:initial.settings,keys:{tavily:"private-test-key"}}});
  assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().providers.tavily.configured,true);assert.ok(!saved.body.includes("private-test-key"));
  assert.ok(!(await readFile(path.join(dir,"credentials.json"),"utf8")).includes("private-test-key"));
  const stale=await app.inject({method:"PUT",url:"/api/settings/web-research",payload:{expectedRevision:0,settings:initial.settings,keys:{tavily:"different-key"}}});assert.equal(stale.statusCode,409);
  assert.equal((await settings.state()).keys.TAVILY_API_KEY,"private-test-key");
  const restored=new WebResearchSettings(credentials);assert.equal((await restored.view()).providers.tavily.configured,true);
 } finally {await app.close();}
});
test("model credential fallback stays ready on enable and invalidates when credential/model/proxy changes",async()=>{
 let key="model-key-one";const {settings,app}=await stack(success,async()=>key);
 try {
  let view=await settings.view();assert.equal(view.providers.deepseek.credentialSource,"model");
  view=await settings.test("deepseek");assert.equal(view.providers.deepseek.test?.status,"ready");
  view=await settings.save({expectedRevision:view.revision,settings:{...view.settings,enabled:true,providers:{...view.settings.providers,deepseek:{...view.settings.providers.deepseek,enabled:true}}}});assert.equal(view.providers.deepseek.test?.status,"ready");
  key="model-key-two";assert.equal((await settings.view()).providers.deepseek.test,null);
  view=await settings.test("deepseek");view=await settings.save({expectedRevision:view.revision,settings:{...view.settings,proxyUrl:"http://127.0.0.1:7890"}});assert.equal(view.providers.deepseek.test,null);
  view=await settings.test("deepseek");view=await settings.save({expectedRevision:view.revision,settings:{...view.settings,providers:{...view.settings.providers,deepseek:{...view.settings.providers.deepseek,model:"other-model"}}}});assert.equal(view.providers.deepseek.test,null);
 } finally {await app.close();}
});
test("independent key overrides model key; clearing it restores fallback and invalidates readiness",async()=>{
 const {settings,app}=await stack(success,async()=>"model-key");try {
  let view=await settings.view();view=await settings.save({expectedRevision:view.revision,settings:view.settings,keys:{deepseek:"independent-key"}});
  assert.equal((await settings.state()).keys.DEEPSEEK_API_KEY,"independent-key");view=await settings.test("deepseek");assert.equal(view.providers.deepseek.test?.status,"ready");
  view=await settings.save({expectedRevision:view.revision,settings:view.settings,keys:{deepseek:""}});assert.equal(view.providers.deepseek.credentialSource,"model");assert.equal(view.providers.deepseek.test,null);
 } finally {await app.close();}
});
test("in-flight test cannot approve changed configuration",async()=>{
 let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
 const {settings,app}=await stack(async()=>{entered();await hold;return success();},async()=>"key");try {
  const testing=settings.test("deepseek");await started;const view=await settings.view();await settings.save({expectedRevision:view.revision,settings:{...view.settings,proxyUrl:"http://127.0.0.1:1234"}});release();await assert.rejects(testing,WebSettingsConflict);assert.equal((await settings.view()).providers.deepseek.test,null);
 } finally {release();await app.close();}
});
test("unsupported search is a failed test and cannot become ready",async()=>{
 const {app,settings}=await stack(async()=>({status:200,body:Buffer.from(JSON.stringify({output:[{type:"message",content:[{type:"output_text",text:"https://example.com"}]}]}))}),async()=>"key");try {
  const tested=await app.inject({method:"POST",url:"/api/settings/web-research/deepseek/test"});assert.equal(tested.statusCode,200);assert.equal(tested.json().providers.deepseek.test.status,"error");assert.match(tested.json().providers.deepseek.test.message,/真实搜索/);assert.equal((await settings.state()).tests.deepseek?.status,"error");
 }finally{await app.close();}
});
test("invalid config and unknown providers are rejected",async()=>{
 const {app,settings}=await stack();try {const view=await settings.view();for(const patch of [{defaultScope:"invalid"},{globalOrder:["tavily","tavily","grok"]},{proxyUrl:"http://user:pw@localhost"},{maxProviderAttempts:10},{apiKey:"secret"}]){const res=await app.inject({method:"PUT",url:"/api/settings/web-research",payload:{expectedRevision:0,settings:{...view.settings,...patch}}});assert.equal(res.statusCode,400);}
  const bad=await app.inject({method:"POST",url:"/api/settings/web-research/unknown/test"});assert.equal(bad.statusCode,400);
 }finally{await app.close();}
});
type RegisteredTool = {name:string;execute(id:string,params:unknown):Promise<unknown>};
async function registered(settings:WebResearchSettings,id:string):Promise<RegisteredTool[]> {
 const tools:RegisteredTool[]=[];
 const extension=settings.extension(id);const factory=typeof extension==="function"?extension:extension.factory;
 await factory({registerTool:(tool:unknown)=>tools.push(tool as RegisteredTool)} as unknown as ExtensionAPI);
 return tools;
}
test("Worker authorization separates tools and blocks retained tools immediately after revocation",async()=>{
 let calls=0;
 const {settings,app,changed}=await stack(async()=>{calls++;return {status:200,headers:{"content-type":"text/html"},body:Buffer.from("<h1>Public page</h1>")};});
 try {
  assert.deepEqual(await registered(settings,"worker-a"),[]);
  let view=await settings.view();
  view=await settings.save({expectedRevision:view.revision,settings:view.settings,grants:{"worker-a":{search:false,fetch:true}}});
  const tools=await registered(settings,"worker-a");assert.deepEqual(tools.map(t=>t.name),["fetch_url"]);
  assert.deepEqual(await registered(settings,"worker-b"),[]);assert.deepEqual(await registered(settings,"manager"),[]);
  await tools[0]!.execute("id",{url:"https://example.com"});assert.equal(calls,1);
  const before=await settings.accessFingerprint("worker-a");
  view=await settings.save({expectedRevision:view.revision,settings:view.settings,grants:{}});
  assert.notEqual(await settings.accessFingerprint("worker-a"),before);
  await assert.rejects(tools[0]!.execute("id",{url:"https://example.com"}),/未获授权/);assert.equal(calls,1);
  assert.deepEqual(await registered(settings,"worker-a"),[]);assert.equal(changed(),2);
 }finally{await app.close();}
});
test("global toggles, deleted/disabled targets and per-tool authorization all gate access",async()=>{
 const {settings,app,targets}=await stack();try {
  let view=await settings.view();
  view=await settings.save({expectedRevision:0,settings:view.settings,grants:{"worker-a":{search:true,fetch:true},"worker-b":{search:true,fetch:false}}});
  assert.deepEqual((await registered(settings,"worker-a")).map(t=>t.name),["fetch_url"]);
  view=await settings.save({expectedRevision:view.revision,settings:{...view.settings,enabled:true}});
  assert.deepEqual((await registered(settings,"worker-a")).map(t=>t.name),["web_search","fetch_url"]);
  assert.deepEqual((await registered(settings,"worker-b")).map(t=>t.name),["web_search"]);
  const retained=(await registered(settings,"worker-a"))[1]!;
  targets[0]!.enabled=false;
  assert.deepEqual(await registered(settings,"worker-a"),[]);await assert.rejects(retained.execute("id",{url:"https://example.com"}),/未获授权/);
  targets.splice(0,1);assert.deepEqual(await registered(settings,"worker-a"),[]);
  view=await settings.save({expectedRevision:view.revision,settings:{...view.settings,enabled:false}});
  assert.deepEqual(await registered(settings,"worker-b"),[]);
 }finally{await app.close();}
});
test("authorization API rejects unsupported/unknown targets and malformed grants atomically",async()=>{
 const {settings,app,credentials,targets}=await stack();try {
  const view=await settings.view();
  for(const grants of [{codex:{search:true,fetch:true}},{unknown:{search:true,fetch:true}},{"worker-a":{search:"yes",fetch:true}},{"worker-a":{search:true,fetch:true,extra:true}},[],null]) {
   const result=await app.inject({method:"PUT",url:"/api/settings/web-research",payload:{expectedRevision:0,settings:view.settings,grants}});
   assert.equal(result.statusCode,400,result.body);assert.equal((await settings.view()).revision,0);
  }
  const saved=await settings.save({expectedRevision:0,settings:view.settings,grants:{"worker-a":{search:false,fetch:true}}});
  assert.deepEqual(saved.grants,{"worker-a":{search:false,fetch:true}});
  const restored=new WebResearchSettings(credentials,undefined,undefined,{targets:async()=>targets});assert.deepEqual((await restored.view()).grants,saved.grants);assert.deepEqual((await registered(restored,"worker-a")).map(t=>t.name),["fetch_url"]);
 }finally{await app.close();}
});

test("single Worker authorization API shares global state without replacing providers, credentials or other grants", async () => {
 const { app, settings, changed } = await stack(success, async () => "model-key");
 try {
  let view = await settings.view();
  view = await settings.save({ expectedRevision: view.revision, settings: view.settings, keys: {tavily:"independent-key"}, grants: {"worker-b":{search:true,fetch:false}} });
  view = await settings.test("deepseek");
  const before = await settings.state();
  const updated = await app.inject({method:"PUT",url:"/api/settings/web-research/workers/worker-a",payload:{expectedRevision:view.revision,grant:{search:false,fetch:true}}});
  assert.equal(updated.statusCode,200,updated.body);
  const after=await settings.state();
  assert.deepEqual(after.config,before.config);assert.deepEqual(after.keys,before.keys);assert.deepEqual(after.tests,before.tests);
  assert.deepEqual(after.grants,{"worker-b":{search:true,fetch:false},"worker-a":{search:false,fetch:true}});
  assert.deepEqual((await settings.view()).grants,updated.json().grants);assert.ok(!updated.body.includes("independent-key"));
  assert.equal(changed(),2);
  const stale=await app.inject({method:"PUT",url:"/api/settings/web-research/workers/worker-b",payload:{expectedRevision:view.revision,grant:{search:false,fetch:false}}});
  assert.equal(stale.statusCode,409);assert.deepEqual((await settings.state()).grants,after.grants);
  view=await settings.save({expectedRevision:after.revision,settings:after.config,grants:{...after.grants,"worker-a":{search:true,fetch:false}}});
  assert.deepEqual(view.grants["worker-a"],{search:true,fetch:false});
  const revoked=await app.inject({method:"PUT",url:"/api/settings/web-research/workers/worker-a",payload:{expectedRevision:view.revision,grant:{search:false,fetch:false}}});
  assert.equal(revoked.statusCode,200,revoked.body);assert.equal(revoked.json().grants["worker-a"],undefined);assert.deepEqual(revoked.json().grants["worker-b"],{search:true,fetch:false});
 } finally {await app.close();}
});
test("single Worker grant route rejects invalid, unsupported and unknown targets without changing state", async()=>{
 const {app,settings}=await stack();try {
  for (const [id,body] of [
   ["codex",{expectedRevision:0,grant:{search:true,fetch:true}}],
   ["missing",{expectedRevision:0,grant:{search:true,fetch:true}}],
   ["worker-a",{expectedRevision:0,grant:{search:true,fetch:"yes"}}],
   ["worker-a",{expectedRevision:0,grant:{search:true,fetch:true,extra:true}}],
   ["worker-a",{expectedRevision:0,grant:{search:true,fetch:true},settings:{enabled:true}}],
   ["worker-a",{grant:{search:true,fetch:true}}],
  ] as const) {
   const result=await app.inject({method:"PUT",url:`/api/settings/web-research/workers/${id}`,payload:body});assert.equal(result.statusCode,400,result.body);assert.equal((await settings.view()).revision,0);
  }
 }finally{await app.close();}
});

test("test-and-save tests the draft key/model before atomically saving encrypted settings and readiness", async()=>{
 let inspect!: (options:{headers:Record<string,string>;body:string})=>Promise<void>;
 let calls=0;
 const {app,settings,credentials,dir,changed}=await stack(async(_url:unknown,options:{headers:Record<string,string>;body:string})=>{calls++;await inspect(options);return success();},async()=>"model-key");
 try {
  let view=await settings.view();
  view=await settings.save({expectedRevision:view.revision,settings:view.settings,grants:{"worker-b":{search:false,fetch:true}}});
  const before=await credentials.getSecrets("platform");
  inspect=async(options)=>{
   assert.equal(options.headers.Authorization,"Bearer draft-private-key");
   assert.equal(JSON.parse(options.body).model,"draft-model");
   assert.deepEqual(await credentials.getSecrets("platform"),before);
   assert.equal(changed(),1);
  };
  const config={...view.settings,providers:{...view.settings.providers,deepseek:{...view.settings.providers.deepseek,model:"draft-model"}}};
  const result=await app.inject({method:"POST",url:"/api/settings/web-research/deepseek/test-and-save",payload:{expectedRevision:view.revision,settings:config,keys:{deepseek:" draft-private-key "},grants:view.grants}});
  assert.equal(result.statusCode,200,result.body);assert.equal(calls,1);assert.equal(result.json().revision,view.revision+1);
  assert.equal(result.json().providers.deepseek.test.status,"ready");assert.equal(result.json().providers.deepseek.credentialSource,"network");
  assert.equal(result.json().settings.enabled,false);assert.equal(result.json().settings.providers.deepseek.enabled,false);
  assert.deepEqual(result.json().grants,view.grants);assert.equal(changed(),1);assert.ok(!result.body.includes("draft-private-key"));
  assert.ok(!(await readFile(path.join(dir,"credentials.json"),"utf8")).includes("draft-private-key"));
  const restarted=new WebResearchSettings(credentials);assert.equal((await restarted.view()).providers.deepseek.test?.status,"ready");
 }finally{await app.close();}
});

test("failed draft search leaves credentials, configuration, grants and revision unchanged",async()=>{
 const {app,settings,credentials,changed}=await stack(async()=>({status:200,body:Buffer.from(JSON.stringify({output:[{type:"message",content:[{type:"output_text",text:"No search evidence"}]}]}))}));
 try {
  const view=await settings.view();const before=await credentials.getSecrets("platform");
  const result=await app.inject({method:"POST",url:"/api/settings/web-research/deepseek/test-and-save",payload:{expectedRevision:0,settings:{...view.settings,enabled:true},keys:{deepseek:"unverified-key"},grants:{"worker-a":{search:true,fetch:true}}}});
  assert.equal(result.statusCode,400,result.body);assert.match(result.json().error,/测试未通过，修改未保存/);
  assert.deepEqual(await credentials.getSecrets("platform"),before);assert.deepEqual(await settings.view(),view);assert.equal(changed(),0);
 }finally{await app.close();}
});

test("draft testing rejects stale revisions and invalid requests before calling a supplier",async()=>{
 let calls=0;const {app,settings}=await stack(async()=>{calls++;return success();},async()=>"key");
 try {
  const initial=await settings.view();await settings.save({expectedRevision:0,settings:initial.settings});
  const stale=await app.inject({method:"POST",url:"/api/settings/web-research/deepseek/test-and-save",payload:{expectedRevision:0,settings:initial.settings}});assert.equal(stale.statusCode,409);
  for(const [provider,payload] of [["unknown",{expectedRevision:1,settings:initial.settings}],["deepseek",{expectedRevision:1,settings:initial.settings,extra:true}],["deepseek",{expectedRevision:1,settings:{...initial.settings,enabled:"yes"}}],["deepseek",{expectedRevision:1,settings:initial.settings,grants:{codex:{search:true,fetch:true}}}]] as const) {
   const result=await app.inject({method:"POST",url:`/api/settings/web-research/${provider}/test-and-save`,payload});assert.equal(result.statusCode,400,result.body);
  }
  assert.equal(calls,0);assert.equal((await settings.view()).revision,1);
 }finally{await app.close();}
});

test("draft test cannot overwrite settings changed during search or approve changed model credentials",async()=>{
 for(const change of ["settings","credential"] as const) {
  let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});let key="model-key-before";
  const {settings,app,credentials}=await stack(async()=>{entered();await hold;return success();},async()=>key);
  try {
   const view=await settings.view();const testing=settings.testAndSave("deepseek",{expectedRevision:view.revision,settings:view.settings});await started;
   if(change==="settings") await settings.save({expectedRevision:view.revision,settings:{...view.settings,proxyUrl:"http://127.0.0.1:7890"}});else key="model-key-after";
   const before=await credentials.getSecrets("platform");release();await assert.rejects(testing,WebSettingsConflict);
   assert.deepEqual(await credentials.getSecrets("platform"),before);assert.equal((await settings.view()).providers.deepseek.test,null);
  }finally{release();await app.close();}
 }
});

test("cancelled successful draft test does not commit",async()=>{
 const controller=new AbortController();const {settings,app,credentials}=await stack(async()=>{controller.abort();return success();},async()=>"key");
 try {
  const view=await settings.view();const before=await credentials.getSecrets("platform");
  await assert.rejects(settings.testAndSave("deepseek",{expectedRevision:view.revision,settings:view.settings},controller.signal),/取消/);
  assert.deepEqual(await credentials.getSecrets("platform"),before);assert.equal((await settings.view()).revision,0);
 }finally{await app.close();}
});
