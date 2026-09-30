"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileTextIcon, LoaderIcon, PencilIcon, PlusIcon, RefreshCwIcon, SearchIcon, TrashIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createTemplateResource, deleteTemplateResource, getTemplateResource, importTemplateResource, listTemplateLibrary, updateTemplateResource } from "@/lib/api";
import type { ResourceDiagnostic, TemplateEntry } from "@/lib/types";
import { filterResources } from "@/components/agent-config/resource-search";

// 资源内容只有扩展这一处编辑入口；智能体配置页只编辑启用名单。
export function TemplateLibraryView({ onCountChange, onLoadError }: { onCountChange?: (count: number) => void; onLoadError?: (message: string) => void }) {
	const [rows, setRows] = useState<TemplateEntry[] | null>(null);
	const [diagnostics, setDiagnostics] = useState<ResourceDiagnostic[]>([]);
	const [readError, setReadError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [editor, setEditor] = useState<{ name: string | null } | null>(null);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [argumentHint, setArgumentHint] = useState("");
	const [content, setContent] = useState("");
	const [importOpen, setImportOpen] = useState(false);
	const [importPath, setImportPath] = useState("");
	const [pendingDelete, setPendingDelete] = useState<TemplateEntry | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const request = useRef(0);
	const refresh = useCallback(() => {
		const id = ++request.current;
		listTemplateLibrary().then((result) => {
			if (id !== request.current) return;
			setRows(result.templates);
			setDiagnostics(result.diagnostics);
			setReadError(null);
			onCountChange?.(result.templates.length);
		}).catch((err: unknown) => {
			if (id === request.current) {
				const message = err instanceof Error ? err.message : String(err);
				setReadError(message);
				onLoadError?.(message);
			}
		});
	}, [onCountChange, onLoadError]);
	useEffect(() => {
		const requestTracker = request;
		refresh();
		return () => { requestTracker.current++; };
	}, [refresh]);

	const act = async (operation: () => Promise<unknown>, done: () => void) => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setError(null);
		try { await operation(); done(); refresh(); }
		catch (err) { setError(err instanceof TypeError ? "请求结果未确认，请先刷新列表核对再操作，避免重复提交。" : err instanceof Error ? err.message : String(err)); }
		finally { busyRef.current = false; setBusy(false); }
	};
	const openEditor = async (row?: TemplateEntry) => {
		if (busyRef.current) return;
		setError(null);
		if (!row) {
			setName(""); setDescription(""); setArgumentHint(""); setContent(""); setEditor({ name: null });
			return;
		}
		busyRef.current = true; setBusy(true);
		try {
			const doc = await getTemplateResource(row.name);
			setName(doc.name); setDescription(doc.description); setArgumentHint(doc.argumentHint ?? ""); setContent(doc.content); setEditor({ name: doc.name });
		} catch (err) { toast.error(err instanceof Error ? err.message : String(err)); }
		finally { busyRef.current = false; setBusy(false); }
	};
	const visibleRows = filterResources(rows ?? [], query);
	return (
		<section className="template-library-view">
			<div className="template-library-head">
				<div><h2>提示词模板</h2><p>统一维护可复用的输入格式；修改内容影响使用它的所有智能体，启用范围在各智能体配置页选择。</p></div>
				<div className="flex flex-wrap items-center gap-2">
					<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setError(null); setImportOpen(true); }}><UploadIcon className="size-4" />导入模板</Button>
					<Button type="button" size="sm" disabled={busy} onClick={() => void openEditor()}><PlusIcon className="size-4" />添加模板</Button>
				</div>
			</div>
			<div className="template-library-toolbar">
				<label className="template-library-search"><SearchIcon className="size-4" /><Input type="search" aria-label="搜索提示词模板" placeholder="搜索模板名称或描述" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
				<span className="text-xs text-muted-foreground" role="status">{rows ? `${rows.length} 个模板` : "正在读取…"}</span>
				<Button type="button" size="icon" variant="ghost" aria-label="刷新模板库" disabled={busy} onClick={refresh}><RefreshCwIcon className="size-4" /></Button>
			</div>
			{readError ? <p role="alert" className="text-sm text-destructive">模板库读取失败：{readError}；请刷新重试。</p> : null}
			{diagnostics.map((item, index) => <p key={index} role="status" className="text-xs text-amber-700 dark:text-amber-400">{item.message}{item.path ? ` · ${item.path}` : ""}</p>)}
			{rows === null && !readError ? <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><LoaderIcon className="size-4 animate-spin" />正在读取模板库…</p> : !readError && visibleRows.length === 0 ? <div className="template-library-empty">{rows?.length ? "没有匹配的模板，试试其他关键词。" : "还没有模板，添加一个常用工作的输入格式。"}</div> : null}
			<div className="template-library-list">
				{visibleRows.map((row) => <article key={row.name} className="template-library-row">
					<FileTextIcon className="size-5 shrink-0 text-primary" />
					<button type="button" className="template-library-copy" disabled={busy || Boolean(readError)} onClick={() => void openEditor(row)}><strong>{row.name}</strong><small title={row.description || row.argumentHint}>{row.description || row.argumentHint || "暂无描述"}</small></button>
					<Button type="button" size="icon" variant="ghost" aria-label={`编辑模板 ${row.name}`} disabled={busy || Boolean(readError)} onClick={() => void openEditor(row)}><PencilIcon className="size-4" /></Button>
					<Button type="button" size="icon" variant="ghost" aria-label={`删除模板 ${row.name}`} disabled={busy || Boolean(readError)} onClick={() => { setError(null); setPendingDelete(row); }}><TrashIcon className="size-4" /></Button>
				</article>)}
			</div>
			<Dialog open={editor !== null} onOpenChange={(open) => { if (!open && !busy) setEditor(null); }}>
				<DialogContent className="template-library-dialog sm:max-w-2xl">
					<DialogHeader><DialogTitle>{editor?.name ? `编辑模板 · ${editor.name}` : "添加提示词模板"}</DialogTitle><DialogDescription>内容保存在共享模板库。保存不会自动为任何智能体启用此模板。</DialogDescription></DialogHeader>
					<form className="flex min-h-0 flex-col gap-4" onSubmit={(event) => {
						event.preventDefault(); if (!editor) return;
						const input = { content, description, argumentHint };
						void act(() => editor.name ? updateTemplateResource(editor.name, input) : createTemplateResource({ name: name.trim(), ...input }), () => { setEditor(null); toast.success("模板内容已保存"); });
					}}>
						<fieldset disabled={busy} className="template-library-fields">
							<label>模板名称<Input required pattern="[a-z0-9][a-z0-9-]*" placeholder="例如：design-review" value={name} disabled={editor?.name !== null} onChange={(event) => setName(event.target.value)} /><small>小写字母、数字和连字符；创建后不可改名。</small></label>
							<label>描述<Input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这个模板适合什么工作？" /></label>
							<label>参数提示（可选）<Input value={argumentHint} onChange={(event) => setArgumentHint(event.target.value)} placeholder="例如：<目标> <约束>" /></label>
							<label>模板内容<Textarea required rows={8} className="font-mono text-sm" value={content} onChange={(event) => setContent(event.target.value)} placeholder="写下可复用的任务要求、输入格式与输出约定…" /></label>
						</fieldset>
						{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
						<DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => setEditor(null)}>取消</Button><Button type="submit" disabled={busy || !name.trim() || !content.trim()}>{busy ? <LoaderIcon className="size-4 animate-spin" /> : null}保存模板</Button></DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			<Dialog open={importOpen} onOpenChange={(open) => { if (!busy) setImportOpen(open); }}>
				<DialogContent><DialogHeader><DialogTitle>导入提示词模板</DialogTitle><DialogDescription>从本机 Markdown 文件导入到共享模板库；不会自动启用。</DialogDescription></DialogHeader><label className="flex flex-col gap-2 text-sm">文件绝对路径<Input value={importPath} disabled={busy} onChange={(event) => setImportPath(event.target.value)} placeholder="/path/to/template.md" /></label>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}<DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => setImportOpen(false)}>取消</Button><Button type="button" disabled={busy || !importPath.trim()} onClick={() => void act(() => importTemplateResource(importPath.trim()), () => { setImportOpen(false); setImportPath(""); toast.success("模板已导入"); })}>{busy ? <LoaderIcon className="size-4 animate-spin" /> : null}导入</Button></DialogFooter></DialogContent>
			</Dialog>
			<Dialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open && !busy) setPendingDelete(null); }}>
				<DialogContent><DialogHeader><DialogTitle>删除模板「{pendingDelete?.name}」？</DialogTitle><DialogDescription>将从共享模板库移除，所有智能体与 pi CLI 都将无法再加载它。删除不能撤销。</DialogDescription></DialogHeader>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}<DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => setPendingDelete(null)}>取消</Button><Button type="button" variant="destructive" disabled={busy} onClick={() => { if (pendingDelete) void act(() => deleteTemplateResource(pendingDelete.name), () => { setPendingDelete(null); toast.success("模板已删除"); }); }}>{busy ? <LoaderIcon className="size-4 animate-spin" /> : null}删除模板</Button></DialogFooter></DialogContent>
			</Dialog>
		</section>
	);
}
