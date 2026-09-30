"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { FileTextIcon, MessageSquareIcon } from "lucide-react";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getWikiBatchSources, type WikiBatchSources } from "@/lib/api";

type Source = WikiBatchSources["sources"][number];
const imageType = /^image\/(png|jpeg|webp|gif)$/;

export function SourceSnapshot({ source }: { source: Source }) {
	const [region, setRegion] = useState<number | null>(null);
	const regions = source.locations.flatMap((location) => {
		if (location.kind !== "image_region" || typeof location.x !== "number" || typeof location.y !== "number" || typeof location.width !== "number" || typeof location.height !== "number" || ![location.x, location.y, location.width, location.height].every(Number.isFinite) || location.x < 0 || location.y < 0 || location.width <= 0 || location.height <= 0 || location.x + location.width > 1.001 || location.y + location.height > 1.001) return [];
		return [{ ...location, x: location.x, y: location.y, width: location.width, height: location.height }];
	});
	const warnings = [...new Set([...source.warnings, ...(source.extraction?.warnings ?? [])])];
	const originalUrl = source.base64 && (imageType.test(source.mediaType) || source.mediaType === "application/pdf") ? `data:${source.mediaType};base64,${source.base64}` : null;
	return <section className="space-y-3" aria-label={`来源 ${source.title}`}>
		<p className="break-all text-xs text-muted-foreground">{source.kind} · {source.status === "ready" ? "可核对来源" : source.status === "failed" ? "解析失败，原件保留" : "需要处理，原件保留"}<br />原件 SHA-256 {source.originalHash}{source.textHash ? <><br />文本 SHA-256 {source.textHash}</> : null}</p>
		{warnings.map((warning, index) => <p key={index} role="status" className="rounded bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">{warning}</p>)}
		{source.extraction ? <details className="rounded border border-border p-3 text-xs text-muted-foreground"><summary>提取记录与原件关联</summary><p className="mt-2 break-all">{source.extraction.extractorId} · {source.extraction.version} · {source.extraction.modelRef}<br />关联原件 {source.extraction.originalHash}<br />提取结果 {source.extraction.artifactHash}</p></details> : null}
		<div className={source.kind === "image" ? "wiki-source-image-layout" : ""}>
			{source.kind === "image" && originalUrl ? <div className="min-w-0"><p className="mb-2 text-xs font-medium">来源原图</p><div className="wiki-source-original"><Image src={originalUrl} alt={source.title} width={1200} height={1200} unoptimized className="h-auto w-full" />{regions.map((location, index) => <button type="button" key={index} onClick={() => setRegion(index)} aria-label={`定位区域 ${index + 1}`} aria-pressed={region === index} className="wiki-source-region" style={{ left: `${location.x * 100}%`, top: `${location.y * 100}%`, width: `${location.width * 100}%`, height: `${location.height * 100}%` }}><span>{index + 1}</span></button>)}</div>{regions.length ? <div className="mt-2 flex flex-wrap gap-2">{regions.map((location, index) => <button key={index} type="button" onClick={() => setRegion(index)} aria-pressed={region === index} className="rounded border border-border px-2 py-1 text-xs aria-pressed:bg-accent">区域 {index + 1}{location.page ? ` · 第 ${location.page} 页` : ""}</button>)}</div> : null}</div> : null}
			<div className="min-w-0">{source.kind === "image" ? <p className="mb-2 text-xs font-medium">提取文字 · 请与原图核对</p> : null}{source.content !== undefined ? <pre className="max-h-[55dvh] overflow-auto whitespace-pre-wrap break-words rounded border border-border p-4 text-xs leading-6">{source.content}</pre> : <p className="text-sm text-muted-foreground">{source.kind === "pdf" ? "PDF 原件已保留，解析/OCR 尚未接入。" : source.kind === "image" ? "尚无可核对的提取文字，请查看解析告警或重试整理。" : "来源文本不可用。"}</p>}{source.locations.filter((location) => location.kind === "lines" || (location.kind === "image_region" && location.startLine !== undefined)).map((location, index) => <p key={index} className="mt-2 text-xs text-muted-foreground">文本定位：第 {location.startLine}–{location.endLine} 行</p>)}</div>
		</div>
		{originalUrl ? <a href={originalUrl} download={source.title} className="inline-block text-sm underline">下载来源原件</a> : null}
	</section>;
}

export function ReviewSources({ batchId }: { batchId: string }) {
	const [open, setOpen] = useState(false);
	const [state, setState] = useState<{ batchId: string; value: WikiBatchSources } | null>(null);
	const [selected, setSelected] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	useEffect(() => {
		if (!open) return;
		let active = true;
		void getWikiBatchSources(batchId).then((value) => {
			if (active) { setState({ batchId, value }); setSelected((previous) => value.sources.some((item) => item.id === previous) ? previous : value.sources[0]?.id ?? ""); setError(null); }
		}).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { active = false; };
	}, [batchId, open, nonce]);
	const sources = state?.batchId === batchId ? state.value : null;
	const current = sources?.sources.find((item) => item.id === selected);
	return <><button type="button" onClick={() => setOpen(true)} className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm"><FileTextIcon size={14} />查看来源</button><Dialog open={open} onOpenChange={setOpen}><DialogContent positionMode="drawer" className="wiki-source-drawer flex flex-col overflow-hidden"><DialogHeader><DialogTitle>候选来源快照</DialogTitle><DialogDescription>对照原件、提取文字和定位告警核对依据。审核记录独立保存。</DialogDescription></DialogHeader><DialogBody className="space-y-4">
		{error ? <p role="alert" className="text-sm text-destructive">{error} <button type="button" onClick={() => setNonce((value) => value + 1)} className="underline">重试</button></p> : null}
		{!sources && !error ? <p className="text-sm text-muted-foreground">正在加载…</p> : null}
		{sources?.origin ? sources.origin.sessionAvailable ? <Link href={`/chats?room=${encodeURIComponent(sources.origin.windowId)}&session=${encodeURIComponent(sources.origin.sessionId)}`} className="inline-flex items-center gap-1.5 text-sm underline"><MessageSquareIcon size={14} />查看来源会话</Link> : <p role="status" className="text-sm text-muted-foreground">来源会话已删除。来源快照与审核记录仍保留。</p> : null}
		{sources && sources.sources.length === 0 ? <p className="text-sm text-muted-foreground">此批次没有可查看的来源快照。</p> : null}
		<div className="flex flex-wrap gap-2">{sources?.sources.map((item) => <button key={item.id} type="button" aria-pressed={selected === item.id} onClick={() => setSelected(item.id)} className="rounded border border-border px-3 py-2 text-xs aria-pressed:bg-accent">{item.title}</button>)}</div>
		{current ? <SourceSnapshot key={current.id} source={current} /> : null}
	</DialogBody></DialogContent></Dialog></>;
}
