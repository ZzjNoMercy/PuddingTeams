"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { LoaderIcon, SaveIcon, ServerIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getAgentMcpServers, listMcpServers, putAgentMcpServers } from "@/lib/api";
import type { AgentConfig, McpServerRecord, MutationResponse } from "@/lib/types";

function isPiAgent(agent: AgentConfig): boolean {
	return agent.pinned === true || agent.connector?.connectorId === "pi";
}

export function McpSelectionSection({ agent, onMutation }: { agent: AgentConfig; onMutation: (result: MutationResponse) => void }) {
	const piAgent = isPiAgent(agent);
	const [servers, setServers] = useState<McpServerRecord[] | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [baseline, setBaseline] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!piAgent) return;
		let cancelled = false;
		Promise.all([listMcpServers(), getAgentMcpServers(agent.name)])
			.then(([catalog, binding]) => {
				if (cancelled) return;
				setServers(catalog.servers);
				setSelected(binding.serverIds);
				setBaseline(binding.serverIds);
			})
			.catch((err: unknown) => { if (!cancelled) toast.error(err instanceof Error ? err.message : String(err)); });
		return () => { cancelled = true; };
	}, [agent.name, agent.extensionRevision, piAgent]);

	const dirty = useMemo(() => JSON.stringify([...selected].sort()) !== JSON.stringify([...baseline].sort()), [selected, baseline]);

	if (!piAgent) {
		return (
			<section className="rounded-xl border bg-card p-5">
				<div className="flex items-center gap-2 text-sm font-semibold"><ServerIcon className="size-4" />MCP Servers</div>
				<p className="mt-2 text-xs text-muted-foreground">平台 MCP adapter 运行在 Pi Session 中；当前 Worker 的 Connector 不是 Pi，不能注入这组 Server。</p>
			</section>
		);
	}

	const save = async () => {
		setSaving(true);
		try {
			const result = await putAgentMcpServers(agent.name, selected);
			onMutation(result);
			setBaseline(selected);
			toast.success(`MCP Server 选择已保存；${selected.length} 个已启用`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<section className="rounded-xl border bg-card p-5">
			<div className="flex items-start justify-between gap-4">
				<div><div className="flex items-center gap-2 text-sm font-semibold"><ServerIcon className="size-4" />MCP Servers</div><p className="mt-1 text-xs text-muted-foreground">只把勾选的 Server 注入当前 Pi Agent；基础 adapter 默认启用。</p></div>
				<Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <LoaderIcon className="size-4 animate-spin" /> : <SaveIcon className="size-4" />}保存选择</Button>
			</div>
			{servers === null ? (
				<div className="flex items-center gap-2 py-6 text-xs text-muted-foreground"><LoaderIcon className="size-4 animate-spin" />加载 Server 全集…</div>
			) : servers.length === 0 ? (
				<p className="mt-4 rounded-lg bg-muted/50 px-3 py-3 text-xs text-muted-foreground">还没有 MCP Server。前往 <Link href="/extensions?tab=mcp" className="font-medium text-primary hover:underline">扩展 → MCP</Link> 添加。</p>
			) : (
				<div className="mt-4 grid gap-2">
					{servers.map((server) => {
						const checked = selected.includes(server.id);
						return (
							<label key={server.id} className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 hover:bg-muted/30">
								<input type="checkbox" className="mt-0.5" checked={checked} onChange={() => setSelected((current) => checked ? current.filter((id) => id !== server.id) : [...current, server.id])} />
								<span className="min-w-0"><span className="flex flex-wrap items-center gap-2 text-sm font-medium">{server.displayName}<code className="rounded bg-muted px-1 py-0.5 text-[10px] font-normal">{server.id}</code></span><span className="mt-1 block text-xs text-muted-foreground">{server.description ?? (server.definition.url ? server.definition.url : server.definition.command)}</span></span>
							</label>
						);
					})}
				</div>
			)}
		</section>
	);
}
