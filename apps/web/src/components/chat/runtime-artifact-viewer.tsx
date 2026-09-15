"use client";

import { useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import { BracesIcon, DownloadIcon, ExternalLinkIcon, FileIcon, FileSpreadsheetIcon, FileTextIcon, RefreshCwIcon, Table2Icon } from "lucide-react";
import { ClipboardSafeStreamdown } from "@/components/ai-elements/streamdown";
import { Loader } from "@/components/ai-elements/loader";
import { Button } from "@/components/ui/button";
import { streamdownPlugins } from "@/core/streamdown/plugins";
import {
	artifactContentUrl,
	fetchArtifactContent,
	fetchDelegationArtifacts,
	fetchDelegationFiles,
	fetchRuntimeFileContent,
	openArtifact,
	openRuntimeFile,
	type ArtifactListItem,
	type RuntimeFileItem,
} from "@/lib/api";
import { toast } from "sonner";

type ViewerKind = "runtime" | "artifacts";
type PreviewKind = RuntimeFileItem["preview"];

interface ViewerItem {
	id: string;
	name: string;
	path: string;
	extension: string;
	size?: number;
	updatedAt?: string;
	state: "available" | "deleted";
	preview: PreviewKind;
	artifact?: ArtifactListItem;
}

function previewForName(name: string): PreviewKind {
	const extension = name.split(".").pop()?.toLowerCase() ?? "";
	if (extension === "md" || extension === "mdx") return "markdown";
	if (extension === "json" || extension === "jsonl") return "json";
	if (extension === "csv" || extension === "tsv") return "csv";
	if (["txt", "log", "yaml", "yml", "toml", "xml", "html", "css", "js", "jsx", "ts", "tsx", "py", "sh", "zsh", "sql", "rs", "go", "java"].includes(extension)) return "text";
	return "external";
}

function formatBytes(value?: number): string {
	if (value === undefined) return "—";
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
	return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(preview: PreviewKind) {
	if (preview === "markdown") return FileTextIcon;
	if (preview === "json") return BracesIcon;
	if (preview === "csv") return Table2Icon;
	if (preview === "external") return FileSpreadsheetIcon;
	return FileIcon;
}

function parseDelimited(content: string, delimiter: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let index = 0; index < content.length && rows.length < 200; index += 1) {
		const char = content[index]!;
		if (char === '"') {
			if (quoted && content[index + 1] === '"') { cell += '"'; index += 1; }
			else quoted = !quoted;
		} else if (char === delimiter && !quoted) {
			row.push(cell); cell = "";
		} else if ((char === "\n" || char === "\r") && !quoted) {
			if (char === "\r" && content[index + 1] === "\n") index += 1;
			row.push(cell); rows.push(row.slice(0, 30)); row = []; cell = "";
		} else cell += char;
	}
	if ((cell || row.length) && rows.length < 200) { row.push(cell); rows.push(row.slice(0, 30)); }
	return rows;
}

const safeMarkdownComponents = {
	a: ({ href, children, ...props }: ComponentProps<"a">) => <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>,
	img: ({ alt }: ComponentProps<"img">) => <span className="runtime-file-blocked-image">[外部图片未自动加载：{alt || "无标题"}]</span>,
};

function Preview({ item, content, loading, error }: { item: ViewerItem; content: string; loading: boolean; error: string | null }) {
	if (item.state === "deleted") return <div className="runtime-file-empty">这个文件已从当前工作副本删除。</div>;
	if (item.preview === "external") {
		return (
			<div className="runtime-file-external-card">
				<div className="runtime-file-external-icon"><FileSpreadsheetIcon /></div>
				<h3>{item.name}</h3>
				<p>此格式交给系统默认应用显示。Excel 文件会由 Excel、Numbers 或你设置的默认工具打开。</p>
			</div>
		);
	}
	if (loading) return <div className="runtime-file-empty"><Loader size={14} />正在读取文件…</div>;
	if (error) return <div className="runtime-file-empty text-destructive">预览失败：{error}</div>;
	if (item.preview === "markdown") {
		return <article className="runtime-file-markdown"><ClipboardSafeStreamdown {...streamdownPlugins} components={safeMarkdownComponents}>{content}</ClipboardSafeStreamdown></article>;
	}
	if (item.preview === "json") {
		let formatted = content;
		try { formatted = JSON.stringify(JSON.parse(content), null, 2); } catch { /* JSONL/plain fallback */ }
		return <pre className="runtime-file-code">{formatted}</pre>;
	}
	if (item.preview === "csv") {
		const rows = parseDelimited(content, item.extension === "tsv" ? "\t" : ",");
		return rows.length ? (
			<div className="runtime-file-table-wrap"><table><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => rowIndex === 0 ? <th key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>
		) : <div className="runtime-file-empty">文件为空</div>;
	}
	return <pre className="runtime-file-code">{content}</pre>;
}

export function RuntimeArtifactViewer({ delegationId, kind, live }: { delegationId: string; kind: ViewerKind; live: boolean }) {
	const [items, setItems] = useState<ViewerItem[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [scopeAvailable, setScopeAvailable] = useState(true);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [content, setContent] = useState("");
	const [contentLoading, setContentLoading] = useState(false);
	const [contentError, setContentError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const next: ViewerItem[] = kind === "runtime"
				? await fetchDelegationFiles(delegationId).then((result) => {
					setScopeAvailable(result.scopeAvailable);
					return result.files.map((item) => ({ ...item, id: item.path }));
				})
				: await fetchDelegationArtifacts(delegationId).then((records) => records.map((record) => ({
					id: record.id,
					name: record.name,
					path: record.name,
					extension: record.name.split(".").pop()?.toLowerCase() ?? "",
					size: record.size,
					updatedAt: record.createdAt,
					state: "available" as const,
					preview: previewForName(record.name),
					artifact: record,
				})));
			setItems(next);
			setSelectedId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id ?? null);
			setError(null);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally { setLoading(false); }
	}, [delegationId, kind]);

	useEffect(() => {
		const initial = setTimeout(() => {
			setLoading(true);
			setItems([]);
			setSelectedId(null);
			void refresh();
		}, 0);
		const timer = live ? setInterval(() => void refresh(), 4000) : undefined;
		return () => { clearTimeout(initial); if (timer) clearInterval(timer); };
	}, [live, refresh]);

	const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);

	useEffect(() => {
		const controller = new AbortController();
		const initial = setTimeout(() => {
			setContent("");
			setContentError(null);
			if (!selected || selected.state === "deleted" || selected.preview === "external") {
				setContentLoading(false);
				return;
			}
			setContentLoading(true);
			const request = kind === "runtime"
				? fetchRuntimeFileContent(delegationId, selected.path)
				: fetchArtifactContent(selected.id);
			void request.then((value) => {
				if (!controller.signal.aborted) setContent(value);
			}).catch((reason: unknown) => {
				if (!controller.signal.aborted) setContentError(reason instanceof Error ? reason.message : String(reason));
			}).finally(() => {
				if (!controller.signal.aborted) setContentLoading(false);
			});
		}, 0);
		return () => { clearTimeout(initial); controller.abort(); };
	}, [delegationId, kind, selected]);

	const openSelected = async () => {
		if (!selected || selected.state === "deleted") return;
		try {
			if (kind === "runtime") await openRuntimeFile(delegationId, selected.path);
			else await openArtifact(selected.id);
			toast.success(kind === "runtime" ? "已交给系统默认应用打开" : "已打开交付物的冻结副本");
		} catch (reason) { toast.error(reason instanceof Error ? reason.message : String(reason)); }
	};

	return (
		<div className="runtime-artifact-viewer">
			<aside className="runtime-file-sidebar">
				<div className="runtime-file-list-head">
					<div><strong>{kind === "runtime" ? "运行文件" : "交付物"}</strong><span>{items.length}</span></div>
					<button type="button" onClick={() => void refresh()} aria-label="刷新文件" title="刷新"><RefreshCwIcon /></button>
				</div>
				<p className="runtime-file-source-note">{kind === "runtime" ? "当前工作副本 · 相对入场 baseline" : "登记时冻结 · 内容哈希可验证"}</p>
				<div className="runtime-file-list">
					{loading && !items.length ? <div className="runtime-file-empty"><Loader size={13} />加载中…</div> : null}
					{error && !items.length ? <div className="runtime-file-empty text-destructive">{error}</div> : null}
					{!loading && !error && !items.length ? <div className="runtime-file-empty">{kind === "runtime" && !scopeAvailable ? "这次委托没有可归属的执行工作区" : kind === "runtime" ? "这次执行尚未产生文件变更" : "这次委托没有登记交付物"}</div> : null}
					{items.map((item) => {
						const Icon = fileIcon(item.preview);
						return <button type="button" key={item.id} data-active={selected?.id === item.id ? "true" : "false"} onClick={() => setSelectedId(item.id)} className="runtime-file-row">
							<span className="runtime-file-kind"><Icon /></span>
							<span className="min-w-0 flex-1"><strong>{item.name}</strong><small>{item.state === "deleted" ? "已删除" : `${item.extension.toUpperCase() || "FILE"} · ${formatBytes(item.size)}`}</small></span>
						</button>;
					})}
				</div>
			</aside>
			<section className="runtime-file-preview">
				{selected ? <>
					<header className="runtime-file-preview-head">
						<div className="min-w-0"><strong>{selected.name}</strong><span title={selected.path}>{selected.path}</span></div>
						<div className="runtime-file-actions">
							{kind === "artifacts" ? <Button asChild size="sm" variant="outline"><a href={artifactContentUrl(selected.id)} download={selected.name}><DownloadIcon />下载</a></Button> : null}
							<Button size="sm" disabled={selected.state === "deleted"} onClick={() => void openSelected()}><ExternalLinkIcon />系统打开</Button>
						</div>
					</header>
					<div className="runtime-file-meta">
						<span>{formatBytes(selected.size)}</span>
						{selected.updatedAt ? <span>{new Date(selected.updatedAt).toLocaleString()}</span> : null}
						{selected.artifact ? <span title={selected.artifact.contentHash}>SHA-256 · {selected.artifact.contentHash.slice(0, 12)}…</span> : <span>工作副本会随执行变化</span>}
					</div>
					<div className="runtime-file-preview-body"><Preview item={selected} content={content} loading={contentLoading} error={contentError} /></div>
				</> : <div className="runtime-file-empty">从左侧选择一个文件</div>}
			</section>
		</div>
	);
}
