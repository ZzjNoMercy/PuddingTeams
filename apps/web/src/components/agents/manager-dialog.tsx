"use client";

import { useState } from "react";
import Link from "next/link";
import { LoaderIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ApiConflictError, listAgents, updateManager } from "@/lib/api";
import { useModelCatalog } from "@/lib/model-catalog";
import { agentDisplayName, type AgentConfig, type MutationResponse, type PiManagerSettings, type PiManagerSettingsPatch } from "@/lib/types";
import { AffectedNote, AvatarEditor } from "@/components/agents/form-parts";

/**
 * pinned Pi Manager 编辑（§10.5）：与 worker 共用编辑 UI 的外壳（头像/描述），
 * 但没有 invoke command / probe / secrets，替换为 SDK 配置区——默认模型、
 * 系统提示词、内置工具开关、资源加载开关、thinking level。
 * 合并语义：只提交用户改过的键，未提交的键服务端保持不变。
 */

const splitProfileList = (value: string): string[] =>
	[...new Set(value.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean))];

function ToggleRow({
	label,
	hint,
	checked,
	onChange,
}: {
	label: string;
	hint?: string;
	checked: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<label className="flex items-start gap-2 text-sm">
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
				className="mt-0.5 size-4 accent-foreground"
			/>
			<span className="flex flex-col">
				<span>{label}</span>
				{hint ? <span className="text-xs text-muted-foreground/70">{hint}</span> : null}
			</span>
		</label>
	);
}

export function ManagerDialog({
	agent,
	open,
	onOpenChange,
	onAgentChanged,
}: {
	agent: AgentConfig;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onAgentChanged: (agent: AgentConfig) => void;
}) {
	const settings = agent.manager ?? {};
	const [description, setDescription] = useState(agent.description);
	const [identity, setIdentity] = useState(agent.responsibility?.identity ?? "");
	const [domain, setDomain] = useState(agent.responsibility?.domain ?? "");
	const [owns, setOwns] = useState((agent.responsibility?.owns ?? []).join("\n"));
	const [excludes, setExcludes] = useState((agent.responsibility?.excludes ?? []).join("\n"));
	const [escalateWhen, setEscalateWhen] = useState((agent.responsibility?.escalateWhen ?? []).join("\n"));
	const [model, setModel] = useState(settings.model ?? "");
	const [builtinTools, setBuiltinTools] = useState(settings.builtinTools ?? true);
	const [noExtensions, setNoExtensions] = useState(settings.noExtensions ?? false);
	const [thinkingLevel, setThinkingLevel] = useState<PiManagerSettings["thinkingLevel"] | "default">(
		settings.thinkingLevel ?? "default",
	);
	const [saving, setSaving] = useState(false);
	const [draftRevision, setDraftRevision] = useState(agent.extensionRevision ?? 0);
	const [conflict, setConflict] = useState(false);
	const [reloading, setReloading] = useState(false);
	const [lastMutation, setLastMutation] = useState<MutationResponse | null>(null);

	// 渲染期间随 Agent 变化重置表单。
	const [prevAgent, setPrevAgent] = useState(agent);
	if (prevAgent !== agent) {
		setPrevAgent(agent);
		const s = agent.manager ?? {};
		setDescription(agent.description);
		setIdentity(agent.responsibility?.identity ?? "");
		setDomain(agent.responsibility?.domain ?? "");
		setOwns((agent.responsibility?.owns ?? []).join("\n"));
		setExcludes((agent.responsibility?.excludes ?? []).join("\n"));
		setEscalateWhen((agent.responsibility?.escalateWhen ?? []).join("\n"));
		setModel(s.model ?? "");
		setBuiltinTools(s.builtinTools ?? true);
		setNoExtensions(s.noExtensions ?? false);
		setThinkingLevel(s.thinkingLevel ?? "default");
		setDraftRevision(agent.extensionRevision ?? 0);
		setConflict(false);
	}

	// 模型候选（"provider/modelId"），仅作 datalist 提示，不强制选择。
	const catalog = useModelCatalog();
	const modelOptions = (catalog.models ?? []).map((m) => m.id);
	// 档位跟随所选模型（与 composer 同一份 thinkingLevels map）；未选定模型时回退全集。
	const levels = catalog.levelsFor(model.trim());
	const graded = catalog.gradedFor(model.trim());
	const selectedLevel = thinkingLevel === "default" ? "" : thinkingLevel ?? "";

	const handleSave = async () => {
		if (conflict) return;
		setSaving(true);
		try {
			const hasResponsibility = Boolean(identity.trim() || domain.trim() || owns.trim() || excludes.trim() || escalateWhen.trim());
			if (hasResponsibility && !domain.trim()) throw new Error("填写责任 Profile 时，责任领域不能为空");
			const responsibility = hasResponsibility
				? {
						...(identity.trim() ? { identity: identity.trim() } : {}),
						domain: domain.trim(),
						owns: splitProfileList(owns),
						excludes: splitProfileList(excludes),
						...(escalateWhen.trim() ? { escalateWhen: splitProfileList(escalateWhen) } : {}),
					}
				: null;
			// 合并语义：提交表单全量键（false/空串也是有意义的值；空串 prompt = 清除）。
			const manager: PiManagerSettingsPatch = {
				builtinTools,
				noExtensions,
				model: model.trim() || null,
				thinkingLevel: thinkingLevel === "default" ? null : thinkingLevel,
			};
			const res = await updateManager({ expectedRevision: draftRevision, description: description.trim(), manager, responsibility });
			setLastMutation(res);
			setDraftRevision(res.revision);
			onAgentChanged(res.agent);
			toast.success("manager 配置已保存（新建/重开会话生效；thinking level 运行时即改）");
		} catch (err) {
			if (err instanceof ApiConflictError) setConflict(true);
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const reloadAfterConflict = async () => {
		setReloading(true);
		try {
			const latest = (await listAgents()).find((item) => item.name === agent.name);
			if (!latest) throw new Error("Manager 已不存在");
			onAgentChanged(latest);
			setDraftRevision(latest.extensionRevision ?? 0);
			setConflict(false);
			toast.success("已读取最新 Manager 配置，可以重新编辑");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setReloading(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>管理「{agentDisplayName(agent)}」</DialogTitle>
					<DialogDescription>
						Manager 负责理解用户消息、调度 Worker。不可删除、不可禁用；配置改动对新建或重开的会话生效。
					</DialogDescription>
				</DialogHeader>

				<DialogBody className="space-y-4">
				<AvatarEditor agent={agent} onUpdated={onAgentChanged} />

				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">描述</span>
					<Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
				</label>
				<div className="grid gap-2 rounded-md bg-muted/60 p-3 sm:grid-cols-2">
					<span className="text-sm font-medium sm:col-span-2">责任 Profile</span>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">身份定位（可选）</span>
						<Input value={identity} onChange={(e) => setIdentity(e.target.value)} placeholder="如：协作总负责人" />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">责任领域</span>
						<Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="如：跨 Agent 协作收口" />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">负责范围（每行一项）</span>
						<Textarea value={owns} onChange={(e) => setOwns(e.target.value)} rows={3} />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">明确不负责（每行一项）</span>
						<Textarea value={excludes} onChange={(e) => setExcludes(e.target.value)} rows={3} />
					</label>
					<label className="flex flex-col gap-1 text-sm sm:col-span-2">
						<span className="text-muted-foreground">升级给 Human 的条件（每行一项）</span>
						<Textarea value={escalateWhen} onChange={(e) => setEscalateWhen(e.target.value)} rows={2} />
					</label>
					<p className="text-xs text-muted-foreground sm:col-span-2">用于路由与责任收口，不等于模型能力或操作授权。</p>
				</div>

				{/* SDK 配置区（§10.5 可编辑项） */}
				<div className="flex flex-col gap-3 rounded-md bg-muted/60 p-3">
					<span className="text-sm font-medium">SDK 配置</span>
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">默认模型（provider/modelId，新建会话生效）</span>
						<Input
							value={model}
							onChange={(e) => setModel(e.target.value)}
							placeholder="如 anthropic/claude-sonnet-4-5；留空用运行时默认"
							className="font-mono text-xs"
							list="manager-model-options"
						/>
						<datalist id="manager-model-options">
							{modelOptions.map((id) => (
								<option key={id} value={id} />
							))}
						</datalist>
					</label>
					<ToggleRow
						label="启用内置工具"
							hint="关闭后不注册 read/bash/edit 等内置工具（新建/重开会话生效）"
						checked={builtinTools}
						onChange={setBuiltinTools}
					/>
					<ToggleRow label="不加载 Pi 原生插件" checked={noExtensions} onChange={setNoExtensions} />
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">thinking level（新建/重开 Session 生效）</span>
						<Select value={thinkingLevel} onValueChange={(v) => setThinkingLevel(v as typeof thinkingLevel)}>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="default">默认（不设置）</SelectItem>
								{/* 已存档位不再被新模型支持时必须仍可见可改。 */}
								{selectedLevel && !levels.includes(selectedLevel) ? <SelectItem value={selectedLevel}>{selectedLevel}（当前模型不支持）</SelectItem> : null}
								{levels.map((level) => (
									<SelectItem key={level} value={level}>
										{level}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<span className="text-xs text-muted-foreground/70">
							{graded ? "档位取自所选模型的 pi 原生映射；各 provider 的实际强度语义以服务商文档为准。" : "该模型只支持思考开/关，各档在链路上无差别。"}
						</span>
					</label>
				</div>

				<div className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
					运行指令与模板已移至独立配置页；Skills 统一从扩展入口管理：
					<Link href={`/agents/config?name=${encodeURIComponent(agent.name)}`} className="ml-1 underline hover:text-foreground">
						打开「{agentDisplayName(agent)}」配置页
					</Link>
					<Link href="/extensions" className="ml-2 underline hover:text-foreground">
						打开扩展
					</Link>
				</div>

				{lastMutation ? <AffectedNote affected={lastMutation.affectedSessions} /> : null}
				{conflict ? <div role="alert" className="rounded-md border border-amber-500 p-3 text-sm">Manager 配置已变化。当前表单仍保留；请先核对，再读取最新配置。<Button type="button" size="sm" variant="outline" className="ml-3" disabled={reloading} onClick={() => void reloadAfterConflict()}>读取最新配置（丢弃当前输入）</Button></div> : null}

				<div className="flex items-center gap-2">
					<Button type="button" size="sm" disabled={saving || conflict} onClick={() => void handleSave()}>
						{saving ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
						保存
					</Button>
					<Button type="button" size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
						关闭
					</Button>
				</div>
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
