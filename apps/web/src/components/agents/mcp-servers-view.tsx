"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LoaderIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createMcpServer, deleteMcpServer, listMcpServers } from "@/lib/api";
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
	const [createOpen, setCreateOpen] = useState(false);
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

	const create = async () => {
		if (!canSave) return;
		setSaving(true);
		try {
			const parsed = JSON.parse(definition) as McpServerDefinition;
			const parsedSecrets = parseSecrets(secrets);
			await createMcpServer({
				id: id.trim(),
				displayName: displayName.trim(),
				...(description.trim() ? { description: description.trim() } : {}),
				definition: parsed,
				...(parsedSecrets ? { secrets: parsedSecrets } : {}),
			});
			toast.success(`MCP Server「${displayName.trim()}」已添加`);
			setCreateOpen(false);
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
						<Button type="button" size="sm" onClick={() => setCreateOpen(true)}><PlusIcon className="size-4" />添加 Server</Button>
					</div>
					<div className="grid gap-3">{catalog.servers.map((server) => (
						<article key={server.id} className="rounded-xl border bg-card p-4">
							<div className="flex items-start justify-between gap-4">
								<div className="min-w-0">
									<div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{server.displayName}</h3><code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{server.id}</code></div>
									{server.description ? <p className="mt-1 text-xs text-muted-foreground">{server.description}</p> : null}
									<p className="mt-3 truncate font-mono text-xs text-muted-foreground" title={endpointOf(server)}>{endpointOf(server)}</p>
								</div>
								<Button type="button" variant="ghost" size="icon" aria-label={`删除 ${server.displayName}`} onClick={() => setDeleting(server)}><Trash2Icon className="size-4" /></Button>
							</div>
							<div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 border-t pt-3 text-[11px] text-muted-foreground">
								<span>{server.definition.url ? "Remote HTTP" : "Local stdio"}</span>
								<span>密钥：{server.secretKeys.length ? server.secretKeys.join(", ") : "无"}</span>
								<span>已启用：{server.usedBy.length ? server.usedBy.map((agent) => agent.displayName).join("、") : "无 Agent"}</span>
							</div>
						</article>
					))}</div>
				</>
			) : (
				<div className="ops-empty-state flex min-h-64 flex-col items-center justify-center">
					<div className="text-sm font-medium">还没有 MCP Server</div>
					<Button type="button" size="sm" className="mt-4" onClick={() => setCreateOpen(true)}><PlusIcon className="size-4" />添加 Server</Button>
				</div>
			)}

			<Dialog open={createOpen} onOpenChange={(open) => { setCreateOpen(open); if (!open && !saving) resetDraft(); }}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader><DialogTitle>添加 MCP Server</DialogTitle><DialogDescription>command 与 url 请选择一种。</DialogDescription></DialogHeader>
					<div className="grid gap-4 sm:grid-cols-2">
						<label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">Server ID</span><Input value={id} onChange={(event) => setId(event.target.value)} placeholder="context7" className="font-mono text-xs" /></label>
						<label className="flex flex-col gap-1 text-sm"><span className="text-muted-foreground">显示名称</span><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Context7" /></label>
						<label className="flex flex-col gap-1 text-sm sm:col-span-2"><span className="text-muted-foreground">说明（可选）</span><Input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
						<label className="flex flex-col gap-1 text-sm sm:col-span-2"><span className="text-muted-foreground">Server definition（JSON）</span><Textarea value={definition} onChange={(event) => setDefinition(event.target.value)} rows={9} className="font-mono text-xs" /></label>
						<label className="flex flex-col gap-1 text-sm sm:col-span-2"><span className="text-muted-foreground">密钥环境变量（可选，每行 KEY=VALUE；保存后不回显）</span><Textarea value={secrets} onChange={(event) => setSecrets(event.target.value)} rows={3} className="font-mono text-xs" placeholder="API_TOKEN=…" /></label>
					</div>
					<DialogFooter><Button type="button" variant="ghost" disabled={saving} onClick={() => setCreateOpen(false)}>取消</Button><Button type="button" disabled={saving || !canSave} onClick={() => void create()}>{saving ? <LoaderIcon className="size-4 animate-spin" /> : null}添加</Button></DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={deleting !== null} onOpenChange={(open) => { if (!open && !deleteBusy) setDeleting(null); }}>
				<DialogContent><DialogHeader><DialogTitle>删除 MCP Server？</DialogTitle><DialogDescription>将删除「{deleting?.displayName}」的配置与加密密钥。仍被 Agent 勾选时服务端会拒绝删除。</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="ghost" disabled={deleteBusy} onClick={() => setDeleting(null)}>取消</Button><Button type="button" variant="destructive" disabled={deleteBusy} onClick={() => void remove()}>{deleteBusy ? <LoaderIcon className="size-4 animate-spin" /> : null}删除</Button></DialogFooter></DialogContent>
			</Dialog>
		</div>
	);
}
