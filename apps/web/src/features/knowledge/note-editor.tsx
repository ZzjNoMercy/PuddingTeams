"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2Icon, SaveIcon } from "lucide-react";
import { toast } from "sonner";
import { knowledgeAssetUrl, saveKnowledgeNote, type KnowledgeNote } from "@/lib/api";
import { SnapshotMarkdown } from "./snapshot-markdown";
import { formatPropertyValue, propertyLabel, splitFrontmatter } from "./markdown";

const pendingSaves = new Map<string, Promise<{ note: KnowledgeNote; syncWarning?: string }>>();

export function KnowledgeNoteEditor({ bindingId, note, onSaved, onCancel }: {
	bindingId: string; note: KnowledgeNote; onSaved: (note: KnowledgeNote) => void; onCancel: () => void;
}) {
	const storageKey = `pudding:note-draft:${bindingId}:${note.path}`;
	const [draft, setDraft] = useState(() => {
		try {
			const value = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as { content?: unknown; expectedHash?: unknown } | null;
			if (typeof value?.content === "string" && typeof value.expectedHash === "string") return { content: value.content, expectedHash: value.expectedHash };
		} catch { /* browser storage is optional */ }
		return { content: note.content, expectedHash: note.contentHash };
	});
	const [preview, setPreview] = useState(false);
	const [saving, setSaving] = useState(() => pendingSaves.has(storageKey));
	const mounted = useRef(true);
	const draftRef = useRef(draft);
	useEffect(() => { draftRef.current = draft; }, [draft]);
	const [error, setError] = useState<string | null>(null);
	const dirty = draft.content !== note.content;
	const parsed = splitFrontmatter(draft.content);
	useEffect(() => {
		mounted.current = true;
		const pending = pendingSaves.get(storageKey);
		if (pending) void pending.then((result) => {
			if (!mounted.current) return;
			setSaving(false);
			if (draftRef.current.content === result.note.content) onSaved(result.note);
			else {
				const next = { ...draftRef.current, expectedHash: result.note.contentHash };
				setDraft(next);
				try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* optional */ }
			}
		}, (cause: unknown) => { if (mounted.current) { setSaving(false); setError(cause instanceof Error ? cause.message : "保存失败，请重试"); } });
		return () => { mounted.current = false; };
	}, [storageKey, onSaved]);
	useEffect(() => {
		if (!dirty) return;
		const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); };
		window.addEventListener("beforeunload", prevent);
		return () => window.removeEventListener("beforeunload", prevent);
	}, [dirty]);
	const forget = () => { try { sessionStorage.removeItem(storageKey); } catch { /* optional */ } };
	const update = (content: string) => {
		const value = { ...draft, content }; setDraft(value);
		try { sessionStorage.setItem(storageKey, JSON.stringify(value)); } catch { /* editing remains available */ }
	};
	const save = async () => {
		if (saving || pendingSaves.has(storageKey) || !dirty) return;
		setSaving(true); setError(null);
		const submitted = JSON.stringify(draft);
		const pending = saveKnowledgeNote(bindingId, { path: note.path, ...draft });
		pendingSaves.set(storageKey, pending);
		try {
			const result = await pending;
			try { if (sessionStorage.getItem(storageKey) === submitted) forget(); } catch { /* optional */ }
			if (result.syncWarning) toast.warning(result.syncWarning); else toast.success("笔记已保存");
			if (mounted.current) onSaved(result.note);
		} catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "保存失败，请重试"); }
		finally { if (pendingSaves.get(storageKey) === pending) pendingSaves.delete(storageKey); if (mounted.current) setSaving(false); }
	};
	return <section aria-label="编辑笔记" className="space-y-4">
		<div className="flex flex-wrap items-center justify-between gap-3">
			<div className="flex items-center gap-1 rounded-md bg-muted p-1">
				<button type="button" aria-pressed={!preview} onClick={() => setPreview(false)} className={`rounded px-3 py-1.5 text-sm ${!preview ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}>编辑</button>
				<button type="button" aria-pressed={preview} onClick={() => setPreview(true)} className={`rounded px-3 py-1.5 text-sm ${preview ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}>预览</button>
			</div>
			<div className="flex items-center gap-2">
				<button type="button" disabled={saving} onClick={() => { forget(); onCancel(); }} className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50">取消</button>
				<button type="button" disabled={saving || !dirty} onClick={() => void save()} className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">{saving ? <Loader2Icon size={14} className="animate-spin" /> : <SaveIcon size={14} />}{saving ? "正在保存…" : "保存修改"}</button>
			</div>
		</div>
		<p className="text-xs text-muted-foreground">修改内容后直接保存到知识库。离开页面会保留未保存的草稿。</p>
		{!saving && draft.expectedHash !== note.contentHash ? <p role="alert" className="text-sm text-destructive">已恢复未保存的草稿，但文件已更新。请先复制草稿，再取消编辑查看最新内容。</p> : null}
		{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
		{preview ? <div className="rounded-lg border border-border p-4">
			{parsed.properties.length ? <dl className="mb-5 grid gap-2 text-xs sm:grid-cols-2">{parsed.properties.map(([key, value]) => <div key={key} className="flex gap-2"><dt className="text-muted-foreground">{propertyLabel(key)}</dt><dd className="min-w-0 break-words">{formatPropertyValue(value)}</dd></div>)}</dl> : null}
			<div className="runtime-file-markdown"><SnapshotMarkdown text={parsed.body} bindingId={bindingId} notePath={note.path} assetUrl={(path) => knowledgeAssetUrl(bindingId, path)} /></div>
		</div> : <label className="block space-y-2"><span className="text-sm font-medium">笔记内容 <span className="font-normal text-muted-foreground">· Markdown</span></span><textarea aria-label="笔记内容" disabled={saving} value={draft.content} onChange={(event) => update(event.target.value)} spellCheck={false} className="min-h-[55vh] w-full resize-y rounded-lg border border-border bg-background p-4 font-mono text-sm leading-7 outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-70" /></label>}
	</section>;
}
