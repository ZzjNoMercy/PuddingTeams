"use client";

import { useCallback, useEffect, useState } from "react";
import { EyeIcon, LoaderIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { listWorkspaces, previewAgentPiResources } from "@/lib/api";
import type { AgentConfig, PiPreviewResource, PiResourcePreview, WorkspaceRecord } from "@/lib/types";
import type { ConfigDraft } from "@/components/agent-config/draft";

function ResourceLine({ item }: { item: PiPreviewResource }) {
	return (
		<div className="flex items-center gap-1.5 text-xs">
			<Badge variant={item.enabled ? "secondary" : "outline"} className={item.enabled ? "" : "opacity-60"}>
				{item.enabled ? "启用" : "未启用"}
			</Badge>
			<code className="font-mono">{item.name}</code>
			<span className="truncate text-muted-foreground">{item.description}</span>
			<span className="ml-auto shrink-0 text-muted-foreground/60">
				{item.source === "global" ? "库" : item.source === "workspace" ? "workspace" : "额外来源"}
			</span>
		</div>
	);
}

/** 提示词分区：systemPrompt + workspace context 开关 + 有效提示词预览。 */
export function PromptSection({
	agent,
	draft,
	onChange,
}: {
	agent: AgentConfig;
	draft: ConfigDraft;
	onChange: (patch: Partial<ConfigDraft>) => void;
}) {
	const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
	const [previewWorkspaceId, setPreviewWorkspaceId] = useState("");
	const [preview, setPreview] = useState<PiResourcePreview | null>(null);
	const [previewing, setPreviewing] = useState(false);

	useEffect(() => {
		void listWorkspaces().then(setWorkspaces).catch(() => undefined);
	}, []);

	const loadPreview = useCallback(async () => {
		setPreviewing(true);
		try {
			setPreview(await previewAgentPiResources(agent.name, previewWorkspaceId || undefined));
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setPreviewing(false);
		}
	}, [agent.name, previewWorkspaceId]);

	return (
		<div className="flex flex-col gap-3">
			<p className="text-xs text-muted-foreground">
				只属于该 Agent 的提示词与资源开关；不修改 Window 协作提示词或 Workspace 文件。预览展示的是
				<strong>已保存配置</strong>的有效结果，草稿改动需保存后再预览。
			</p>
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">系统提示词（Agent Profile，留空不追加）</span>
				<Textarea
					value={draft.systemPrompt}
					onChange={(e) => onChange({ systemPrompt: e.target.value })}
					rows={8}
					placeholder="长期人格、职责与行为规则"
					className="font-mono text-xs"
				/>
			</label>
			<label className="flex items-start gap-2 text-sm">
				<input
					type="checkbox"
					checked={draft.loadWorkspaceContext}
					onChange={(e) => onChange({ loadWorkspaceContext: e.target.checked })}
					className="mt-0.5 size-4 accent-foreground"
				/>
				<span className="flex flex-col">
					<span>加载 Workspace context（AGENTS.md / CLAUDE.md）</span>
					<span className="text-xs text-muted-foreground/70">关闭后不注入项目目录里的上下文文件</span>
				</span>
			</label>

			<div className="flex items-center gap-2">
				<select
					value={previewWorkspaceId}
					onChange={(e) => setPreviewWorkspaceId(e.target.value)}
					className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs"
				>
					<option value="">无显式 Workspace（平台默认目录）</option>
					{workspaces.map((workspace) => (
						<option key={workspace.id} value={workspace.id} disabled={!workspace.available}>
							{workspace.name} · {workspace.rootPath}
						</option>
					))}
				</select>
				<Button size="sm" variant="outline" disabled={previewing} onClick={() => void loadPreview()}>
					{previewing ? <LoaderIcon className="size-3.5 animate-spin" /> : <EyeIcon className="size-3.5" />}
					有效提示词预览
				</Button>
			</div>

			{preview ? (
				<div className="space-y-2 rounded-md border bg-background/70 p-2.5 text-xs">
					<div>
						运行目录：<code>{preview.cwd}</code>
					</div>
					<div>
						Skills {preview.skills.filter((s) => s.enabled).length}/{preview.skills.length} 启用 · Templates{" "}
						{preview.prompts.filter((p) => p.enabled).length}/{preview.prompts.length} 启用 · Context{" "}
						{preview.contextFiles.length} · 估算 {preview.estimatedCharacters} 字符
					</div>
					{preview.segments.map((segment, index) => (
						<details key={`${segment.source}-${segment.path ?? index}`} open={!segment.collapsed}>
							<summary className="cursor-pointer font-medium">
								{segment.source}
								{segment.path ? ` · ${segment.path}` : ""}
							</summary>
							<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-muted-foreground">{segment.content}</pre>
						</details>
					))}
					{preview.skills.length > 0 ? (
						<div className="flex flex-col gap-1">
							<span className="font-medium">Skills</span>
							{preview.skills.map((item) => (
								<ResourceLine key={`${item.source}-${item.name}`} item={item} />
							))}
						</div>
					) : null}
					{preview.prompts.length > 0 ? (
						<div className="flex flex-col gap-1">
							<span className="font-medium">Prompt templates</span>
							{preview.prompts.map((item) => (
								<ResourceLine key={`${item.source}-${item.name}`} item={item} />
							))}
						</div>
					) : null}
					{preview.diagnostics.map((item, index) => (
						<div key={index} className="text-destructive">
							{item.message}
							{item.path ? ` · ${item.path}` : ""}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}
