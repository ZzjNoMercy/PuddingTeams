"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderOpenIcon, LoaderIcon, PencilIcon, PlusIcon, TrashIcon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
	createSkillResource,
	createTemplateResource,
	deleteSkillResource,
	deleteTemplateResource,
	getSkillResource,
	getTemplateResource,
	importSkillResource,
	importTemplateResource,
	listSkillLibrary,
	listTemplateLibrary,
	pickWorkspaceDirectory,
	previewAgentPiResources,
	updateSkillResource,
	updateTemplateResource,
} from "@/lib/api";
import type { AgentConfig, PiPreviewResource, ResourceDiagnostic } from "@/lib/types";
import type { ConfigDraft } from "@/components/agent-config/draft";

/**
 * 技能 / 模板分区（共用）：库资源表格 + 本 Agent 选用 toggle（白名单语义，
 * 默认关；只改草稿，随页面级统一保存提交）。库的增删改/导入即时生效——
 * 直接写 pi 全局目录，操作后刷新表格与 diagnostics。
 */

type Kind = "skills" | "templates";

interface ResourceRow {
	name: string;
	description: string;
	path: string;
	disableModelInvocation?: boolean;
	argumentHint?: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const KIND_TEXT: Record<
	Kind,
	{ title: string; libraryHint: string; importHint: string; contentPlaceholder: string; workspaceToggle: string; pathsLabel: string }
> = {
	skills: {
		title: "技能（Skills）",
		libraryHint: "库 = pi 全局目录（与 pi CLI 共享）。勾选「选用」才把该技能交给此 Agent 加载。",
		importHint: "导入含 SKILL.md 的目录（或单个 SKILL.md 文件）到库；重名会拒绝。",
		contentPlaceholder: "SKILL.md 正文（frontmatter 由上方字段生成）",
		workspaceToggle: "加载 Workspace Skills（项目目录 .pi/skills）",
		pathsLabel: "额外 Skill 挂载路径（每行一个；不受白名单管，始终加载）",
	},
	templates: {
		title: "模板（Prompt templates）",
		libraryHint: "库 = pi 全局目录（与 pi CLI 共享）。勾选「选用」后此 Agent 才能在聊天里用 /模板名 展开。",
		importHint: "导入单个 .md 模板文件到库；重名会拒绝。",
		contentPlaceholder: "模板正文。占位符：$1、$2… 取第 N 个参数；$@ 取全部参数；${1:-default} 带默认值。",
		workspaceToggle: "加载 Workspace Prompt templates（项目目录 .pi/prompts）",
		pathsLabel: "额外模板挂载路径（每行一个；不受白名单管，始终加载）",
	},
};

async function listLibrary(kind: Kind): Promise<{ rows: ResourceRow[]; diagnostics: ResourceDiagnostic[] }> {
	if (kind === "skills") {
		const { skills, diagnostics } = await listSkillLibrary();
		return { rows: skills, diagnostics };
	}
	const { templates, diagnostics } = await listTemplateLibrary();
	return { rows: templates, diagnostics };
}

export function ResourceLibrarySection({
	kind,
	agent,
	draft,
	onChange,
}: {
	kind: Kind;
	agent: AgentConfig;
	draft: ConfigDraft;
	onChange: (patch: Partial<ConfigDraft>) => void;
}) {
	const text = KIND_TEXT[kind];
	const enabled = kind === "skills" ? draft.enabledSkills : draft.enabledPrompts;
	const [rows, setRows] = useState<ResourceRow[] | null>(null);
	const [diagnostics, setDiagnostics] = useState<ResourceDiagnostic[]>([]);
	const [extras, setExtras] = useState<PiPreviewResource[]>([]);
	const [editorOpen, setEditorOpen] = useState(false);
	const [editing, setEditing] = useState<string | null>(null);
	const [formName, setFormName] = useState("");
	const [formDescription, setFormDescription] = useState("");
	const [formDisableModel, setFormDisableModel] = useState(false);
	const [formArgumentHint, setFormArgumentHint] = useState("");
	const [formContent, setFormContent] = useState("");
	const [formError, setFormError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	const [importPath, setImportPath] = useState("");
	const [importing, setImporting] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const { rows, diagnostics } = await listLibrary(kind);
			setRows(rows);
			setDiagnostics(diagnostics);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
			setRows([]);
		}
	}, [kind]);

	useEffect(() => {
		let cancelled = false;
		listLibrary(kind)
			.then(({ rows, diagnostics }) => {
				if (cancelled) return;
				setRows(rows);
				setDiagnostics(diagnostics);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				toast.error(err instanceof Error ? err.message : String(err));
				setRows([]);
			});
		return () => {
			cancelled = true;
		};
	}, [kind]);

	// 额外来源（~/.agents/skills 等）：始终启用、不受白名单管，单独列出。
	useEffect(() => {
		previewAgentPiResources(agent.name)
			.then((preview) => {
				const list = kind === "skills" ? preview.skills : preview.prompts;
				setExtras(list.filter((item) => item.source === "extra"));
			})
			.catch(() => undefined);
	}, [agent.name, kind]);

	const setEnabledList = (next: string[]) => {
		onChange(kind === "skills" ? { enabledSkills: next } : { enabledPrompts: next });
	};

	const toggle = (name: string, checked: boolean) => {
		setEnabledList(checked ? [...enabled, name] : enabled.filter((item) => item !== name));
	};

	const openCreate = () => {
		setEditing(null);
		setFormName("");
		setFormDescription("");
		setFormDisableModel(false);
		setFormArgumentHint("");
		setFormContent("");
		setFormError(null);
		setEditorOpen(true);
	};

	const openEdit = async (name: string) => {
		try {
			const doc = kind === "skills" ? await getSkillResource(name) : await getTemplateResource(name);
			setEditing(name);
			setFormName(doc.name);
			setFormDescription(doc.description);
			setFormDisableModel("disableModelInvocation" in doc ? doc.disableModelInvocation : false);
			setFormArgumentHint("argumentHint" in doc ? (doc.argumentHint ?? "") : "");
			setFormContent(doc.content);
			setFormError(null);
			setEditorOpen(true);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	};

	const handleSave = async () => {
		setFormError(null);
		const name = formName.trim();
		if (!NAME_PATTERN.test(name)) return setFormError("名称必须匹配 ^[a-z0-9][a-z0-9-]{0,63}$");
		if (!formContent.trim()) return setFormError("正文不能为空");
		setSaving(true);
		try {
			const input = {
				content: formContent,
				...(formDescription.trim() ? { description: formDescription.trim() } : {}),
				...(kind === "skills"
					? { disableModelInvocation: formDisableModel }
					: formArgumentHint.trim()
						? { argumentHint: formArgumentHint.trim() }
						: {}),
			};
			const result =
				kind === "skills"
					? editing
						? await updateSkillResource(editing, input)
						: await createSkillResource({ name, ...input })
					: editing
						? await updateTemplateResource(editing, input)
						: await createTemplateResource({ name, ...input });
			setDiagnostics(result.diagnostics);
			toast.success(editing ? `「${name}」已更新` : `「${name}」已加入库`);
			setEditorOpen(false);
			void refresh();
		} catch (err) {
			setFormError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const handleImport = async () => {
		const path = importPath.trim();
		if (!path) return;
		setImporting(true);
		try {
			if (kind === "skills") {
				const result = await importSkillResource(path);
				setDiagnostics(result.diagnostics);
				toast.success(`已导入「${result.skill.name}」`);
			} else {
				const result = await importTemplateResource(path);
				setDiagnostics(result.diagnostics);
				toast.success(`已导入「${result.template.name}」`);
			}
			setImportOpen(false);
			setImportPath("");
			void refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setImporting(false);
		}
	};

	const handlePickDirectory = async () => {
		try {
			const picked = await pickWorkspaceDirectory(importPath.trim() || "/");
			if (picked) setImportPath(picked);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
	};

	const handleDelete = async () => {
		if (!pendingDelete) return;
		setDeleting(true);
		try {
			if (kind === "skills") await deleteSkillResource(pendingDelete);
			else await deleteTemplateResource(pendingDelete);
			// 库条目删除后把它从草稿白名单里一并去掉，避免留下悬空名字。
			setEnabledList(enabled.filter((item) => item !== pendingDelete));
			toast.success(`「${pendingDelete}」已从库中删除`);
			setPendingDelete(null);
			void refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setDeleting(false);
		}
	};

	return (
		<div className="flex flex-col gap-3">
			<p className="text-xs text-muted-foreground">{text.libraryHint}</p>

			{/* workspace 开关 + 额外挂载路径（草稿，随统一保存提交） */}
			<div className="flex flex-col gap-2 rounded-md bg-muted/60 p-3">
				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={kind === "skills" ? draft.loadWorkspaceSkills : draft.loadWorkspacePrompts}
						onChange={(e) =>
							onChange(kind === "skills" ? { loadWorkspaceSkills: e.target.checked } : { loadWorkspacePrompts: e.target.checked })
						}
						className="size-4 accent-foreground"
					/>
					{text.workspaceToggle}
				</label>
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">{text.pathsLabel}</span>
					<Textarea
						value={kind === "skills" ? draft.skillPaths : draft.promptTemplatePaths}
						onChange={(e) =>
							onChange(kind === "skills" ? { skillPaths: e.target.value } : { promptTemplatePaths: e.target.value })
						}
						rows={2}
						className="font-mono text-xs"
					/>
				</label>
			</div>

			<div className="flex items-center gap-2">
				<Button size="sm" variant="outline" onClick={openCreate}>
					<PlusIcon className="size-3.5" />
					新建
				</Button>
				<Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
					<UploadIcon className="size-3.5" />
					导入
				</Button>
			</div>

			{/* 库资源表格 */}
			{rows === null ? (
				<div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
					<LoaderIcon className="size-4 animate-spin" />
					加载库资源…
				</div>
			) : rows.length === 0 ? (
				<p className="text-xs text-muted-foreground">库中还没有{kind === "skills" ? "技能" : "模板"}，点击「新建」或「导入」。</p>
			) : (
				<div className="flex flex-col divide-y rounded-md border">
					{rows.map((row) => (
						<div key={row.name} className="flex items-center gap-2 px-3 py-2">
							<input
								type="checkbox"
								title="本 Agent 选用"
								checked={enabled.includes(row.name)}
								onChange={(e) => toggle(row.name, e.target.checked)}
								className="size-4 shrink-0 accent-foreground"
							/>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-1.5">
									<code className="font-mono text-sm">{row.name}</code>
									{row.disableModelInvocation ? (
										<span className="text-xs text-muted-foreground">（仅手动调用）</span>
									) : null}
								</div>
								<p className="truncate text-xs text-muted-foreground" title={row.description}>
									{row.description || "（无描述）"}
								</p>
							</div>
							<Button size="sm" variant="ghost" onClick={() => void openEdit(row.name)}>
								<PencilIcon className="size-3.5" />
							</Button>
							<Button size="sm" variant="ghost" onClick={() => setPendingDelete(row.name)}>
								<TrashIcon className="size-3.5" />
							</Button>
						</div>
					))}
				</div>
			)}
			<p className="text-xs text-muted-foreground/70">勾选只改本 Agent 的选用名单（草稿），随页面「保存」提交；新建/编辑/删除/导入即时写入库。</p>

			{diagnostics.length > 0 ? (
				<div className="flex flex-col gap-0.5 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
					{diagnostics.map((item, index) => (
						<div key={index}>
							{item.message}
							{item.path ? ` · ${item.path}` : ""}
						</div>
					))}
				</div>
			) : null}

			{extras.length > 0 ? (
				<div className="flex flex-col gap-1 text-xs text-muted-foreground">
					<span>额外来源（始终启用，不受选用名单管）：</span>
					{extras.map((item) => (
						<div key={`${item.path}-${item.name}`} className="flex items-center gap-1.5">
							<code className="font-mono">{item.name}</code>
							<span className="truncate">{item.description}</span>
							<span className="ml-auto shrink-0 text-muted-foreground/60">{item.path}</span>
						</div>
					))}
				</div>
			) : null}

			{/* 新建 / 编辑对话框 */}
			<Dialog open={editorOpen} onOpenChange={setEditorOpen}>
				<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>{editing ? `编辑「${editing}」` : `新建${kind === "skills" ? "技能" : "模板"}`}</DialogTitle>
						<DialogDescription>保存即写入 pi 全局目录的库，与 pi CLI 共享。</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-3">
						<label className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">名称（小写字母/数字/连字符）</span>
							<Input
								value={formName}
								onChange={(e) => setFormName(e.target.value)}
								disabled={editing !== null}
								placeholder="如 code-review"
								className="font-mono text-xs"
							/>
						</label>
						<label className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">描述</span>
							<Input value={formDescription} onChange={(e) => setFormDescription(e.target.value)} />
						</label>
						{kind === "skills" ? (
							<label className="flex items-start gap-2 text-sm">
								<input
									type="checkbox"
									checked={formDisableModel}
									onChange={(e) => setFormDisableModel(e.target.checked)}
									className="mt-0.5 size-4 accent-foreground"
								/>
								<span className="flex flex-col">
									<span>禁止模型自行调用（disableModelInvocation）</span>
									<span className="text-xs text-muted-foreground/70">勾选后只能通过 /skill:名称 显式触发</span>
								</span>
							</label>
						) : (
							<label className="flex flex-col gap-1 text-sm">
								<span className="text-muted-foreground">参数提示（argumentHint，可选）</span>
								<Input
									value={formArgumentHint}
									onChange={(e) => setFormArgumentHint(e.target.value)}
									placeholder="如 <文件路径> [选项]"
									className="font-mono text-xs"
								/>
							</label>
						)}
						<label className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">正文</span>
							<Textarea
								value={formContent}
								onChange={(e) => setFormContent(e.target.value)}
								rows={12}
								placeholder={text.contentPlaceholder}
								className="font-mono text-xs"
							/>
						</label>
						{formError ? <p className="text-xs text-destructive">{formError}</p> : null}
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => setEditorOpen(false)}>
								取消
							</Button>
							<Button type="button" disabled={saving} onClick={() => void handleSave()}>
								{saving ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
								{editing ? "保存" : "创建"}
							</Button>
						</DialogFooter>
					</div>
				</DialogContent>
			</Dialog>

			{/* 导入对话框 */}
			<Dialog open={importOpen} onOpenChange={setImportOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>导入到库</DialogTitle>
						<DialogDescription>{text.importHint}</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-3">
						<div className="flex items-center gap-1.5">
							<Input
								value={importPath}
								onChange={(e) => setImportPath(e.target.value)}
								placeholder={kind === "skills" ? "/path/to/skill-dir（含 SKILL.md）" : "/path/to/template.md"}
								className="flex-1 font-mono text-xs"
							/>
							{kind === "skills" ? (
								<Button type="button" size="sm" variant="outline" onClick={() => void handlePickDirectory()}>
									<FolderOpenIcon className="size-3.5" />
									选择目录
								</Button>
							) : null}
						</div>
						<DialogFooter>
							<Button type="button" variant="ghost" onClick={() => setImportOpen(false)}>
								取消
							</Button>
							<Button type="button" disabled={importing || !importPath.trim()} onClick={() => void handleImport()}>
								{importing ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
								导入
							</Button>
						</DialogFooter>
					</div>
				</DialogContent>
			</Dialog>

			{/* 删除确认 */}
			<Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>删除「{pendingDelete}」</DialogTitle>
						<DialogDescription>
							将从库（pi 全局目录）中删除，pi CLI 与所有 Agent 都不再可用；本 Agent 的选用名单会同步去掉该条目。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setPendingDelete(null)}>
							取消
						</Button>
						<Button type="button" variant="destructive" disabled={deleting} onClick={() => void handleDelete()}>
							{deleting ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
							删除
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
