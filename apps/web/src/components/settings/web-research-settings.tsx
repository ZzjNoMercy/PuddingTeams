"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import { AlertCircleIcon, BotIcon, CheckCircle2Icon, ChevronDownIcon, FileTextIcon, GlobeIcon, KeyRoundIcon, LoaderIcon, SearchIcon, Settings2Icon, ShieldCheckIcon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getWebResearchSettings, saveWebResearchSettings, testAndSaveWebResearchProvider, type WebResearchView, type WebResearchConfig, type WebSearchProvider, type WebResearchGrant, WEB_RESEARCH_CHANGED_EVENT, WEB_RESEARCH_REVISION_KEY } from "@/lib/api";

const providers: WebSearchProvider[] = ["tavily", "deepseek", "grok"];
const names = { tavily: "Tavily", deepseek: "DeepSeek", grok: "Grok" };
const descriptions = { tavily: "为搜索而生，返回网页来源与摘要。", deepseek: "通过模型的服务端搜索工具检索网页。", grok: "检索全球网页与 X，支持图片和视频理解。" };
const orders: WebSearchProvider[][] = [["deepseek", "tavily", "grok"], ["grok", "tavily", "deepseek"], ["tavily", "deepseek", "grok"], ["tavily", "grok", "deepseek"], ["deepseek", "grok", "tavily"], ["grok", "deepseek", "tavily"]];

function ProviderMark({ provider, large = false }: { provider: WebSearchProvider; large?: boolean }) {
 return <span aria-hidden="true" className={`network-provider-mark ${provider}${large ? " network-provider-large" : ""}`}>
  <Image src={`/brands/${provider}.svg`} alt="" width={32} height={32} unoptimized className="network-brand-default" />
  {provider === "tavily" && <Image src="/brands/tavily-dark.svg" alt="" width={32} height={32} unoptimized className="network-brand-dark" />}
 </span>;
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
 return <button type="button" role="switch" aria-label={label} aria-checked={checked} disabled={disabled} className="network-switch" onClick={() => onChange(!checked)}><span /></button>;
}
function Picker({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
 return <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{children}</SelectContent></Select>;
}
function Tabs({ label, selected, items, onChange }: { label: string; selected: string; items: { id: string; content: ReactNode }[]; onChange: (id: string) => void }) {
 return <div role="tablist" aria-label={label} className="network-tabs">{items.map((item, index) => <button key={item.id} type="button" role="tab" id={`network-tab-${item.id}`} aria-selected={selected === item.id} aria-controls={`network-panel-${label === "联网设置" ? "section" : "provider"}`} tabIndex={selected === item.id ? 0 : -1} onClick={() => onChange(item.id)} onKeyDown={event => {
  const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (!offset && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + offset + items.length) % items.length;
  onChange(items[next].id);
  (event.currentTarget.parentElement?.children[next] as HTMLButtonElement)?.focus();
 }}>{item.content}</button>)}</div>;
}
export function WebResearchSettingsPanel() {
 const [view, setView] = useState<WebResearchView | null>(null);
 const [config, setConfig] = useState<WebResearchConfig | null>(null);
 const [grants, setGrants] = useState<Record<string, WebResearchGrant>>({});
 const [keys, setKeys] = useState<Partial<Record<WebSearchProvider, string>>>({});
 const [section, setSection] = useState("providers");
 const [provider, setProvider] = useState<WebSearchProvider>("tavily");
 const [filter, setFilter] = useState("");
 const [busy, setBusy] = useState<string | null>(null);
 const busyRef = useRef(false);
 const readGeneration = useRef(0);
 const [error, setError] = useState<string | null>(null);
 const dirty = Boolean(config && view && (JSON.stringify(config) !== JSON.stringify(view.settings) || JSON.stringify(grants) !== JSON.stringify(view.grants) || Object.keys(keys).length));
 const apply = (next: WebResearchView) => { setView(next); setConfig(next.settings); setGrants(next.grants); setKeys({}); };
 async function load() { if (busyRef.current) return; const generation = ++readGeneration.current; setError(null); try { const next=await getWebResearchSettings(); if (generation === readGeneration.current && !busyRef.current) apply(next); } catch (e) { if (generation === readGeneration.current) setError(e instanceof Error ? e.message : "加载失败"); } }
 useEffect(() => { let active = true; const generation=++readGeneration.current; getWebResearchSettings().then(next => { if (active && generation === readGeneration.current && !busyRef.current) apply(next); }).catch(e => { if (active && generation === readGeneration.current) setError(e instanceof Error ? e.message : "加载失败"); }); return () => { active = false; }; }, []);
 useEffect(() => {
  let active=true;
  const refresh = async (changed:boolean) => {
   if (busyRef.current) return;
   if (dirty) { if (changed) setError("联网设置已在其他页面更新。当前修改仍保留，请读取最新设置核对后再保存。"); return; }
   const generation=++readGeneration.current;
   try { const next=await getWebResearchSettings(); if (active && generation===readGeneration.current && !busyRef.current) apply(next); }
   catch(e) { if (active && generation===readGeneration.current) setError(e instanceof Error ? e.message : "加载失败"); }
  };
  const changed=()=>{void refresh(true);};
  const focus=()=>{void refresh(false);};
  const storage=(event:StorageEvent)=>{if(event.key===WEB_RESEARCH_REVISION_KEY)void refresh(true);};
  window.addEventListener(WEB_RESEARCH_CHANGED_EVENT,changed);window.addEventListener("storage",storage);window.addEventListener("focus",focus);
  return()=>{active=false;window.removeEventListener(WEB_RESEARCH_CHANGED_EVENT,changed);window.removeEventListener("storage",storage);window.removeEventListener("focus",focus);};
 }, [dirty]);
 async function save() {
  if (!view || !config || busyRef.current) return;
  busyRef.current = true; readGeneration.current++; setBusy("save"); setError(null);
  try { apply(await saveWebResearchSettings({ expectedRevision: view.revision, settings: config, keys, grants })); toast.success("联网设置与 Worker 授权已保存"); }
  catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
  finally { busyRef.current = false; setBusy(null); }
 }
 async function test() {
  if (!view || !config || busyRef.current || !(keys[provider]?.trim() || view.providers[provider].configured)) return;
  busyRef.current = true; readGeneration.current++; setBusy(provider); setError(null);
  try {
   const next = await testAndSaveWebResearchProvider(provider,{ expectedRevision: view.revision, settings: config, keys, grants });
   apply(next); toast.success(`${names[provider]} 搜索测试通过，设置已保存`);
  }
  catch (e) { setError(e instanceof Error ? e.message : "测试并保存失败，请读取最新设置核对"); }
  finally { busyRef.current = false; setBusy(null); }
 }
 if (!config || !view) return <section className="settings-card">{error ? <div role="alert"><p>{error}</p><Button variant="outline" onClick={() => void load()}>重新加载</Button></div> : <p role="status">正在加载联网设置…</p>}</section>;
 const patch = (value: Partial<WebResearchConfig>) => setConfig({ ...config, ...value });
 const patchProvider = (value: Partial<WebResearchConfig["providers"][WebSearchProvider]>) => patch({ providers: { ...config.providers, [provider]: { ...config.providers[provider], ...value } } });
 const info = view.providers[provider];
 const item = config.providers[provider];
 const supported = view.targets.filter(target => target.supported);
 const unsupported = view.targets.filter(target => !target.supported);
 const authorized = supported.filter(target => grants[target.id]?.search || grants[target.id]?.fetch).length;
 const shown = supported.filter(target => `${target.name} ${target.id}`.toLowerCase().includes(filter.toLowerCase()));
 const readyCount = providers.filter(p => config.providers[p].enabled && view.providers[p].test?.status === "ready").length;
 const patchGrant = (id: string, value: Partial<WebResearchGrant>) => setGrants(old => ({ ...old, [id]: { ...(old[id] ?? { search: false, fetch: false }), ...value } }));
 return <div className="network-settings">
  <div className="network-capabilities">
   <div className="network-capability"><span className="network-icon"><SearchIcon /></span><div><h3>联网搜索</h3><p>查找实时信息 · {readyCount} 家供应商就绪</p></div><Toggle label="启用联网搜索" checked={config.enabled} disabled={Boolean(busy)} onChange={enabled => patch({ enabled })} /></div>
   <div className="network-capability"><span className="network-icon"><FileTextIcon /></span><div><h3>网页阅读</h3><p>读取指定 URL 正文，无需搜索密钥</p></div><Toggle label="启用网页阅读 fetch_url" checked={config.fetchEnabled} disabled={Boolean(busy)} onChange={fetchEnabled => patch({ fetchEnabled })} /></div>
  </div>
  <div className="network-section-heading">
   <Tabs label="联网设置" selected={section} onChange={setSection} items={[{ id: "providers", content: <><GlobeIcon />搜索供应商</> }, { id: "workers", content: <><ShieldCheckIcon />Worker 授权<span className="network-count">{authorized}</span></> }]} />
   <div className="network-header-actions"><Button size="sm" disabled={!dirty || Boolean(busy)} onClick={() => void save()}>{busy === "save" && <LoaderIcon className="size-3 animate-spin" />}{busy === "save" ? "保存中…" : "保存设置"}</Button></div>
  </div>
  <div role="tabpanel" id="network-panel-section" aria-labelledby={`network-tab-${section}`}>
  {section === "providers" ? <>
   <section className="settings-card network-provider-card" aria-label="搜索供应商配置">
    <Tabs label="搜索供应商" selected={provider} onChange={id => setProvider(id as WebSearchProvider)} items={providers.map(id => ({ id, content: <><ProviderMark provider={id} />{names[id]}<span className="network-dot" data-status={view.providers[id].test?.status ?? "unset"} /></> }))} />
    <div role="tabpanel" id="network-panel-provider" aria-labelledby={`network-tab-${provider}`} className="network-provider-body">
     <div className="network-provider-heading"><ProviderMark provider={provider} large /><div><h3>{names[provider]}<span className="network-status" data-status={info.test?.status ?? "unset"}>{info.test?.status === "ready" ? "已通过测试" : info.test?.status === "error" ? "测试未通过" : "待测试"}</span></h3><p>{descriptions[provider]}</p></div><Toggle label={`启用 ${names[provider]}`} checked={item.enabled} disabled={Boolean(busy)} onChange={enabled => patchProvider({ enabled })} /></div>
     <fieldset disabled={Boolean(busy)} className="network-provider-fields">
      <label className="network-field"><span><KeyRoundIcon />API Key</span><Input type="password" autoComplete="new-password" aria-label={`${names[provider]} API Key`} value={keys[provider] ?? ""} placeholder={info.configured ? info.credentialSource === "model" ? "沿用模型页密钥，输入可单独覆盖" : "已配置，留空保留" : "输入 API Key"} onChange={e => setKeys(old => { const next = { ...old }; if (e.target.value) next[provider] = e.target.value; else delete next[provider]; return next; })} /><div className="network-field-note"><span>{keys[provider] === "" ? "保存后清除独立密钥" : keys[provider]?.trim() ? "当前输入待验证，通过后加密保存" : info.credentialSource === "model" ? "已沿用模型页凭据" : info.configured ? "密钥已加密保存" : "尚未配置密钥"}</span>{info.credentialSource === "network" && <button type="button" onClick={() => setKeys(old => ({ ...old, [provider]: "" }))}>清除独立密钥</button>}</div></label>
      <label className="network-field"><span><Settings2Icon />{provider === "tavily" ? "搜索深度" : "搜索模型"}</span>{provider === "tavily" ? <Picker label="Tavily 搜索深度" value={item.searchDepth ?? "basic"} onChange={searchDepth => patchProvider({ searchDepth: searchDepth as "basic" | "advanced" })}><SelectItem value="basic">基础 · 快速检索</SelectItem><SelectItem value="advanced">深入 · 更完整的内容</SelectItem></Picker> : <Input aria-label={`${names[provider]} 搜索模型`} value={item.model} onChange={e => patchProvider({ model: e.target.value })} />}<span className="network-field-note">{provider === "tavily" ? "深入搜索可能消耗更多额度" : "需要模型支持真实的服务端搜索"}</span></label>
     </fieldset>
     {provider === "grok" && <div className="network-grok-sources"><label>网页搜索<Toggle label="Grok 网页搜索" checked={Boolean(item.webEnabled)} disabled={Boolean(busy)} onChange={webEnabled => patchProvider({ webEnabled })} /></label><label>X 搜索<Toggle label="Grok X 搜索" checked={Boolean(item.xEnabled)} disabled={Boolean(busy)} onChange={xEnabled => patchProvider({ xEnabled })} /></label></div>}
     <div className="network-test"><div><p role="status">{dirty ? <ShieldCheckIcon /> : info.test?.status === "ready" ? <CheckCircle2Icon className="text-emerald-600" /> : info.test?.status === "error" ? <AlertCircleIcon className="text-destructive" /> : <ShieldCheckIcon />}<span>{dirty ? "当前修改尚未验证" : info.test?.status === "ready" ? "真实搜索已验证，可参与自动路由" : info.test?.status === "error" ? "未验证到可用的联网搜索" : "配置后测试，通过才加入自动路由"}</span></p><small>先测试当前配置，通过后保存本页修改；可能产生供应商费用。</small></div><Button size="sm" variant="outline" disabled={Boolean(busy) || !(keys[provider]?.trim() || info.configured)} onClick={() => void test()}>{busy === provider ? <LoaderIcon className="size-3 animate-spin" /> : <SearchIcon className="size-3" />}{busy === provider ? "测试并保存中…" : "测试并保存"}</Button></div>
     {info.test && <details className="network-test-detail"><summary>查看最近测试结果</summary><p>{info.test.message}</p><small>{new Date(info.test.checkedAt).toLocaleString("zh-CN")}</small></details>}
    </div>
   </section>
   <details className="settings-card network-advanced"><summary><span><Settings2Icon />路由与高级设置</span><small>{config.defaultScope === "global" ? "全球" : "国内"}优先 · {config.fallbackEnabled ? "自动回退" : "不回退"}</small><ChevronDownIcon /></summary><fieldset disabled={Boolean(busy)} className="network-advanced-fields">
    <label className="network-field"><span>默认搜索范围</span><Picker label="默认搜索范围" value={config.defaultScope} onChange={defaultScope => patch({ defaultScope: defaultScope as "domestic" | "global" })}><SelectItem value="global">全球公网</SelectItem><SelectItem value="domestic">国内公网</SelectItem></Picker></label>
    <label className="network-field"><span>最大供应商尝试次数</span><Picker label="最大供应商尝试次数" value={String(config.maxProviderAttempts)} onChange={value => patch({ maxProviderAttempts: Number(value) })}>{[1, 2, 3].map(n => <SelectItem key={n} value={String(n)}>{n} 家</SelectItem>)}</Picker></label>
    {(["domesticOrder", "globalOrder"] as const).map(field => <label key={field} className="network-field"><span>{field === "domesticOrder" ? "国内搜索顺序" : "全球搜索顺序"}</span><Picker label={field === "domesticOrder" ? "国内搜索顺序" : "全球搜索顺序"} value={config[field].join(",")} onChange={value => patch({ [field]: value.split(",") as WebSearchProvider[] })}>{orders.map(order => <SelectItem key={order.join(",")} value={order.join(",")}>{order.map(p => names[p]).join(" → ")}</SelectItem>)}</Picker></label>)}
    <label className="network-option">失败自动回退<Toggle label="搜索失败时自动回退" checked={config.fallbackEnabled} disabled={Boolean(busy)} onChange={fallbackEnabled => patch({ fallbackEnabled })} /></label>
    <label className="network-option">允许任务请求多源核验<Toggle label="允许多源核验" checked={config.crossCheckEnabled} disabled={Boolean(busy)} onChange={crossCheckEnabled => patch({ crossCheckEnabled })} /></label>
    <label className="network-field network-full"><span>HTTP(S) 代理（可选）</span><Input aria-label="HTTP(S) 代理" placeholder="留空直接连接，如 http://127.0.0.1:7890" value={config.proxyUrl} onChange={e => patch({ proxyUrl: e.target.value })} /></label>
   </fieldset></details>
  </> : <section className="settings-card network-workers" aria-label="Worker 联网授权">
   <div className="network-workers-heading"><div><h3>选择可以联网的智能体</h3><p>分别授权搜索与网页阅读，保存后在下一轮对话生效。</p></div><span className="network-status">{authorized} / {supported.length} 已授权</span></div>
   <div className="network-access-tip"><ShieldCheckIcon /><p>搜索需要上方总开关开启、供应商启用并通过测试。网页阅读只需开启总开关与对应授权。停用的智能体也可配置，启用后才能使用。</p></div>
   {supported.length > 6 && <Input aria-label="筛选 Worker" placeholder="搜索 Worker 名称…" value={filter} onChange={event => setFilter(event.target.value)} />}
   <div className="network-worker-table"><div className="network-worker-columns"><span>智能体</span><span>联网搜索</span><span>网页阅读</span></div><div className="network-worker-list">{shown.map(target => <div className="network-worker-row" key={target.id}><div className="network-worker-identity"><span className="network-worker-avatar">{target.kind === "manager" ? <SparklesIcon /> : <BotIcon />}</span><div><strong>{target.name}</strong><small>{target.kind === "manager" ? "Manager · 仅独立对话" : "Pi Worker"}{!target.enabled ? " · 已停用" : ""}</small></div></div><Toggle label={`${target.name} 联网搜索`} checked={Boolean(grants[target.id]?.search)} disabled={Boolean(busy)} onChange={search => patchGrant(target.id, { search })} /><Toggle label={`${target.name} 网页阅读`} checked={Boolean(grants[target.id]?.fetch)} disabled={Boolean(busy)} onChange={fetch => patchGrant(target.id, { fetch })} /></div>)}{!shown.length && <p className="network-empty">{supported.length ? "未找到匹配的 Worker" : "暂无可授权的 Pi Worker"}</p>}</div></div>
   {unsupported.length > 0 && <details className="network-unsupported"><summary>其他智能体 · {unsupported.length}<ChevronDownIcon /></summary>{unsupported.map(target => <div key={target.id}><strong>{target.name}</strong><span>{target.reason}</span></div>)}</details>}
  </section>}
  </div>
  {error && <div className="network-error" role="alert"><AlertCircleIcon /><p>{error}</p><Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => void load()}>重新读取</Button></div>}
  <div className="network-save-bar"><span>{dirty ? section === "providers" ? "有未保存的修改，可直接测试并保存" : "有未保存的修改，请点击上方保存设置" : "密钥统一管理 · 联网按 Worker 授权"}</span></div>
 </div>;
}
