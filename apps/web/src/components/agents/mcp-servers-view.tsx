"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderIcon, PencilIcon, PlusIcon, ServerIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createMcpServer, deleteMcpServer, listMcpServers, updateMcpServer } from "@/lib/api";
import type { McpCatalogResponse, McpServerDefinition, McpServerRecord } from "@/lib/types";

function parseSecrets(raw: string): Record<string, string> | undefined {
	const result: Record<string, string> = {};
	for (const [index, line] of raw.split("\n").entries()) {
		const value = line.trim();
		if (!value) continue;
		const equals = value.indexOf("=");
		if (equals <= 0) throw new Error(`密钥第 ${index + 1} 行必须是 KEY=VALUE`);
		const key = value.slice(0, equals).trim();
		if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`密钥「${key}」必须是 UPPER_SNAKE`);
		result[key] = value.slice(equals + 1);
	}
	return Object.keys(result).length ? result : undefined;
}

function endpointOf(server: McpServerRecord): string {
	if (server.definition.url) return server.definition.url;
	return [server.definition.command, ...(server.definition.args ?? [])].filter(Boolean).join(" ");
}

export function McpServersView({ onCountChange }: { onCountChange: (count: number) => void }) {
	const [catalog, setCatalog] = useState<McpCatalogResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [editorOpen, setEditorOpen] = useState(false);
	const [editing, setEditing] = useState<McpServerRecord | null>(null);
	const [saving, setSaving] = useState(false);
	const [deleting, setDeleting] = useState<McpServerRecord | null>(null);
	const [deleteBusy, setDeleteBusy] = useState(false);
	const [id, setId] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [description, setDescription] = useState("");
	const [definition, setDefinition] = useState('{\n  "command": "npx",\n  "args": ["-y", "@example/mcp-server"]\n}');
	const [secrets, setSecrets] = useState("");

	const refresh = useCallback(async () => {
		try {
			const next = await listMcpServers();
			setCatalog(next);
			onCountChange(next.servers.length);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [onCountChange]);

	useEffect(() => {
		const timer = window.setTimeout(() => void refresh(), 0);
		return () => window.clearTimeout(timer);
	}, [refresh]);

	const canSave = useMemo(() => id.trim() && displayName.trim() && definition.trim(), [id, displayName, definition]);

	const resetDraft = () => {
		setId("");
		setDisplayName("");
		setDescription("");
		setDefinition('{\n  "command": "npx",\n  "args": ["-y", "@example/mcp-server"]\n}');
		setSecrets("");
	};

	const openCreate = () => {
		setEditing(null);
		resetDraft();
		setEditorOpen(true);
	};

	const openEdit = (server: McpServerRecord) => {
		setEditing(server);
		setId(server.id);
		setDisplayName(server.displayName);
		setDescription(server.description ?? "");
		setDefinition(JSON.stringify(server.definition, null, 2));
		setSecrets("");
		setEditorOpen(true);
	};

	const save = async () => {
		if (!canSave) return;
		setSaving(true);
		try {
			const parsed = JSON.parse(definition) as McpServerDefinition;
			const parsedSecrets = parseSecrets(secrets);
			if (editing) {
				await updateMcpServer(editing.id, {
					displayName: displayName.trim(),
					description: description.trim(),
					definition: parsed,
					...(parsedSecrets ? { secrets: parsedSecrets } : {}),
				});
				toast.success(`MCP Server「${displayName.trim()}」已更新`);
			} else {
				await createMcpServer({
					id: id.trim(),
					displayName: displayName.trim(),
					...(description.trim() ? { description: description.trim() } : {}),
					definition: parsed,
					...(parsedSecrets ? { secrets: parsedSecrets } : {}),
				});
				toast.success(`MCP Server「${displayName.trim()}」已添加`);
			}
			setEditorOpen(false);
			setEditing(null);
			resetDraft();
			await refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const remove = async () => {
		if (!deleting) return;
		setDeleteBusy(true);
		try {
			await deleteMcpServer(deleting.id);
			toast.success(`MCP Server「${deleting.displayName}」已删除`);
			setDeleting(null);
			await refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setDeleteBusy(false);
		}
	};

	return (
		<div className="py-8">
			{loading && !catalog ? (
				<div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><LoaderIcon className="size-4 animate-spin" />加载 MCP Server…</div>
			) : catalog?.servers.length ? (
				<>
					<div className="mb-6 flex items-center justify-between gap-4">
						<h2 className="text-base font-semibold tracking-tight">MCP Servers</h2>
						<Button type="button" size="sm" onClick={openCreate}><PlusIcon className="size-4" />添加 Server</Button>
					</div>
					<div className="ops-mcp-grid">{catalog.servers.map((server) => (
						<article key={server.id} className="ops-mcp-card">
							<div className="ops-mcp-card-head">
								<div className="ops-mcp-card-icon"><ServerIcon className="size-4" /></div>
								<div className="min-w-0 flex-1">
									<div className="flex min-w-0 items-center gap-2"><h3 className="truncate text-sm font-semibold">{server.displayName}</h3><code className="ops-mcp-id">{server.id}</code></div>
									<p className="ops-mcp-endpoint" title={endpointOf(server)}>{endpointOf(server)}</p>
								</div>
								<div className="flex items-center gap-0.5">
									<Button type="button" variant="ghost" size="icon" title="编辑" aria-label={`编辑 ${server.displayName}`} onClick={() => openEdit(server)}><PencilIcon className="size-3.5" /></Button>
									<Button type="button" variant="ghost" size="icon" title="删除" aria-label={`删除 ${server.displayName}`} onClick={() => setDeleting(server)}><Trash2Icon className="size-3.5" /></Button>
								</div>
							</div>
							{server.description ? <p className="ops-mcp-description">{server.description}</p> : null}
							<div className="ops-mcp-meta">
								<span>{server.definition.url ? "Remote HTTP" : "Local stdio"}</span>
								<span>{server.secretKeys.length ? `${server.secretKeys.length} 个密钥` : "无密钥"}</span>
								<span title={server.usedBy.map((agent) => agent.displayName).join("、")}>{server.usedBy.length ? `${server.usedBy.length} 个 Agent` : "未启用"}</span>
							</div>
						</article>
					))}</div>
				</>
			) : (
				<div className="ops-empty-state flex min-h-64 flex-col items-center justify-center">
					<div className="text-sm font-medium">还没有 MCP Server</div>
					<Button type="button" size="sm" className="mt-4" onClick={openCreate}><PlusIcon className="size-4" />添加 Server</Button>
				</div>
			)}

			<Dialog open={editorOpen} onOpenChange={(open) => { setEditorOpen(open); if (!open && !saving) { setEditing(null); resetDraft(); } }}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader><DialogTitle>{editing ? "编辑 MCP Server" : "添加 MCP Server"}</DialogTitle><DialogDescription>{editing ? "Server ID 不可修改；密钥留空会保留已有值。" : "command 与 url 请选择一种。"}</DialogDescription></DialogHeader>
					<div className="grid gap-4 sm:grid-cols-2">
						<label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">Server ID</span><Input value={id} disabled={editing !== null} onChange={(event) => setId(event.target.value)} placeholder="context7" className="font-mono text-xs" /></label>
						<label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">显示名称</span><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Context7" /></label>
						<label className="flex flex-col gap-1 text-sm sm:col-span-2"><span className="text-muted-foreground">说明（可选）</span><Input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
						<label className="flex flex-col gap-1 text-sm sm:col-span-2"><span className="text-muted-foreground">Server definition（JSON）</span><Textarea value={definition} onChange={(event) => setDefinition(event.target.value)} rows={9} className="font-mono text-xs" /></label>
						<label className="flex flex-col gap-1 text-sm sm:col-span-2"><span className="text-muted-foreground">密钥环境变量（可选，每行 KEY=VALUE；保存后不回显）{editing?.secretKeys.length ? ` · 已配置 ${editing.secretKeys.join("、")}` : ""}</span><Textarea value={secrets} onChange={(event) => setSecrets(event.target.value)} rows={3} className="font-mono text-xs" placeholder={editing ? "留空保留；KEY=新值 更新；KEY= 删除" : "API_TOKEN=…"} /></label>
					</div>
					<DialogFooter><Button type="button" variant="ghost" disabled={saving} onClick={() => setEditorOpen(false)}>取消</Button><Button type="button" disabled={saving || !canSave} onClick={() => void save()}>{saving ? <LoaderIcon className="size-4 animate-spin" /> : null}{editing ? "保存" : "添加"}</Button></DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={deleting !== null} onOpenChange={(open) => { if (!open && !deleteBusy) setDeleting(null); }}>
				<DialogContent><DialogHeader><DialogTitle>删除 MCP Server？</DialogTitle><DialogDescription>将删除「{deleting?.displayName}」的配置与加密密钥。仍被 Agent 勾选时服务端会拒绝删除。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" disabled={deleteBusy} onClick={() => setDeleting(null)}>取消</Button><Button type="button" variant="destructive" disabled={deleteBusy} onClick={() => void remove()}>{deleteBusy ? <LoaderIcon className="size-4 animate-spin" /> : null}删除</Button></DialogFooter></DialogContent>
			</Dialog>
		</div>
	);
}
