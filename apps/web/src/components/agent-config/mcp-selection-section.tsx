"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderIcon, RefreshCwIcon, SaveIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ApiConflictError, getAgentMcpServers, listMcpServers, putAgentMcpServers } from "@/lib/api";
import type { AgentConfig, McpServerRecord, MutationResponse } from "@/lib/types";
import { clearMcpSelectionDraft, loadMcpSelectionDraft, saveMcpSelectionDraft } from "./mcp-selection-draft";

export function McpSelectionSection({ agent, onMutation }: { agent: AgentConfig; onMutation: (result: MutationResponse) => void }) {
	const [servers, setServers] = useState<McpServerRecord[] | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [baseline, setBaseline] = useState<string[]>([]);
	const [readRevision, setReadRevision] = useState<number | null>(null);
	const [readError, setReadError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveUnconfirmed, setSaveUnconfirmed] = useState(false);
	const [reconciledMessage, setReconciledMessage] = useState<string | null>(null);
	const [conflict, setConflict] = useState(false);
	const [readAttempt, setReadAttempt] = useState(0);
	const [saving, setSaving] = useState(false);
	const reconcileOnRead = useRef<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		Promise.all([listMcpServers(), getAgentMcpServers(agent.name)])
			.then(([catalog, binding]) => {
				if (cancelled) return;
				const saved = loadMcpSelectionDraft(agent.name);
				setServers(catalog.servers);
				setBaseline(binding.serverIds);
				setReadRevision(binding.revision);
				setReadError(null);
				setSaveError(null);
				if (reconcileOnRead.current === agent.name && saved) {
					reconcileOnRead.current = null;
					const same = JSON.stringify([...saved.selected].sort()) === JSON.stringify([...binding.serverIds].sort());
					if (same) {
						clearMcpSelectionDraft(agent.name);
						setSelected(binding.serverIds);
						setReconciledMessage("服务器已包含这次选择，无需再次保存。");
					} else {
						setSelected(saved.selected);
						saveMcpSelectionDraft(agent.name, { selected: saved.selected, revision: binding.revision, status: "draft" });
						setReconciledMessage("服务器尚未包含当前草稿。请核对勾选后，再决定是否保存。");
					}
					setSaveUnconfirmed(false);
					setConflict(false);
				} else if (saved) {
					setSelected(saved.selected);
					setSaveUnconfirmed(saved.status === "unconfirmed");
					setConflict(saved.status === "conflict" || (saved.status === "draft" && saved.revision !== binding.revision));
					setReconciledMessage(null);
				} else {
					setSelected(binding.serverIds);
					setSaveUnconfirmed(false);
					setConflict(false);
					setReconciledMessage(null);
				}
			})
			.catch((err: unknown) => { if (!cancelled) setReadError(err instanceof Error ? err.message : String(err)); });
		return () => { cancelled = true; };
	}, [agent.name, readAttempt]);

	const dirty = useMemo(() => JSON.stringify([...selected].sort()) !== JSON.stringify([...baseline].sort()), [selected, baseline]);
	const dataReady = servers !== null && readRevision !== null && !readError;
	const stale = conflict || (readRevision !== null && readRevision < (agent.extensionRevision ?? 0));
	const ready = dataReady && !stale && !saveUnconfirmed;
	const retryRead = (preserveDraft = false) => {
		if (preserveDraft) reconcileOnRead.current = agent.name;
		else {
			reconcileOnRead.current = null;
			clearMcpSelectionDraft(agent.name);
		}
		setServers(null);
		setReadRevision(null);
		setReadError(null);
		setSaveError(null);
		setReconciledMessage(null);
		setReadAttempt((attempt) => attempt + 1);
	};

	const save = async () => {
		if (!ready || saving || readRevision === null) return;
		const submitted = [...selected];
		setSaving(true);
		setSaveError(null);
		try {
			const result = await putAgentMcpServers(agent.name, submitted, readRevision);
			setReadRevision(null);
			clearMcpSelectionDraft(agent.name);
			onMutation(result);
			setBaseline(submitted);
			setReadAttempt((attempt) => attempt + 1);
			toast.success(`MCP Server 选择已保存；${submitted.length} 个已启用`);
		} catch (err) {
			if (err instanceof ApiConflictError) {
				setSaveError(err.message);
				setConflict(true);
				saveMcpSelectionDraft(agent.name, { selected: submitted, revision: readRevision, status: "conflict" });
			} else {
				// A response can be lost after the server accepted the PUT. Keep the
				// draft and require a fresh server read before another mutation.
				setSaveUnconfirmed(true);
				saveMcpSelectionDraft(agent.name, { selected: submitted, revision: readRevision, status: "unconfirmed" });
			}
		} finally {
			setSaving(false);
		}
	};

	return (
		<section className="agent-config-card">
			{/* 标题 + 保存同排：MCP 走独立 revision 冲突协议，不随页面「保存」提交。 */}
			<div className="agent-config-card-head has-action">
				<div className="min-w-0">
					<h2>可用 MCP 服务</h2>
					<p>选择此智能体可用的服务，单独保存选择。</p>
					<p>地址与凭据在 <Link href="/extensions?tab=mcp" className="agent-config-text-link">扩展 → MCP</Link> 管理。</p>
				</div>
				<div className="agent-config-section-actions">
					<span className="agent-config-muted-note">{readError ? "读取失败" : stale ? `选择已过期 · 草稿 ${selected.length} / ${servers?.length ?? 0}` : !dataReady ? "正在确认…" : `已选 ${selected.length} / ${servers!.length}`}</span>
					<Button type="button" size="sm" disabled={!ready || !dirty || saving} onClick={() => void save()}>{saving ? <LoaderIcon className="size-3.5 animate-spin" /> : <SaveIcon className="size-3.5" />}保存选择</Button>
				</div>
			</div>
			{readError || stale ? (
				<div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
					<span>{stale ? "MCP 选择已被其他操作修改。下方保留当前选择草稿；请核对后读取最新值。" : `MCP Server 目录或 Agent 选择读取失败：${readError}`}</span>
						<Button type="button" size="sm" variant="outline" onClick={() => retryRead(stale || Boolean(loadMcpSelectionDraft(agent.name)))}><RefreshCwIcon className="size-3.5" />{stale ? "读取最新并核对草稿" : "读取最新"}</Button>
				</div>
			) : saveUnconfirmed ? (
				<div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
					<span>MCP 选择保存结果未确认；服务器可能已保存。当前草稿仍保留，请先读取最新值核对，不要直接重复保存。</span>
						<Button type="button" size="sm" variant="outline" onClick={() => retryRead(true)}><RefreshCwIcon className="size-3.5" />读取最新并核对草稿</Button>
				</div>
			) : !ready ? (
				<div className="agent-plugin-loading flex items-center gap-2 text-sm text-muted-foreground"><LoaderIcon className="size-4 animate-spin" />正在读取 Server…</div>
			) : reconciledMessage ? (
				<div role="status" className="text-sm text-muted-foreground">{reconciledMessage}</div>
			) : saveError ? (
				<div role="alert" className="text-sm text-destructive">保存失败，已保留选择草稿：{saveError}</div>
			) : null}
			{dataReady && servers.length === 0 ? (
				<div className="agent-config-empty">
					还没有 MCP Server。前往
					<Link href="/extensions?tab=mcp" className="mx-1 text-primary hover:underline">扩展 → MCP</Link>
					添加。
				</div>
			) : dataReady ? (
				<div className="agent-config-choice-list">
					{servers.map((server) => {
						const checked = selected.includes(server.id);
						return (
							<label key={server.id} className="agent-config-choice">
								<input
									type="checkbox"
									disabled={stale || saving}
									checked={checked}
									onChange={() => {
										const next = checked ? selected.filter((id) => id !== server.id) : [...selected, server.id];
										setSelected(next);
										setReconciledMessage(null);
										saveMcpSelectionDraft(agent.name, { selected: next, revision: readRevision!, status: saveUnconfirmed ? "unconfirmed" : "draft" });
									}}
								/>
								<span className="min-w-0 flex-1">
									<strong className="flex flex-wrap items-center gap-2">
										{server.displayName}
										<code className="agent-config-mono-tag">{server.id}</code>
									</strong>
									<small>{server.description ?? (server.definition.url ? server.definition.url : server.definition.command)}</small>
								</span>
								<span className={`agent-config-choice-state ${checked ? "is-on" : ""}`}>
									{checked ? "已启用" : "未启用"}
								</span>
							</label>
						);
					})}
				</div>
			) : null}
		</section>
	);
}
