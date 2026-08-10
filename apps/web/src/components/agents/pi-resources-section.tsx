"use client";

import { useCallback, useEffect, useState } from "react";
import { EyeIcon, LoaderIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { listWorkspaces, previewAgentPiResources, putAgentPiResources } from "@/lib/api";
import type { AgentConfig, MutationResponse, PiResourceConfig, PiResourcePreview, WorkspaceRecord } from "@/lib/types";

function paths(value: string): string[] {
	return [...new Set(value.split(/\n/).map((item) => item.trim()).filter(Boolean))];
}

function ResourceToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
	return (
		<label className="flex items-center gap-2 text-xs">
			<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 accent-foreground" />
			{label}
		</label>
	);
}

export function PiResourcesSection({
	agent,
	onSaved,
}: {
	agent: AgentConfig;
	onSaved: (agent: AgentConfig, mutation?: MutationResponse) => void;
}) {
	const initial = agent.piResources ?? {};
	const [systemPrompt, setSystemPrompt] = useState(initial.systemPrompt ?? "");
	const [skillPaths, setSkillPaths] = useState((initial.skillPaths ?? []).join("\n"));
	const [promptPaths, setPromptPaths] = useState((initial.promptTemplatePaths ?? []).join("\n"));
	const [loadGlobalSkills, setLoadGlobalSkills] = useState(initial.loadGlobalSkills !== false);
	const [loadWorkspaceSkills, setLoadWorkspaceSkills] = useState(initial.loadWorkspaceSkills !== false);
	const [loadGlobalPrompts, setLoadGlobalPrompts] = useState(initial.loadGlobalPrompts !== false);
	const [loadWorkspacePrompts, setLoadWorkspacePrompts] = useState(initial.loadWorkspacePrompts !== false);
	const [loadWorkspaceContext, setLoadWorkspaceContext] = useState(initial.loadWorkspaceContext !== false);
	const [saving, setSaving] = useState(false);
	const [previewing, setPreviewing] = useState(false);
	const [preview, setPreview] = useState<PiResourcePreview | null>(null);
	const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
	const [previewWorkspaceId, setPreviewWorkspaceId] = useState("");

	useEffect(() => {
		void listWorkspaces().then(setWorkspaces).catch(() => undefined);
	}, []);

	const value = useCallback((): PiResourceConfig => ({
		...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
		...(paths(skillPaths).length ? { skillPaths: paths(skillPaths) } : {}),
		...(paths(promptPaths).length ? { promptTemplatePaths: paths(promptPaths) } : {}),
		loadGlobalSkills,
		loadWorkspaceSkills,
		loadGlobalPrompts,
		loadWorkspacePrompts,
		loadWorkspaceContext,
	}), [loadGlobalPrompts, loadGlobalSkills, loadWorkspaceContext, loadWorkspacePrompts, loadWorkspaceSkills, promptPaths, skillPaths, systemPrompt]);

	const save = useCallback(async () => {
		setSaving(true);
		try {
			const mutation = await putAgentPiResources(agent.name, value());
			onSaved(mutation.agent, mutation);
			toast.success("提示词与资源已保存；新建或重开的 Session 生效");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [agent, onSaved, value]);

	const reset = useCallback(async () => {
		setSaving(true);
		try {
			const mutation = await putAgentPiResources(agent.name, null);
			setSystemPrompt("");
			setSkillPaths("");
			setPromptPaths("");
			setLoadGlobalSkills(true);
			setLoadWorkspaceSkills(true);
			setLoadGlobalPrompts(true);
			setLoadWorkspacePrompts(true);
			setLoadWorkspaceContext(true);
			setPreview(null);
			onSaved(mutation.agent, mutation);
			toast.success("已清空 Agent Resource Profile；Workspace 与 Window 配置未修改");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}, [agent.name, onSaved]);

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
		<div className="flex flex-col gap-3 rounded-md bg-muted/60 p-3">
			<div>
				<div className="text-sm font-medium">提示词与资源</div>
				<div className="text-xs text-muted-foreground">只属于该 Pi Agent；不修改 Window 协作提示词或 Workspace 文件。</div>
			</div>
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">系统提示词</span>
				<Textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={5} placeholder="长期人格、职责与行为规则；留空表示不追加 Agent Profile。" />
			</label>
			<div className="grid gap-3 sm:grid-cols-2">
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">额外 Skill paths（每行一个）</span>
					<Textarea value={skillPaths} onChange={(event) => setSkillPaths(event.target.value)} rows={3} className="font-mono text-xs" />
				</label>
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">额外 Prompt template paths（每行一个）</span>
					<Textarea value={promptPaths} onChange={(event) => setPromptPaths(event.target.value)} rows={3} className="font-mono text-xs" />
				</label>
			</div>
			<div className="grid gap-2 sm:grid-cols-2">
				<ResourceToggle label="加载全局 Skills" checked={loadGlobalSkills} onChange={setLoadGlobalSkills} />
				<ResourceToggle label="加载 Workspace Skills" checked={loadWorkspaceSkills} onChange={setLoadWorkspaceSkills} />
				<ResourceToggle label="加载全局 Prompt templates" checked={loadGlobalPrompts} onChange={setLoadGlobalPrompts} />
				<ResourceToggle label="加载 Workspace Prompt templates" checked={loadWorkspacePrompts} onChange={setLoadWorkspacePrompts} />
				<ResourceToggle label="加载 Workspace context（AGENTS.md / CLAUDE.md）" checked={loadWorkspaceContext} onChange={setLoadWorkspaceContext} />
			</div>
			<div className="flex gap-2">
				<Button size="sm" disabled={saving} onClick={() => void save()}>{saving ? <LoaderIcon className="size-3.5 animate-spin" /> : null}保存资源</Button>
				<Button size="sm" variant="ghost" disabled={saving} onClick={() => void reset()}>恢复为空</Button>
				<select value={previewWorkspaceId} onChange={(event) => setPreviewWorkspaceId(event.target.value)} className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs">
					<option value="">无显式 Workspace（平台默认目录）</option>
					{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id} disabled={!workspace.available}>{workspace.name} · {workspace.rootPath}</option>)}
				</select>
				<Button size="sm" variant="outline" disabled={previewing} onClick={() => void loadPreview()}>{previewing ? <LoaderIcon className="size-3.5 animate-spin" /> : <EyeIcon className="size-3.5" />}有效配置预览</Button>
			</div>
			{preview ? (
				<div className="space-y-2 rounded-md border bg-background/70 p-2.5 text-xs">
					<div>运行目录：<code>{preview.cwd}</code></div>
					<div>Skills {preview.skills.length} · Templates {preview.prompts.length} · Context {preview.contextFiles.length} · 估算 {preview.estimatedCharacters} 字符</div>
					{preview.segments.map((segment, index) => (
						<details key={`${segment.source}-${segment.path ?? index}`} open={!segment.collapsed}>
							<summary className="cursor-pointer font-medium">{segment.source}{segment.path ? ` · ${segment.path}` : ""}</summary>
							<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-muted-foreground">{segment.content}</pre>
						</details>
					))}
					{preview.diagnostics.map((item, index) => <div key={index} className="text-destructive">{item.message}{item.path ? ` · ${item.path}` : ""}</div>)}
				</div>
			) : null}
		</div>
	);
}
