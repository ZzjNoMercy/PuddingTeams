"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CheckIcon, LoaderIcon, SaveIcon, ServerIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { getAgentMcpServers, listMcpServers, putAgentMcpServers } from "@/lib/api";
import type { AgentConfig, McpServerRecord, MutationResponse } from "@/lib/types";

export function McpSelectionSection({ agent, onMutation }: { agent: AgentConfig; onMutation: (result: MutationResponse) => void }) {
	const [servers, setServers] = useState<McpServerRecord[] | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [baseline, setBaseline] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
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
	}, [agent.name, agent.extensionRevision]);

	const dirty = useMemo(() => JSON.stringify([...selected].sort()) !== JSON.stringify([...baseline].sort()), [selected, baseline]);

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
		<div className="agent-plugin-section flex flex-col gap-3">
			<div className="agent-mcp-toolbar">
				<span>{servers === null ? "正在读取 Server…" : `已选择 ${selected.length} / ${servers.length}`}</span>
				<Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <LoaderIcon className="size-4 animate-spin" /> : <SaveIcon className="size-4" />}保存选择</Button>
			</div>
			{servers === null ? (
				<div className="agent-plugin-loading flex items-center gap-2 text-sm text-muted-foreground"><LoaderIcon className="size-4 animate-spin" />正在读取 Server…</div>
			) : servers.length === 0 ? (
				<div className="agent-integration-empty">还没有 MCP Server。前往 <Link href="/extensions?tab=mcp" className="font-medium text-primary hover:underline">扩展 → MCP</Link> 添加。</div>
			) : (
				<div className="grid gap-3">
					{servers.map((server) => {
						const checked = selected.includes(server.id);
						return (
							<label key={server.id} className={`agent-config-card agent-plugin-binding-card agent-mcp-server-card ${checked ? "selected" : ""}`}>
								<input
									type="checkbox"
									className="sr-only"
									checked={checked}
									onChange={() => setSelected((current) => checked ? current.filter((id) => id !== server.id) : [...current, server.id])}
								/>
								<span className="agent-plugin-binding-icon"><ServerIcon className="size-4" /></span>
								<span className="min-w-0 flex-1">
									<span className="flex flex-wrap items-center gap-2 text-sm font-semibold">
										{server.displayName}
										<code className="agent-mcp-server-id">{server.id}</code>
									</span>
									<span className="agent-mcp-server-description">{server.description ?? (server.definition.url ? server.definition.url : server.definition.command)}</span>
								</span>
								<span className={`agent-mcp-check ${checked ? "selected" : ""}`} aria-hidden="true">{checked ? <CheckIcon className="size-3.5" /> : null}</span>
							</label>
						);
					})}
				</div>
			)}
		</div>
	);
}
