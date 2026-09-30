"use client";

import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { EyeIcon, LoaderIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { listWorkspaces, previewAgentPiResources } from "@/lib/api";
import type { AgentConfig, PiPreviewResource, PiResourcePreview, WorkspaceRecord } from "@/lib/types";
import type { ConfigDraft } from "@/components/agent-config/draft";
import { WorkspaceTrustBadge, workspaceTrustSuffix } from "@/components/chat/workspace-trust-badge";
import { ClipboardSafeStreamdown } from "@/components/ai-elements/streamdown";
import { streamdownPlugins } from "@/core/streamdown/plugins";

/** 预览里的链接 / 图片：不放开任意外链协议，不自动拉取外部图片。 */
const promptPreviewComponents = {
	a: ({ href, children, ...props }: ComponentProps<"a">) => {
		let safeHref: string | undefined;
		try {
			const url = href ? new URL(href) : null;
			if (url && ["https:", "http:", "mailto:"].includes(url.protocol)) safeHref = url.href;
		} catch { /* 相对链接在配置页没有可解析的基准。 */ }
		return safeHref
			? <a {...props} href={safeHref} target="_blank" rel="noopener noreferrer">{children}</a>
			: <span title="此链接不能在预览中打开">{children}</span>;
	},
	img: ({ alt }: ComponentProps<"img">) => <span className="agent-config-markdown-empty">[外部图片未加载：{alt || "无标题"}]</span>,
};

/** 有效提示词分段 source → 中文标签（含接收者标注，提示词管理方案 §9.9）。 */
const SEGMENT_SOURCE_LABELS: Record<string, string> = {
	"pi-base": "pi 基础提示词 · 内置",
	"pi-native-append": "pi 原生追加（APPEND_SYSTEM.md） · 用户文件",
	"agent-instructions": "Agent 运行指令 · 仅当前 Agent",
	"window-collaboration": "群聊协作提示词 · 仅 Manager",
	"global-context": "pi global 上下文（~/.pi/agent）",
	"workspace-context": "项目上下文（Workspace）",
};

function segmentSourceLabel(source: string): string {
	return SEGMENT_SOURCE_LABELS[source] ?? source;
}

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
	const [promptView, setPromptView] = useState<"edit" | "preview">("edit");
	const [workspaces, setWorkspaces] = useState<WorkspaceRecord[] | null>(null);
	const [workspacesError, setWorkspacesError] = useState<string | null>(null);
	const [workspacesRetry, setWorkspacesRetry] = useState(0);
	const [previewWorkspaceId, setPreviewWorkspaceId] = useState("");
	const [previewResult, setPreviewResult] = useState<{ agentName: string; workspaceId: string; data: PiResourcePreview } | null>(null);
	const [previewError, setPreviewError] = useState<{ scope: string; message: string } | null>(null);
	const [previewingScope, setPreviewingScope] = useState<string | null>(null);
	const previewRequest = useRef(0);
	const previewScope = JSON.stringify([agent.name, previewWorkspaceId]);
	const previewing = previewingScope === previewScope;

	useEffect(() => {
		let cancelled = false;
		void listWorkspaces()
			.then((rows) => { if (!cancelled) { setWorkspaces(rows); setWorkspacesError(null); } })
			.catch((error: unknown) => { if (!cancelled) { previewRequest.current += 1; setPreviewingScope(null); setWorkspacesError(error instanceof Error ? error.message : String(error)); setPreviewResult(null); } });
		return () => { cancelled = true; };
	}, [workspacesRetry]);
	const retryWorkspaces = () => {
		previewRequest.current += 1;
		setWorkspaces(null);
		setWorkspacesError(null);
		setPreviewResult(null);
		setPreviewingScope(null);
		setWorkspacesRetry((value) => value + 1);
	};

	const loadPreview = useCallback(async () => {
		const agentName = agent.name;
		const workspaceId = previewWorkspaceId;
		const scope = JSON.stringify([agentName, workspaceId]);
		const requestId = ++previewRequest.current;
		setPreviewingScope(scope);
		setPreviewError(null);
		setPreviewResult(null);
		try {
			const data = await previewAgentPiResources(agentName, workspaceId || undefined);
			if (requestId === previewRequest.current) setPreviewResult({ agentName, workspaceId, data });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (requestId === previewRequest.current) { setPreviewError({ scope, message }); toast.error(message); }
		} finally {
			setPreviewingScope((current) => current === scope ? null : current);
		}
	}, [agent.name, previewWorkspaceId]);

	const preview = workspaces && !workspacesError && previewResult?.agentName === agent.name && previewResult.workspaceId === previewWorkspaceId ? previewResult.data : null;
	const currentPreviewError = previewError?.scope === previewScope ? previewError.message : null;
	// §6.3/§7.2：项目上下文开关本身与"选哪个工作目录"无关——它只是每个 Agent 的
	// 一个布尔量，运行时会和会话实际所在目录的授权状态取交集
	// （piResourceLoaderOptions 里 `loadWorkspaceContext !== false && workspaceAccess.context`）。
	// 之前把它挂在预览用的目录下拉上，于是"没先选目录就打不开开关"，控件之间的
	// 从属关系是假的。现在开关恒可编辑，规则写在说明里；目录选择归预览分区。

	return (
		<div>
			<section className="agent-config-card">
			<div className="agent-config-card-head has-action">
				<div>
					<h2>系统提示词补充</h2>
					<p>追加到 Pi 的基础提示词后，不覆盖基础行为；留空不追加。</p>
				</div>
				<div className="agent-config-tabs" role="tablist" aria-label="提示词视图">
					<button type="button" role="tab" aria-selected={promptView === "edit"} className="agent-config-tab" onClick={() => setPromptView("edit")}>编辑</button>
					<button type="button" role="tab" aria-selected={promptView === "preview"} className="agent-config-tab" onClick={() => setPromptView("preview")}>预览</button>
				</div>
			</div>
			{/* 原型这一节只有一个等宽编辑器，没有字段标签，所以也没有字段说明行。
			    字符数和生效时机在这里都是噪音：生效时机由「模型」分区统一交代，
			    字符数在预览里看得到。 */}
			{promptView === "edit" ? (
				<Textarea
					value={draft.systemPrompt}
					onChange={(e) => onChange({ systemPrompt: e.target.value })}
					rows={4}
					placeholder="执行流程、输出格式、验证要求、交付约定"
					className="agent-config-prompt-editor"
					aria-label={agent.pinned ? "Manager 运行指令" : "Worker 运行指令"}
				/>
			) : draft.systemPrompt.trim() ? (
				<div className="agent-config-markdown">
					<ClipboardSafeStreamdown {...streamdownPlugins} components={promptPreviewComponents}>{draft.systemPrompt}</ClipboardSafeStreamdown>
				</div>
			) : (
				<div className="agent-config-markdown"><p className="agent-config-markdown-empty">还没有提示词内容，切回「编辑」开始写。</p></div>
			)}
			</section>

			<section className="agent-config-card">
			<div className="agent-config-card-head"><h2>上下文注入</h2><p>控制该 Agent 运行时能读到哪些项目材料。</p></div>
			<div className="flex flex-col">
			<label className="agent-config-toggle">
				<span>
					<strong>加载项目上下文（AGENTS.md / CLAUDE.md）</strong>
					<small>仅在会话的工作目录受信任时读取；未选择工作目录时不加载项目文件。</small>
				</span>
				<input
					type="checkbox"
					role="switch"
					checked={draft.loadWorkspaceContext}
					onChange={(e) => onChange({ loadWorkspaceContext: e.target.checked })}
				/>
			</label>
			</div>
			</section>

			{/* Workspace 选择 + 按钮属于"有效提示词预览"，不是"上下文注入"：它不改任何配置，
			    只是选一个目录让服务端把提示词真拼一遍给你看。放在结果同一节里，
			    触发器和结果不再跨分区。 */}
			<section className="agent-config-card">
			<div className="agent-config-card-head has-action">
				<div>
					<h2>有效提示词预览</h2>
					<p>服务端按所选工作目录实际拼装的提示词，只看不改。</p>
				</div>
				<div className="flex items-center gap-2">
					<select
						value={previewWorkspaceId}
						disabled={workspaces === null || workspacesError !== null || previewing}
						onChange={(e) => { setPreviewWorkspaceId(e.target.value); setPreviewError(null); }}
						className="agent-config-preview-scope"
						aria-label="选择用于预览的工作目录"
					>
						<option value="">平台默认目录</option>
						{workspaces?.map((workspace) => (
							<option key={workspace.id} value={workspace.id} disabled={!workspace.available}>
								{workspace.name}{workspaceTrustSuffix(workspace.trust)}
							</option>
						))}
					</select>
					<Button size="sm" variant="outline" disabled={previewing || workspaces === null || workspacesError !== null} onClick={() => void loadPreview()}>
						{previewing ? <LoaderIcon className="size-3.5 animate-spin" /> : <EyeIcon className="size-3.5" />}
						{preview ? "重新拼装" : "拼装并预览"}
					</Button>
				</div>
			</div>
			{workspacesError ? <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 text-xs text-destructive">
				<span>工作空间列表读取失败，无法核对提示词预览范围。</span>
				<Button type="button" size="sm" variant="outline" onClick={retryWorkspaces}>重试工作空间列表</Button>
			</div> : null}
			{currentPreviewError ? <p role="alert" className="text-xs text-destructive">提示词预览失败：{currentPreviewError}</p> : null}
			<div className="flex flex-col">
			{!preview && !currentPreviewError ? (
				<p className="agent-config-markdown-empty">还没有拼装结果。选一个工作目录后点「拼装并预览」，这里会显示服务端实际发给该 Agent 的完整提示词分段。</p>
			) : null}
			{preview ? (
				<div className="agent-config-preview space-y-2 p-3 text-xs">
					<div className="flex items-center gap-2">
						运行目录：<code>{preview.cwd}</code>
						{preview.workspace ? <WorkspaceTrustBadge trust={preview.workspace.trust} /> : null}
					</div>
					<div>
						Templates {preview.prompts.filter((p) => p.enabled).length}/{preview.prompts.length} 启用 · Context{" "}
						{preview.contextFiles.length} · 估算 {preview.estimatedCharacters} 字符
					</div>
					{preview.segments.map((segment, index) => (
						<details key={`${segment.source}-${segment.path ?? index}`} open={!segment.collapsed}>
							<summary className="cursor-pointer font-medium">
								{segmentSourceLabel(segment.source)}
								{segment.path ? ` · ${segment.path}` : ""}
							</summary>
							<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-muted-foreground">{segment.content}</pre>
						</details>
					))}
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
			</section>
		</div>
	);
}
