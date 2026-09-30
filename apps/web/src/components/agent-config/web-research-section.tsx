"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileTextIcon, GlobeIcon, LoaderIcon, RefreshCwIcon, SearchIcon, ShieldCheckIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getWebResearchSettings, putWorkerWebResearchGrant, WEB_RESEARCH_CHANGED_EVENT, WEB_RESEARCH_REVISION_KEY, type WebResearchGrant, type WebResearchView } from "@/lib/api";
import type { AgentConfig } from "@/lib/types";

export function WebResearchSection({ agent }: { agent: AgentConfig }) {
 const [view, setView] = useState<WebResearchView | null>(null);
 const [error, setError] = useState<string | null>(null);
 const [saving, setSaving] = useState(false);
 const [locked, setLocked] = useState(false);
 const busyRef = useRef(false);
 const readGeneration = useRef(0);
 const read = useCallback(async () => {
  if (busyRef.current) return;
  const generation = ++readGeneration.current;
  try {
   const next = await getWebResearchSettings();
   if (generation !== readGeneration.current || busyRef.current) return;
   setView(next); setError(null); setLocked(false);
  } catch (e) {
   if (generation !== readGeneration.current) return;
   setError(e instanceof Error ? e.message : "联网授权读取失败"); setLocked(true);
  }
 }, []);
 useEffect(() => {
  let active = true;
  const generation = ++readGeneration.current;
  const invalidateReads = () => { readGeneration.current++; };
  getWebResearchSettings().then(next => {
   if (active && generation === readGeneration.current && !busyRef.current) { setView(next); setError(null); setLocked(false); }
  }).catch(e => {
   if (active && generation === readGeneration.current) { setError(e instanceof Error ? e.message : "联网授权读取失败"); setLocked(true); }
  });
  const storage = (event: StorageEvent) => { if (event.key === WEB_RESEARCH_REVISION_KEY) void read(); };
  const refresh = () => { void read(); };
  window.addEventListener(WEB_RESEARCH_CHANGED_EVENT, refresh);
  window.addEventListener("storage", storage);
  window.addEventListener("focus", refresh);
  return () => { active = false; invalidateReads(); window.removeEventListener(WEB_RESEARCH_CHANGED_EVENT, refresh); window.removeEventListener("storage", storage); window.removeEventListener("focus", refresh); };
 }, [agent.name, agent.enabled, read]);
 const target = view?.targets.find(target => target.id === agent.name);
 const grant = view?.grants[agent.name] ?? { search: false, fetch: false };
 const supported = Boolean(target?.supported);
 const ready = view ? (["tavily", "deepseek", "grok"] as const).some(provider => view.settings.providers[provider].enabled && view.providers[provider].test?.status === "ready") : false;
 const canEdit = Boolean(view && supported && !locked && !saving);
 async function change(field: keyof WebResearchGrant, checked: boolean) {
  if (!view || !canEdit || busyRef.current) return;
  busyRef.current = true; readGeneration.current++; setSaving(true); setError(null);
  try {
   const next = await putWorkerWebResearchGrant(agent.name, { ...grant, [field]: checked }, view.revision);
   setView(next); setLocked(false); toast.success("联网授权已保存，与设置页同步");
  } catch (e) {
   setLocked(true);
   setError(`${e instanceof Error ? e.message : "保存失败"}。请读取最新状态核对后重试。`);
  } finally { busyRef.current = false; setSaving(false); }
 }
 return <section className="agent-config-card" aria-label="此智能体的联网授权">
  <div className="agent-config-card-head has-action"><div><h2 className="flex items-center gap-2"><GlobeIcon className="size-4 text-primary" />联网能力</h2><p>开关修改后自动保存，与「设置 → 联网 → Worker 授权」共用同一份配置。</p><p>供应商与密钥在 <Link href="/settings?section=network" className="agent-config-text-link">设置 → 联网</Link> 管理。</p></div><div className="agent-config-section-actions"><span className="agent-config-muted-note" role="status">{saving ? <><LoaderIcon className="size-3 animate-spin" />保存中…</> : !view ? "正在读取…" : supported ? "按智能体授权" : "上游能力"}</span><Button type="button" size="icon" variant="ghost" aria-label="刷新联网授权" disabled={saving} onClick={() => void read()}><RefreshCwIcon className="size-3.5" /></Button></div></div>
  {error && <div className="agent-config-callout is-warning" role="alert">{error}<Button type="button" size="sm" variant="outline" className="ml-3" disabled={saving} onClick={() => void read()}>读取最新状态</Button></div>}
  {!view ? <p className="agent-config-muted-note">{error ? "确认最新状态前不能修改授权。" : "正在确认联网授权…"}</p> : !supported ? <div className="agent-config-empty">{target?.reason ?? "此智能体当前不支持平台联网工具"}。平台开关不能控制此接入。</div> : <>
   <label className="agent-config-toggle"><span><strong><span className="inline-flex items-center gap-2"><SearchIcon className="size-3.5 text-primary" />联网搜索</span></strong><small>搜索实时信息并返回可引用的来源。{!view.settings.enabled ? "平台搜索总开关已关闭。" : !ready ? "尚无启用且通过测试的搜索供应商。" : "平台搜索供应商已就绪。"}</small></span><input type="checkbox" role="switch" aria-label="授权联网搜索" checked={grant.search} disabled={!canEdit} onChange={event => void change("search", event.target.checked)} /></label>
   <label className="agent-config-toggle"><span><strong><span className="inline-flex items-center gap-2"><FileTextIcon className="size-3.5 text-primary" />网页阅读</span></strong><small>读取指定 URL 的网页正文（fetch_url），无需搜索密钥。{!view.settings.fetchEnabled ? "平台网页阅读总开关已关闭。" : "平台网页阅读已开启。"}</small></span><input type="checkbox" role="switch" aria-label="授权网页阅读" checked={grant.fetch} disabled={!canEdit} onChange={event => void change("fetch", event.target.checked)} /></label>
   <p className="agent-config-toggle-note flex items-start gap-2 mt-3"><ShieldCheckIcon className="size-3.5 shrink-0 mt-0.5" /><span>{agent.enabled === false ? "智能体已停用，授权会保留，启用后才可使用。" : agent.pinned ? "仅在 Manager 独立对话使用。" : "新增工具在下一轮对话装载，撤销授权立即阻止工具调用。"}</span></p>
  </>}
 </section>;
}
