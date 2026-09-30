import { createHash } from "node:crypto";
import type { ExtensionAPI, InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FastifyInstance } from "fastify";
import { CredentialsStore } from "../store/credentials.js";
import type { AgentConfig } from "../store/teams.js";
import { DEFAULT_CONFIG, PROVIDERS, PROVIDER_KEYS, testProvider, type ProviderId, type WebConfig, type ProviderTest, type SearchState } from "../../../../extensions/capabilities/web-research/core/service.mjs";
import { createTools } from "../../../../extensions/capabilities/web-research/core/tools.mjs";

export interface WebResearchGrant { search: boolean; fetch: boolean }
export interface WebResearchTarget { id: string; name: string; kind: "manager" | "worker"; supported: boolean; enabled: boolean; reason?: string }
export function webResearchTarget(agent: AgentConfig): WebResearchTarget {
  const supported = Boolean(agent.pinned || agent.connector?.connectorId === "pi");
  return {id:agent.name,name:agent.displayName ?? agent.name,kind:agent.pinned ? "manager" : "worker",supported,enabled:agent.enabled !== false,
    ...(supported ? {} : {reason:"使用接入 Agent 自身的联网能力"})};
}
interface AccessOptions { targets: () => Promise<WebResearchTarget[]>; onAccessChanged?: () => void }
interface StoredState extends SearchState { revision: number; grants: Record<string, WebResearchGrant> }
interface SaveInput { expectedRevision: number; settings: unknown; keys?: Partial<Record<ProviderId,string>>; grants?: Record<string,WebResearchGrant> }
interface WebResearchView {
  revision:number;
  settings:WebConfig;
  grants:Record<string,WebResearchGrant>;
  targets:WebResearchTarget[];
  providers:Record<ProviderId,{configured:boolean;credentialSource:"network"|"model"|"none";test:Omit<ProviderTest,"fingerprint">|null}>;
}
export class WebSettingsConflict extends Error {}
const fingerprint = (state: SearchState, provider: ProviderId) => {
  const { enabled: _enabled, ...options } = state.config.providers[provider];
  return createHash("sha256").update(JSON.stringify({options,proxy:state.config.proxyUrl,key:state.keys[PROVIDER_KEYS[provider]]??""})).digest("hex");
};
function validateConfig(raw: unknown): WebConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("联网配置无效");
  const value = raw as WebConfig;
  const config = structuredClone(DEFAULT_CONFIG);
  const allowed = new Set(Object.keys(config));
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error("未知联网配置字段");
  for (const key of ["enabled", "fetchEnabled", "fallbackEnabled", "crossCheckEnabled"] as const) {
    if(typeof value[key] !== "boolean") throw new Error(`${key} 必须为布尔值`);
    config[key] = value[key];
  }
  if(!["domestic","global"].includes(value.defaultScope)) throw new Error("默认范围无效");
  config.defaultScope=value.defaultScope;
  if(!Number.isInteger(value.maxProviderAttempts)||value.maxProviderAttempts<1||value.maxProviderAttempts>3) throw new Error("回退尝试次数必须为 1–3");
  config.maxProviderAttempts=value.maxProviderAttempts;
  for(const key of ["domesticOrder","globalOrder"] as const) {
    if(!Array.isArray(value[key])||value[key].length!==3||new Set(value[key]).size!==3||value[key].some(p=>!PROVIDERS.includes(p))) throw new Error("路由必须包含三家供应商且不能重复");
    config[key]=[...value[key]];
  }
  if(typeof value.proxyUrl!=="string"||value.proxyUrl.length>2048) throw new Error("代理地址无效");
  if(value.proxyUrl) {
    const url=new URL(value.proxyUrl);
    if(!["http:","https:"].includes(url.protocol)||url.username||url.password||(url.pathname!=="/"&&url.pathname!=="")||url.search||url.hash) throw new Error("代理仅支持不含凭据的 HTTP(S) 地址");
  }
  config.proxyUrl=value.proxyUrl.trim();
  if(!value.providers||Object.keys(value.providers).some(p=>!PROVIDERS.includes(p as ProviderId))) throw new Error("供应商配置无效");
  for(const p of PROVIDERS) {
    const entry=value.providers[p];
    if(!entry||typeof entry.enabled!=="boolean"||typeof entry.model!=="string"||entry.model.length>120||/[\r\n]/.test(entry.model)) throw new Error(`${p} 配置无效`);
    const fields=p==="tavily"?["enabled","model","searchDepth"]:p==="grok"?["enabled","model","webEnabled","xEnabled"]:["enabled","model"];
    if(Object.keys(entry).some(k=>!fields.includes(k))) throw new Error(`${p} 未知配置字段`);
    if(p!=="tavily"&&!entry.model.trim()) throw new Error(`${p} 模型不能为空`);
    if(p==="tavily"&&!["basic","advanced"].includes(entry.searchDepth??"")) throw new Error("Tavily 搜索深度无效");
    if(p==="grok"&&(typeof entry.webEnabled!=="boolean"||typeof entry.xEnabled!=="boolean")) throw new Error("Grok 工具开关无效");
    config.providers[p]={...entry,model:entry.model.trim()};
  }
  return config;
}

export class WebResearchSettings {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly credentials: CredentialsStore, private readonly modelKey?: (provider: ProviderId) => Promise<string | undefined>, private readonly transport?: unknown, private readonly access?: AccessOptions) {}
  private serialize<T>(action:()=>Promise<T>):Promise<T> {const run=this.queue.then(action,action);this.queue=run.then(()=>undefined,()=>undefined);return run;}
  private async stored():Promise<StoredState> {
    const raw=(await this.credentials.getSecrets("platform"))["STATE"];
    if(!raw) return {revision:0,config:structuredClone(DEFAULT_CONFIG),keys:{},tests:{},grants:{}};
    const value=JSON.parse(raw) as StoredState;
    return {...value,grants:value.grants ?? {},config:validateConfig(value.config)};
  }
  async state():Promise<StoredState> {
    await this.queue;
    const state=await this.stored();
    for(const p of PROVIDERS) {
      if(!state.keys[PROVIDER_KEYS[p]]) {
        const key=await this.modelKey?.(p);
        if(key) state.keys[PROVIDER_KEYS[p]]=key;
      }
      if(state.tests[p]?.fingerprint!==fingerprint(state,p)) delete state.tests[p];
    }
    return state;
  }
  async view():Promise<WebResearchView> {
    const state=await this.state();const saved=await this.stored();
    const targets = await this.access?.targets() ?? [];
    const grants = Object.fromEntries(Object.entries(state.grants).filter(([id]) => targets.some(target => target.id === id && target.supported) && (state.grants[id]?.search || state.grants[id]?.fetch)));
    return {revision:state.revision,settings:state.config,grants,targets,providers:Object.fromEntries(PROVIDERS.map(p=>{
      const test=state.tests[p];
      return [p,{configured:Boolean(state.keys[PROVIDER_KEYS[p]]),credentialSource:saved.keys[PROVIDER_KEYS[p]]?"network":state.keys[PROVIDER_KEYS[p]]?"model":"none",test:test?{status:test.status,checkedAt:test.checkedAt,message:test.message}:null}];
    })) as WebResearchView["providers"]};
  }
  private async validateSave(input: SaveInput) {
    const config=validateConfig(input.settings);
    if(!Number.isInteger(input.expectedRevision)||input.expectedRevision<0) throw new Error("缺少联网配置版本，请重新读取");
    if(input.keys&&(typeof input.keys!=="object"||Array.isArray(input.keys)||Object.entries(input.keys).some(([p,k])=>!PROVIDERS.includes(p as ProviderId)||typeof k!=="string"||k.length>8192||/[\r\n]/.test(k)))) throw new Error("密钥配置无效");
    const targets = await this.access?.targets() ?? [];
    if (input.grants !== undefined && (!input.grants || typeof input.grants !== "object" || Array.isArray(input.grants) || Object.entries(input.grants).some(([id, grant]) =>
      !targets.some(target => target.id === id && target.supported) || !grant || typeof grant !== "object" ||
      Object.keys(grant).some(key => !["search", "fetch"].includes(key)) || typeof grant.search !== "boolean" || typeof grant.fetch !== "boolean"
    ))) throw new Error("Worker 联网授权无效，只能授权支持平台联网的智能体");
    return {config, targets};
  }
  async save(input: SaveInput) { return this.commit(input); }
  private async commit(input: SaveInput, verified?: {provider:ProviderId;test:ProviderTest;signal?:AbortSignal}) {
    const {config, targets} = await this.validateSave(input);
    let accessChanged = false;
    await this.serialize(async()=>{
      const state=await this.stored();if(state.revision!==input.expectedRevision) throw new WebSettingsConflict("联网设置已变化，请刷新后重新保存");
      const grants = Object.fromEntries(Object.entries(input.grants ?? state.grants).filter(([id, grant]) => targets.some(target => target.id === id && target.supported) && (grant.search || grant.fetch)));
      accessChanged = JSON.stringify(grants) !== JSON.stringify(state.grants) || state.config.enabled !== config.enabled || state.config.fetchEnabled !== config.fetchEnabled;
      state.grants = grants;
      state.config=config;state.revision++;
      for(const [p,key] of Object.entries(input.keys??{})) {if(key?.trim()) state.keys[PROVIDER_KEYS[p as ProviderId]]=key.trim();else delete state.keys[PROVIDER_KEYS[p as ProviderId]];delete state.tests[p as ProviderId];}
      const effective={...state,keys:{...state.keys}};
      for(const p of PROVIDERS) {
        if(!effective.keys[PROVIDER_KEYS[p]]) {
          const key=await this.modelKey?.(p);
          if(key) effective.keys[PROVIDER_KEYS[p]]=key;
        }
        if(state.tests[p]?.fingerprint!==fingerprint(effective,p)) delete state.tests[p];
      }
      if (verified) {
        if (verified.signal?.aborted) throw new Error("测试已取消，未保存修改");
        if (fingerprint(effective,verified.provider) !== verified.test.fingerprint) throw new WebSettingsConflict("测试期间凭据已变化，请重新测试；修改未保存");
        state.tests[verified.provider] = verified.test;
      }
      await this.credentials.setSecrets("platform",{STATE:JSON.stringify(state)});
    });
    if (accessChanged) this.access?.onAccessChanged?.();
    return this.view();
  }
  async testAndSave(provider: ProviderId, input: SaveInput, signal?: AbortSignal) {
    const {config} = await this.validateSave(input);
    await this.queue;
    const candidate = await this.stored();
    if (candidate.revision !== input.expectedRevision) throw new WebSettingsConflict("联网设置已变化，请读取最新状态后重试；修改未保存");
    candidate.config = config;
    for (const [p,key] of Object.entries(input.keys ?? {})) {
      if (key?.trim()) candidate.keys[PROVIDER_KEYS[p as ProviderId]] = key.trim();
      else delete candidate.keys[PROVIDER_KEYS[p as ProviderId]];
    }
    for (const p of PROVIDERS) {
      if (!candidate.keys[PROVIDER_KEYS[p]]) {
        const key = await this.modelKey?.(p);
        if (key) candidate.keys[PROVIDER_KEYS[p]] = key;
      }
    }
    const hash = fingerprint(candidate,provider);
    let result;
    try { result = await testProvider(provider,candidate,signal,this.transport); }
    catch (error) { throw new Error(`测试未通过，修改未保存：${error instanceof Error ? error.message : "搜索测试失败"}`); }
    return this.commit(input,{provider,signal,test:{status:"ready",checkedAt:new Date().toISOString(),message:`真实搜索成功，返回 ${result.sources.length} 条来源`,fingerprint:hash}});
  }
  async saveGrant(targetId: string, input: { expectedRevision: number; grant: WebResearchGrant }) {
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("缺少联网配置版本，请重新读取");
    const grant = input.grant;
    if (!grant || typeof grant !== "object" || Array.isArray(grant) || Object.keys(grant).some(key => !["search", "fetch"].includes(key)) || typeof grant.search !== "boolean" || typeof grant.fetch !== "boolean") throw new Error("Worker 联网授权无效");
    let changed = false;
    await this.serialize(async () => {
      const target = (await this.access?.targets() ?? []).find(target => target.id === targetId);
      if (!target) throw new Error("智能体不存在，请重新读取");
      if (!target.supported) throw new Error(target.reason ?? "该智能体不支持平台联网授权");
      const state = await this.stored();
      if (state.revision !== input.expectedRevision) throw new WebSettingsConflict("联网设置已变化，请读取最新状态后重试");
      const previous = state.grants[targetId];
      changed = Boolean(previous?.search) !== grant.search || Boolean(previous?.fetch) !== grant.fetch;
      if (grant.search || grant.fetch) state.grants[targetId] = { ...grant };
      else delete state.grants[targetId];
      state.revision++;
      await this.credentials.setSecrets("platform", { STATE: JSON.stringify(state) });
    });
    if (changed) this.access?.onAccessChanged?.();
    return this.view();
  }
  async test(provider:ProviderId,signal?:AbortSignal) {
    const state=await this.state();const hash=fingerprint(state,provider);
    let test:ProviderTest;
    try {const result=await testProvider(provider,state,signal,this.transport);test={status:"ready",checkedAt:new Date().toISOString(),message:`真实搜索成功，返回 ${result.sources.length} 条来源`,fingerprint:hash};}
    catch(error) {test={status:"error",checkedAt:new Date().toISOString(),message:error instanceof Error?error.message:"搜索测试失败",fingerprint:hash};}
    await this.serialize(async()=>{
      const current=await this.stored();if(current.revision!==state.revision) throw new WebSettingsConflict("测试期间联网设置已变化，请重新测试");
      current.tests[provider]=test;current.revision++;
      await this.credentials.setSecrets("platform",{STATE:JSON.stringify(current)});
    });
    return this.view();
  }
  private async allowed(targetId: string, state: StoredState): Promise<WebResearchGrant> {
    const target = (await this.access?.targets() ?? []).find(target => target.id === targetId);
    const grant = state.grants[targetId];
    return {
      search: Boolean(target?.supported && target.enabled && grant?.search && state.config.enabled),
      fetch: Boolean(target?.supported && target.enabled && grant?.fetch && state.config.fetchEnabled),
    };
  }
  async accessFingerprint(targetId: string): Promise<string> {
    return JSON.stringify({ targetId, ...await this.allowed(targetId, await this.state()) });
  }
  async tools(targetId: string): Promise<ToolDefinition[]> {
      const allowed = await this.allowed(targetId, await this.state());
      const tools: ToolDefinition[] = [];
      for (const tool of createTools({stateFor:()=>this.state(),transport:this.transport}) as ToolDefinition[]) {
        const permission = tool.name === "web_search" ? "search" : "fetch";
        if (!allowed[permission]) continue;
        // Live guard also covers retained SDK tool references during an active turn.
        tools.push({...tool, execute:async(...args: Parameters<ToolDefinition["execute"]>) => {
          if (!(await this.allowed(targetId, await this.state()))[permission]) throw new Error("该智能体未获授权或平台未启用此联网功能");
          return tool.execute(...args);
        }});
      }
      return tools;
  }
  extension(targetId: string): InlineExtension {
    return {name:"pudding-web-research",factory:async(pi:ExtensionAPI)=>{
      for (const tool of await this.tools(targetId)) pi.registerTool(tool);
    }};
  }
}
export function registerWebResearchSettingsRoutes(app:FastifyInstance,settings:WebResearchSettings) {
  app.get("/api/settings/web-research",()=>settings.view());
  app.put<{Body:{expectedRevision:number;settings:unknown;keys?:Partial<Record<ProviderId,string>>;grants?:Record<string,WebResearchGrant>}}>("/api/settings/web-research",async(req,reply)=>{
    try{if(!req.body||Object.keys(req.body).some(k=>!["expectedRevision","settings","keys","grants"].includes(k))) throw new Error("请求配置无效");return await settings.save(req.body);}catch(error){return reply.code(error instanceof WebSettingsConflict?409:400).send({error:error instanceof Error?error.message:"保存失败"});}
  });
  app.put<{Params:{agentId:string};Body:{expectedRevision:number;grant:WebResearchGrant}}>("/api/settings/web-research/workers/:agentId", async(req, reply) => {
    try {
      if (!req.body || Object.keys(req.body).some(key => !["expectedRevision", "grant"].includes(key))) throw new Error("请求配置无效");
      return await settings.saveGrant(req.params.agentId, req.body);
    } catch (error) { return reply.code(error instanceof WebSettingsConflict ? 409 : 400).send({error: error instanceof Error ? error.message : "授权保存失败"}); }
  });
  app.post<{Params:{provider:ProviderId}}>("/api/settings/web-research/:provider/test",async(req,reply)=>{
    if(!PROVIDERS.includes(req.params.provider)) return reply.code(400).send({error:"未知供应商"});
    const controller=new AbortController();
    const aborted=()=>controller.abort();req.raw.once("aborted",aborted);
    try{return await settings.test(req.params.provider,controller.signal);}catch(error){return reply.code(error instanceof WebSettingsConflict?409:400).send({error:error instanceof Error?error.message:"测试失败"});}
    finally {req.raw.off("aborted",aborted);}
  });
  app.post<{Params:{provider:ProviderId};Body:SaveInput}>("/api/settings/web-research/:provider/test-and-save",async(req,reply)=>{
    if (!PROVIDERS.includes(req.params.provider)) return reply.code(400).send({error:"未知供应商"});
    const controller = new AbortController();
    const aborted = () => controller.abort(); req.raw.once("aborted",aborted);
    try {
      if (!req.body || Object.keys(req.body).some(k=>!["expectedRevision","settings","keys","grants"].includes(k))) throw new Error("请求配置无效");
      return await settings.testAndSave(req.params.provider,req.body,controller.signal);
    } catch(error) { return reply.code(error instanceof WebSettingsConflict?409:400).send({error:error instanceof Error?error.message:"测试失败，修改未保存"}); }
    finally {req.raw.off("aborted",aborted);}
  });
}
