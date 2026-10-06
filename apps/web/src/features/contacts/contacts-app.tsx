"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeftIcon, ArrowUpRightIcon, ChevronDownIcon, FileTextIcon, LibraryIcon, MapPinIcon, PlusIcon, RefreshCwIcon, SearchIcon, ShieldCheckIcon, UsersIcon, NetworkIcon, ListIcon, XIcon } from "lucide-react";
import { SectionTopbar } from "@/components/section-topbar";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { listKnowledgeBindings, setInteractionStatus, type InteractionStatusValue, type KnowledgeBindingSummary } from "@/lib/api";
import { contactsRequest, type ContactsList, type ContactDetail, type ContactRelation, type ContactSource } from "@/lib/contacts";
import { WikiCuratorDialog } from "@/features/knowledge/curator-dialog";
import styles from "./contacts.module.css";
import { ContactsGraph } from "./contacts-graph";
import { AvatarEditButton, ContactAvatarEditor } from "./contact-avatar";
import { ContactNameList } from "./contact-name-list";
import { groupContactsByName } from "@/lib/contact-name-index";
const dateLabel = (date: string | null) => date ? date.slice(0, 10) : "未记录";
const shown = (text: string) => text || "未记录";
type SourceRead = { person: string; vault: string; source: ContactSource; content?: string; error?: string; snippet?: string };
const interactionKinds = ["involves", "has_participant", "participants"];
const statusLabels: Record<InteractionStatusValue, string> = { planned: "计划", done: "已完成", cancelled: "已取消" };
const relationStatus = (item: ContactRelation): InteractionStatusValue | "unknown" =>
 item.occurredAt ? "done" : item.label === "计划" || item.label === "逾期" ? "planned" : item.label === "已取消" ? "cancelled" : "unknown";
const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
function RelatedRows({ items, onOpen, renderStatus }: { items: ContactRelation[]; onOpen: (source: ContactSource, snippet?: string) => Promise<void>; renderStatus?: (item: ContactRelation) => ReactNode }) {
 return items.map((item, index) => {
  const row = <button className={styles.related} key={`${item.source.path}-${item.kind}-${index}`} onClick={() => void onOpen(item.source, item.snippet)}><span className={styles.noteIcon}><FileTextIcon size={18} /></span><span><strong>{item.source.title}</strong><small>{item.label} · {item.source.path}</small></span><ArrowUpRightIcon size={14} /></button>;
  return renderStatus ? <div className={styles.relatedRow} key={`${item.source.path}-${item.kind}-${index}`}>{row}{renderStatus(item)}</div> : row;
 });
}

export function ContactsApp() {
 const router = useRouter(), params = useSearchParams();
 const vault = params.get("vault") ?? "", requestedPerson = params.get("person") ?? "", tab = params.get("tab") ?? "overview", graphMode = params.get("view") === "graph";
 const [bindings, setBindings] = useState<KnowledgeBindingSummary[] | null>(null), [bindingsError, setBindingsError] = useState("");
 const [data, setData] = useState<(ContactsList & { graphView: boolean }) | null>(null), [error, setError] = useState(""), [loading, setLoading] = useState(false);
 const [personState, setPersonState] = useState<{ key: string; value?: ContactDetail; error?: string } | null>(null);
 const [q, setQ] = useState(""), [group, setGroup] = useState(""), [sort, setSort] = useState("name");
 const [sourceDialog, setSourceDialog] = useState(false), [curatorOpen, setCuratorOpen] = useState(false), [rulesOpen, setRulesOpen] = useState(false), [sourceRead, setSourceRead] = useState<SourceRead | null>(null);
 const [retry, setRetry] = useState(0);
 const [avatarPerson, setAvatarPerson] = useState<{ vault: string; person: ContactDetail } | null>(null), [avatarWarning, setAvatarWarning] = useState("");
 const serial = useRef(0), sourceSerial = useRef(0), markedLine = useRef<HTMLDivElement>(null);
 const selected = bindings?.find(binding => binding.id === vault && binding.availability === "available");
 const navigate = useCallback((nextVault: string, person = "", nextTab = "overview", nextView = graphMode ? "graph" : "list") => { const query = new URLSearchParams(); if (nextView === "graph") query.set("view", "graph"); if (nextVault) query.set("vault", nextVault); if (person) query.set("person", person); if (nextTab !== "overview") query.set("tab", nextTab); router.replace(`/contacts?${query}`); }, [router, graphMode]);
 useEffect(() => {
  let active = true;
  void listKnowledgeBindings().then(items => {
   if (!active) return; setBindings(items); setBindingsError("");
   if (!vault) {
    let saved = ""; try { saved = localStorage.getItem("puddingteams:contacts-vault") ?? ""; } catch {}
    const usable = items.filter(binding => binding.availability === "available");
    const people = usable.filter(binding => binding.schemaRef?.id === "people" || binding.schemaRef?.originPresetId === "people");
    const initial = usable.find(binding => binding.id === saved) ?? (people.length === 1 ? people[0] : undefined);
    if (initial) navigate(initial.id);
   }
  }).catch(cause => { if (active) { setBindings(null); setBindingsError(cause instanceof Error ? cause.message : "知识库读取失败"); } });
  return () => { active = false; };
 }, [vault, retry, navigate]);
 const load = useCallback(async () => {
  if (!vault) return;
  const request = ++serial.current; setLoading(true); setError(""); setPersonState(null); setSourceRead(null); sourceSerial.current++;
  try {
   const query = new URLSearchParams({ vault, q, group, sort });
   const next = await contactsRequest<ContactsList>(`${graphMode ? "/graph" : ""}?${query}`);
   if (request === serial.current) setData({ ...next, graphView: graphMode });
  } catch (cause) { if (request === serial.current) { setData(null); setError(cause instanceof Error ? cause.message : "通讯录加载失败"); } }
  finally { if (request === serial.current) setLoading(false); }
 }, [vault, q, group, sort, graphMode]);
 useEffect(() => {
  const requests = serial;
  const timer = window.setTimeout(() => void load(), q ? 250 : 0);
  return () => { clearTimeout(timer); requests.current++; };
 }, [load, retry, q]);
 useEffect(() => {
  const refresh = () => { if (!document.hidden) void load(); };
  const timer = window.setInterval(refresh, 30_000);
  window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
  return () => { clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
 }, [load]);
 const currentData = data?.vault === vault && data.graphView === graphMode ? data : null;
 const firstContactId = useMemo(() => sort === "name" ? groupContactsByName(currentData?.people ?? [])[0]?.people[0]?.id : currentData?.people[0]?.id, [currentData?.people, sort]);
 const activeId = requestedPerson || (!graphMode ? firstContactId : "") || "";
 const detailKey = JSON.stringify([vault, activeId, currentData?.revision]);
 useEffect(() => {
  if (!currentData || !activeId) return;
  let active = true;
  const query = new URLSearchParams({ vault, revision: String(currentData.revision) });
  void contactsRequest<{ person: ContactDetail }>(`/${encodeURIComponent(activeId)}?${query}`).then(next => { if (active) setPersonState({ key: detailKey, value: next.person }); }).catch(cause => { if (active) setPersonState({ key: detailKey, error: cause instanceof Error ? cause.message : "人物资料加载失败" }); });
  return () => { active = false; };
 }, [detailKey, activeId, vault, currentData]);
 const person = !loading && personState?.key === detailKey ? personState.value : undefined;
 const detailError = personState?.key === detailKey ? personState.error : undefined;
 const chooseVault = (id: string) => { sourceSerial.current++; setSourceRead(null); setCuratorOpen(false); setQ(""); setGroup(""); setSourceDialog(false); try { localStorage.setItem("puddingteams:contacts-vault", id); } catch {} navigate(id); };
 const openSource = async (source: ContactSource, snippet?: string) => {
  if (!person) return;
  const request = ++sourceSerial.current, reading = { vault, person: person.id, source, snippet };
  setSourceRead(reading);
  try {
   const query = new URLSearchParams({ vault, path: source.path, hash: source.contentHash });
   const result = await contactsRequest<{ source: ContactSource & { content: string } }>(`/${encodeURIComponent(person.id)}/source?${query}`);
   if (request === sourceSerial.current) setSourceRead({ ...reading, content: result.source.content });
  } catch (cause) { if (request === sourceSerial.current) setSourceRead({ ...reading, error: cause instanceof Error ? cause.message : "来源读取失败" }); }
 };
 useEffect(() => { markedLine.current?.scrollIntoView({ block: "center" }); }, [sourceRead?.content]);
 const wikiHref = `/knowledge?vault=${encodeURIComponent(vault)}`;
 const dated = person?.relations.filter(item => item.occurredAt).sort((a, b) => Date.parse(b.occurredAt!) - Date.parse(a.occurredAt!)) ?? [];
 const undated = person?.relations.filter(item => !item.occurredAt && ["involves", "has_participant", "participants"].includes(item.kind)) ?? [];
 const related = person?.relations ?? [];
 const refresh = () => { setRetry(value => value + 1); };
 const [statusPending, setStatusPending] = useState(false), [statusError, setStatusError] = useState("");
 const [statusTarget, setStatusTarget] = useState<ContactRelation | null>(null), [statusDate, setStatusDate] = useState("");
 const submitStatus = async (item: ContactRelation, status: InteractionStatusValue, occurredAt?: string) => {
  setStatusPending(true); setStatusError("");
  try { await setInteractionStatus(vault, item.source.path, status, occurredAt); setStatusTarget(null); refresh(); }
  catch (cause) { setStatusError(cause instanceof Error ? cause.message : "往来状态更新失败，请重试"); }
  finally { setStatusPending(false); }
 };
 const renderInteractionStatus = (item: ContactRelation) => <div className={styles.statusSwitch} role="group" aria-label="往来状态">
  {(["planned", "done", "cancelled"] as const).map(value => <button key={value} type="button" aria-pressed={relationStatus(item) === value} disabled={statusPending} onClick={() => {
   if (statusPending || value === relationStatus(item)) return;
   if (value === "done" && !item.occurredAt) { setStatusError(""); setStatusDate(todayLocal()); setStatusTarget(item); return; }
   void submitStatus(item, value, value === "done" ? item.occurredAt ?? undefined : undefined);
  }}>{statusLabels[value]}</button>)}
  {item.label === "逾期" && <span className={styles.statusOverdue}>已逾期，请确认是否发生</span>}
  {relationStatus(item) === "unknown" && <span className={styles.statusUnknown}>往来日期或状态未确认</span>}
 </div>;
 return <><SectionTopbar title="通讯录" /><section className={styles.page} aria-label="个人通讯录">
  <header className={styles.heading}><div><div className={styles.eyebrow}>PEOPLE & CONNECTIONS</div><h1>通讯录</h1><p>从认识一个人，到记住你们一起做过的事。</p></div><div className={styles.actions}><button aria-label="选择通讯录资料来源" onClick={() => setSourceDialog(true)}><LibraryIcon size={15} />{selected?.name ?? "选择人脉知识库"}<ChevronDownIcon size={13} /></button><button aria-label="刷新通讯录" onClick={refresh} disabled={loading}><RefreshCwIcon size={15} /></button></div></header>
  <div className={styles.notice}><ShieldCheckIcon size={15} /><span>人物资料来自 Wiki 当前可访问版本</span>{vault && <button onClick={() => setCuratorOpen(true)} disabled={!selected}><PlusIcon size={13} />整理人物资料</button>}</div>
  <div className={styles.viewBar}><div className={styles.viewSwitch} aria-label="通讯录视图"><button aria-pressed={!graphMode} onClick={() => navigate(vault, requestedPerson, tab, "list")}><ListIcon size={15} />列表</button><button aria-pressed={graphMode} onClick={() => navigate(vault, requestedPerson, tab, "graph")}><NetworkIcon size={15} />人脉图谱</button></div><span>{graphMode ? "点击连线，查看两人的共同往来" : "人物档案与往来记录"}</span></div>
  {bindingsError || error ? <div className={styles.empty} role="alert"><h2>通讯录暂时不可用</h2><p>{bindingsError || error}</p><button onClick={refresh}>重试读取</button><button onClick={() => setSourceDialog(true)}>更换资料来源</button></div> : !vault ? <div className={styles.empty}><UsersIcon size={38} /><h2>把人脉知识库连接到通讯录</h2><p>选择已初始化的人脉知识库。没有人物笔记时，会显示空通讯录。</p><button className={styles.primary} onClick={() => setSourceDialog(true)}>选择资料来源</button><Link href="/knowledge/connect">接入本地 Wiki <ArrowUpRightIcon size={13} /></Link></div> : !currentData ? <div className={styles.empty} role="status">正在读取人物资料…</div> : currentData.total === 0 ? <div className={styles.empty}><UsersIcon size={38} /><h2>人脉知识库已连接，还没有人物资料</h2><p>录入你提供的姓名、认识经过或往来素材，整理为人物笔记。审核发布后，这里会显示人物档案。</p><button className={styles.primary} onClick={() => setCuratorOpen(true)} disabled={!selected}>整理第一位人物资料</button><Link href={wikiHref}>查看人脉知识库 <ArrowUpRightIcon size={13} /></Link></div> : <div className={styles.layout} data-person-open={Boolean(requestedPerson)} data-view={graphMode ? "graph" : "list"}>
   {graphMode ? <ContactsGraph key={vault} vault={vault} revision={currentData.revision} self={currentData.self} people={currentData.people} edges={currentData.edges ?? []} selectedId={requestedPerson} onSelect={id => navigate(vault, id)} q={q} onSearch={setQ} group={group} onGroup={setGroup} groups={currentData.groups} matched={currentData.matched} truncated={currentData.truncated} loading={loading} /> : <aside className={styles.list}><div className={styles.controls}><label className={styles.search}><SearchIcon size={16} /><input aria-label="搜索联系人" value={q} onChange={event => setQ(event.target.value)} placeholder="搜索姓名、公司、话题" /></label><div className={styles.filters}><select aria-label="联系人分组" value={group} onChange={event => setGroup(event.target.value)}><option value="">全部分组</option>{currentData.groups.map(value => <option key={value}>{value}</option>)}</select><select aria-label="联系人排序" value={sort} onChange={event => setSort(event.target.value)}><option value="name">姓名 A–Z</option><option value="recent">最近联系</option></select></div><div className={styles.caption}><span>{loading ? "正在刷新…" : "联系人"}</span><span>{currentData.matched}</span></div></div>
    <ContactNameList vault={vault} people={currentData.people} activeId={activeId} alphabetical={sort === "name"} resetKey={JSON.stringify([vault, q, group, sort])} truncated={currentData.truncated} onSelect={id => navigate(vault, id)} onClear={() => { setQ(""); setGroup(""); }} /><Link className={styles.sourceLink} href={wikiHref}><LibraryIcon size={15} />查看来源知识库<ArrowUpRightIcon size={12} /></Link>
   </aside>}
   <article className={styles.detail}>{graphMode && <button className={styles.closeGraphDetail} aria-label="关闭人物资料" onClick={() => navigate(vault)}><XIcon size={17} /></button>}<button className={styles.back} onClick={() => navigate(vault)}><ArrowLeftIcon size={15} />{graphMode ? "返回人脉图谱" : "返回联系人列表"}</button>{detailError ? <div role="alert"><h2>人物资料暂时不可用</h2><p>{detailError}</p><button onClick={refresh}>刷新通讯录</button></div> : !person ? <p role="status">正在读取人物档案…</p> : <>
    <div className={styles.profile}><AvatarEditButton vault={vault} person={person} onClick={() => { setAvatarWarning(""); setAvatarPerson({ vault, person }); }} /><div><h2>{person.name}</h2><p>{shown(person.company)} · {shown(person.role)}</p><small><MapPinIcon size={13} />{shown(person.location)}<span>最近联系：{dateLabel(person.lastContact)}</span></small></div><button className={styles.original} onClick={() => void openSource(person.source)}><FileTextIcon size={16} />来源笔记<ArrowUpRightIcon size={12} /></button></div>
    <div className={styles.tags}>{[...person.groups, ...person.topics].map((value, index) => <span key={`${value}-${index}`}>{value}</span>)}</div>
    <div className={styles.tabs} aria-label="人物资料视图">{[["overview", "概览"], ["timeline", "往来记录"], ["related", "关联资料"]].map(([id, label]) => <button key={id} aria-pressed={tab === id} onClick={() => navigate(vault, person.id, id)}>{label}{id === "timeline" ? ` · ${dated.length}` : id === "related" ? ` · ${related.length}` : ""}</button>)}</div>
    {tab === "timeline" ? <section className={styles.tabContent}><h3>每次联系，留下一点上下文。</h3><p>仅按明确记录且已发生的往来日期排列。</p>{statusError && !statusTarget && <p role="alert" className={styles.avatarError}>{statusError}</p>}{dated.map((item, index) => <div className={styles.timeline} key={`${item.source.path}-${index}`}><time>{dateLabel(item.occurredAt)}</time><div><h3>{item.source.title}</h3><p>{item.description || "往来内容未记录。"}</p><button onClick={() => void openSource(item.source, item.snippet)}>查看记录来源 <ArrowUpRightIcon size={12} /></button>{interactionKinds.includes(item.kind) && renderInteractionStatus(item)}</div></div>)}{!dated.length && <p className={styles.muted}>尚未记录已发生的往来。</p>}{undated.length > 0 && <><h3>计划、取消或日期未确认</h3>{<RelatedRows items={undated} onOpen={openSource} renderStatus={renderInteractionStatus} />}</>}</section> : tab === "related" ? <section className={styles.tabContent}><p>明确关系分别标注；普通链接显示为“被提及”。</p>{<RelatedRows items={related} onOpen={openSource} />}{!related.length && <p className={styles.muted}>暂无关联资料。</p>}</section> : <div className={styles.overview}><section><h3>关于 {person.name}</h3><p className={styles.summary}>{person.summary || "尚未记录人物简介。"}</p><div className={styles.facts}>{[["邮箱", person.email], ["电话", person.phone], ["公司 / 机构", person.company], ["职务", person.role]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{shown(value)}</strong></div>)}<div><span>资料来源</span><button onClick={() => void openSource(person.source)}>{person.source.path}<ArrowUpRightIcon size={12} /></button></div></div></section><section><h3>最近的往来</h3>{dated.length ? <RelatedRows items={dated.slice(0, 1)} onOpen={openSource} /> : <p className={styles.muted}>尚未记录往来。不会根据笔记编辑时间推测最近联系。</p>}</section><section><h3>与你们有关的资料</h3>{related.length ? <RelatedRows items={related.slice(0, 3)} onOpen={openSource} /> : <p className={styles.muted}>暂无关联资料。</p>}</section></div>}
    <footer className={styles.footer}><LibraryIcon size={13} />{selected?.name} · 当前 Wiki 版本<button onClick={() => setRulesOpen(true)}>资料更新规则</button></footer>
   </>}</article>
  </div>}
 </section>
 {avatarWarning && <p role="status" className={styles.avatarError}>{avatarWarning}</p>}
 {avatarPerson && avatarPerson.vault === vault && <ContactAvatarEditor key={`${vault}:${avatarPerson.person.id}`} vault={vault} person={avatarPerson.person} onClose={() => setAvatarPerson(null)} onSaved={warning => { setAvatarPerson(null); setAvatarWarning(warning ?? ""); refresh(); }} />}
 <Dialog open={sourceDialog} onOpenChange={setSourceDialog}><DialogContent><DialogHeader><DialogTitle>通讯录资料来源</DialogTitle><DialogDescription>选择人脉知识库，保留原来的 Markdown 文件。</DialogDescription></DialogHeader><DialogBody><label className={styles.sourceSelect}>选择知识库<select aria-label="通讯录来源知识库" value={vault} onChange={event => chooseVault(event.target.value)}><option value="">暂不绑定</option>{bindings?.map(binding => <option key={binding.id} value={binding.id} disabled={binding.availability !== "available"}>{binding.name}{binding.availability !== "available" ? "（不可用）" : ""}</option>)}</select></label><p className={styles.muted}>人物以 type: person 识别，title 作为姓名；公司独立为 org，通过 affiliation 的 held_by / at_org 关联，role 记录该公司对应的身份。最近联系从实际往来推导。</p>{currentData?.warnings.map(warning => <p key={warning}>{warning}</p>)}<Link href="/knowledge/connect">接入本地 Wiki</Link></DialogBody></DialogContent></Dialog>
 <Dialog open={rulesOpen} onOpenChange={setRulesOpen}><DialogContent><DialogHeader><DialogTitle>人物资料如何更新</DialogTitle><DialogDescription>通讯录读取知识库，不复制一套联系人数据库。</DialogDescription></DialogHeader><DialogBody><p>点击“整理人物资料”，由 Wiki 管理员整理人物与往来素材，审阅候选和差异后发布。</p><p>你在 Obsidian 或 Markdown 文件中保存的修改会按当前 Wiki 同步规则更新。未完成发布的候选、不可读文件和撤权资料不会作为正式人物信息显示。</p></DialogBody></DialogContent></Dialog>
 <Dialog open={Boolean(sourceRead && sourceRead.vault === vault && !loading)} onOpenChange={open => { if (!open) { sourceSerial.current++; setSourceRead(null); } }}><DialogContent className={styles.sourceDialog}><DialogHeader><DialogTitle>{sourceRead?.source.title ?? "来源笔记"}</DialogTitle><DialogDescription>通讯录所引用版本的原文</DialogDescription></DialogHeader><DialogBody>{sourceRead?.error ? <p role="alert">{sourceRead.error}<button onClick={() => sourceRead && void openSource(sourceRead.source, sourceRead.snippet)}>重试读取</button></p> : sourceRead?.content === undefined ? <p role="status">正在读取来源…</p> : <div className={styles.sourceText}>{sourceRead.content.split("\n").map((line, i) => <div key={i} ref={sourceRead.snippet && line.trim().slice(0, 200) === sourceRead.snippet ? markedLine : undefined} className={sourceRead.snippet && line.trim().slice(0, 200) === sourceRead.snippet ? styles.highlight : ""}>{line || " "}</div>)}</div>}<Link className={styles.sourceContinue} href={`/knowledge?${new URLSearchParams({vault, note: sourceRead?.source.path ?? ""})}`}>在知识库阅读当前版本<ArrowUpRightIcon size={12} /></Link></DialogBody></DialogContent></Dialog>
 <Dialog open={Boolean(statusTarget)} onOpenChange={open => { if (!open && !statusPending) setStatusTarget(null); }}><DialogContent><DialogHeader><DialogTitle>标记往来已完成</DialogTitle><DialogDescription>“{statusTarget?.source.title}”还没有确认的发生日期，填写后计入已发生往来。</DialogDescription></DialogHeader><DialogBody><label className={styles.sourceSelect}>发生日期<input type="date" aria-label="往来发生日期" value={statusDate} onChange={event => setStatusDate(event.target.value)} /></label>{statusError && <p role="alert" className={styles.avatarError}>{statusError}</p>}<div className={styles.statusActions}><button onClick={() => setStatusTarget(null)} disabled={statusPending}>取消</button><button className={styles.primary} disabled={statusPending || !statusDate} onClick={() => statusTarget && void submitStatus(statusTarget, "done", statusDate)}>{statusPending ? "保存中…" : "确认完成"}</button></div></DialogBody></DialogContent></Dialog>
 {selected && <WikiCuratorDialog key={selected.id} bindingId={selected.id} bindingName={selected.name} open={curatorOpen} onOpenChange={setCuratorOpen} />}
 </>;
}
