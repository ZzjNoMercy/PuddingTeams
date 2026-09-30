"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, Code2Icon, EyeIcon, FileTextIcon, HistoryIcon } from "lucide-react";
import { knowledgeHistoryAssetUrl, getKnowledgeHistoryVersion, listKnowledgeHistory, type KnowledgeHistoryDetail, type KnowledgeHistoryVersion } from "@/lib/api";
import { KnowledgeDiffView } from "./diff-view";
import { markdownReferenceDefinitions, splitFrontmatter } from "./markdown";
import { ReviewSources } from "./review-sources";
import { SnapshotMarkdown } from "./snapshot-markdown";
import { managedImageHash } from "./snapshot-images";
import { historyActor, historyRecordedAt } from "./history-presentation";

type Channel = KnowledgeHistoryVersion["channel"];
const channelLabels: Record<Channel, string> = { initial: "初始导入", agent_publish: "Agent 发布", external_sync: "外部文件同步" };
const time = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const month = (value: string) => new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "long" });
function blocks(text: string) {
	const out: string[] = [];
	let buffer: string[] = [], fence = false, front = false;
	const flush = () => { if (buffer.length) { out.push(buffer.join("\n")); buffer = []; } };
	for (const [index, line] of text.split("\n").entries()) {
		if (index === 0 && line === "---") { front = true; buffer.push(line); continue; }
		if (front) { buffer.push(line); if (line === "---") { front = false; flush(); } continue; }
		if (line.startsWith("```")) { if (!fence) { flush(); fence = true; buffer.push(line); } else { buffer.push(line); fence = false; flush(); } continue; }
		if (fence) { buffer.push(line); continue; }
		if (!line.trim()) { flush(); continue; }
		if (/^#{1,6} |^[-*] |^> |^\d+\. /.test(line)) { flush(); out.push(line); } else buffer.push(line);
	}
	flush(); return out;
}
function changedBlocks(before: string, after: string) {
	const a = blocks(before), b = blocks(after);
	if ((a.length + 1) * (b.length + 1) > 1_000_000) return null;
	const d = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) d[i][j] = a[i] === b[j] ? 1 + d[i + 1][j + 1] : Math.max(d[i + 1][j], d[i][j + 1]);
	const rows: Array<{ kind: "same" | "add" | "remove"; text: string }> = [];
	let i = 0, j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) { rows.push({ kind: "same", text: a[i++] }); j++; }
		else if (i < a.length && (j === b.length || d[i + 1][j] >= d[i][j + 1])) rows.push({ kind: "remove", text: a[i++] });
		else rows.push({ kind: "add", text: b[j++] });
	}
	return rows;
}
function HistoryMarkdown({ text, bindingId, versionId, notePath, referenceContext }: { text: string; bindingId: string; versionId: string | undefined; notePath: string; referenceContext?: string }) {
	const parsed = splitFrontmatter(text.endsWith("\n") ? text : `${text}\n`);
	const references = referenceContext ? markdownReferenceDefinitions(referenceContext) : "";
	return <>{parsed.properties.length ? <details className="ph-metadata-diff"><summary>页面属性</summary><dl className="ph-properties">{parsed.properties.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></details> : null}<div className="runtime-file-markdown"><SnapshotMarkdown text={references ? `${parsed.body}\n\n${references}` : parsed.body} bindingId={bindingId} notePath={notePath} assetUrl={(path) => versionId && managedImageHash(path) ? knowledgeHistoryAssetUrl(bindingId, versionId, path) : null} /></div></>;
}

export function KnowledgePageHistory({ bindingId, notePath, title, onClose }: { bindingId: string; notePath: string; title: string; onClose: () => void }) {
	const params = useSearchParams(), router = useRouter();
	const selectedId = params.get("historyVersion");
	const [list, setList] = useState<{ key: string; versions: KnowledgeHistoryVersion[] } | null>(null);
	const [detail, setDetail] = useState<{ id: string; value: KnowledgeHistoryDetail } | null>(null);
	const [filter, setFilter] = useState<"all" | Channel>("all");
	const [mode, setMode] = useState<"visual" | "snapshot" | "raw">("visual");
	const [onlyChanges, setOnlyChanges] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [detailError, setDetailError] = useState<{ id: string; message: string } | null>(null);
	const [nonce, setNonce] = useState(0);
	const key = JSON.stringify([bindingId, notePath]);
	useEffect(() => {
		let active = true;
		void listKnowledgeHistory(bindingId, notePath).then((value) => { if (active) { setList({ key, versions: value.versions }); setError(null); } }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { active = false; };
	}, [bindingId, notePath, key, nonce]);
	const versions = list?.key === key ? list.versions : [];
	const filtered = versions.filter((version) => filter === "all" || version.channel === filter);
	const selected = filtered.find((version) => version.id === selectedId) ?? filtered[0];
	useEffect(() => {
		if (!selected) return;
		let active = true;
		void getKnowledgeHistoryVersion(bindingId, selected.id).then((value) => { if (active) { setDetail({ id: selected.id, value }); setDetailError(null); } }).catch((cause) => { if (active) setDetailError({ id: selected.id, message: cause instanceof Error ? cause.message : String(cause) }); });
		return () => { active = false; };
	}, [bindingId, selected, nonce]);
	const current = detail && selected && detail.id === selected.id ? detail.value : null;
	const currentError = detailError && selected && detailError.id === selected.id ? detailError.message : null;
	const rows = useMemo(() => current ? changedBlocks(current.previousContent ?? "", current.content) : [], [current]);
	const groups = filtered.reduce<Array<{ month: string; versions: KnowledgeHistoryVersion[] }>>((acc, version) => { const label = month(historyRecordedAt(version)); const previous = acc.at(-1); if (previous?.month === label) previous.versions.push(version); else acc.push({ month: label, versions: [version] }); return acc; }, []);
	const choose = (id: string | null) => { const query = new URLSearchParams(params.toString()); if (id) query.set("historyVersion", id); else query.delete("historyVersion"); query.set("history", "1"); router.replace(`/knowledge?${query}`, { scroll: false }); };
	return <div className="ph-workspace"><header className="ph-heading"><button type="button" onClick={onClose}><ArrowLeftIcon size={15} />返回当前正文</button><div><HistoryIcon size={17} /><h3>页面历史</h3><span>{versions.length} 个版本</span></div><span className="ph-readonly">查看历史不会改变当前页面</span></header>{error ? <p role="alert" className="p-4 text-sm text-destructive">{error} <button className="underline" onClick={() => setNonce((value) => value + 1)}>重试</button></p> : list?.key !== key ? <p className="p-4 text-sm text-muted-foreground">正在读取历史…</p> : <div className="ph-layout"><section className="ph-reader">{selected ? <><header className="ph-version-heading"><div><span className="ph-version-badge">版本 {selected.revision}</span>{selected.current && !selected.deleted ? <span className="ph-current-tag"><CheckIcon size={11} />当前版本</span> : null}<small>{time(historyRecordedAt(selected))} · {historyActor(selected)}</small></div><h2>{selected.summary || title}</h2><p>{current ? current.previousVersionId ? `与版本 ${selected.revision - 1} 对比` : "与空白页面对比" : "正在读取对比基线…"}<span>{channelLabels[selected.channel]}</span></p>{selected.deleted ? <p className="text-sm text-muted-foreground">此记录来自外部文件删除；当前正文不会恢复该文件。</p> : null}<p className="break-all">SHA-256 {selected.contentHash}</p>{selected.batchId ? <div className="mt-3 flex flex-wrap gap-3"><Link className="text-xs underline" href={`/knowledge/review?batch=${encodeURIComponent(selected.batchId)}&returnNote=${encodeURIComponent(notePath)}&vault=${encodeURIComponent(bindingId)}`}>查看关联审批</Link><ReviewSources batchId={selected.batchId} /></div> : null}{selected.sourceIds.length ? <details className="mt-3 text-xs text-muted-foreground"><summary>来源引用 · {selected.sourceIds.length} 项</summary><ul className="mt-2 space-y-1">{selected.sourceIds.map((id) => <li key={id} className="break-all">{id}</li>)}</ul></details> : null}{selected.channel === "external_sync" ? <p className="mt-2 text-xs text-muted-foreground">实际作者未知；时间为平台扫描同步时间，不代表文件实际编辑时间。</p> : null}</header><div className="ph-toolbar"><div role="tablist" aria-label="历史版本视图">{([{ id: "visual", label: "正文修订", Icon: EyeIcon }, { id: "snapshot", label: "完整版本", Icon: FileTextIcon }, { id: "raw", label: "Markdown diff", Icon: Code2Icon }] as const).map(({ id, label, Icon }) => <button key={id} role="tab" aria-selected={mode === id} onClick={() => setMode(id)}><Icon size={13} />{label}</button>)}</div>{mode !== "snapshot" ? <label><input type="checkbox" checked={onlyChanges} onChange={(event) => setOnlyChanges(event.target.checked)} />只看修改</label> : null}</div><div className="ph-content"><p className="ph-paper-path">{notePath}</p>{currentError ? <p role="alert" className="text-sm text-destructive">{currentError} <button className="underline" onClick={() => setNonce((value) => value + 1)}>重试</button></p> : !current ? <p className="text-sm text-muted-foreground">正在读取固定版本…</p> : mode === "snapshot" ? <HistoryMarkdown text={current.content} bindingId={bindingId} versionId={selected.id} notePath={selected.relativePath} /> : mode === "raw" || !rows ? <>{!rows && mode === "visual" ? <p className="mb-3 text-xs text-muted-foreground">内容较大，显示精确行级差异。完整正文可切换“完整版本”。</p> : null}<KnowledgeDiffView hunks={current.diff.hunks} truncated={current.diff.truncated} onlyChanges={onlyChanges} label={`版本 ${selected.revision} 与上一记录版本的差异`} /></> : <article className="ph-document" aria-label="正文修订对比">{rows.filter((row) => !onlyChanges || row.kind !== "same").map((row, index) => <div key={index} className={`ph-block ${row.kind}`} >{row.kind !== "same" ? <div className="ph-change-author"><span className="ph-change-symbol">{row.kind === "add" ? "+" : "−"}</span>{historyActor(selected)} · {row.kind === "add" ? "新增" : "删除"}</div> : null}<HistoryMarkdown text={row.text} bindingId={bindingId} versionId={row.kind === "remove" ? current.previousVersionId : selected.id} notePath={row.kind === "remove" ? current.version.previousPath ?? selected.relativePath : selected.relativePath} referenceContext={row.kind === "remove" ? current.previousContent : current.content} /></div>)}</article>}<footer className="ph-bottom-note">版本 {selected.revision} 的{mode === "snapshot" ? "完整内容" : "变更内容"} · 仅供查看</footer></div></> : <p className="p-6 text-sm text-muted-foreground">{versions.length ? "此渠道没有记录版本。" : "该页面暂无记录历史。待审核或退回候选不计入历史。"}</p>}</section><aside className="ph-timeline" aria-label="页面版本时间线"><header><div><strong>版本记录</strong><span>{filtered.length}</span></div><select value={filter} aria-label="筛选修改来源" onChange={(event) => { setFilter(event.target.value as typeof filter); choose(null); }}><option value="all">全部来源</option><option value="agent_publish">Agent 发布</option><option value="external_sync">外部文件同步</option><option value="initial">初始导入</option></select></header>{groups.map((group) => <section className="ph-month" key={group.month}><h4>{group.month}</h4>{group.versions.map((version) => <button key={version.id} className="ph-time-entry" aria-pressed={version.id === selected?.id} onClick={() => choose(version.id)} aria-label={`查看版本 ${version.revision}`}><ChevronRightIcon size={14} /><span className="ph-time-copy"><strong>{time(historyRecordedAt(version))}</strong>{version.current && !version.deleted ? <em>最近更新 · 当前版本</em> : null}<span>{historyActor(version)}</span><small>{channelLabels[version.channel]} · v{version.revision}{version.deleted ? " · 已删除" : ""}</small>{version.id === selected?.id ? <p>{version.summary}</p> : null}</span></button>)}</section>)}<footer>历史来自外部文件同步或 Agent 发布。<br />待审核候选不会出现在这里。</footer></aside></div>}</div>;
}
