"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
	ChevronDownIcon,
	LoaderIcon,
	RefreshCwIcon,
	SearchIcon,
	TriangleAlertIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { listSkillLibrary, listTemplateLibrary, previewAgentPiResources } from "@/lib/api";
import type { AgentConfig, PiPreviewResource, PiResourceSource, ResourceDiagnostic } from "@/lib/types";
import type { ConfigDraft } from "@/components/agent-config/draft";
import { filterResources } from "@/components/agent-config/resource-search";

/**
 * 技能 / 模板分区（共用）：**只管选用范围**，不管资源本体。
 *
 * 职责边界（与 `/extensions` 对称）：资源本体的导入 / 新建 / 编辑 / 删除在
 * 「扩展」页完成，那里已明确写着"这里只管理资源本体，启用范围在各 Agent 配置页"。
 * 本页因此只有两件事——勾选本 Agent 启用哪些库资源，以及高级加载选项
 * （Workspace 目录开关 + 额外挂载路径）。勾选只改草稿，随页面级「保存」提交；
 * 管理入口与保存说明集中在标题区，主体只保留选择列表与折叠加载选项。
 */

type Kind = "skills" | "templates";

interface ResourceRow {
	name: string;
	description: string;
	path: string;
	argumentHint?: string;
}

/** 一页 10 条。库里有 30+ 项（例如 lark 全家桶），一次铺完会把这一节拉到几屏。 */
const PAGE_SIZE = 10;

/**
 * 非 global 来源的分组说明。service 端 `PiResourceSource` 只有三值，global 由
 * 勾选控制所以不会出现在这里；剩下的两类对用户来说意义完全不同，必须分开讲：
 * workspace 会随"这次会话用哪个工作目录、是否受信任"变化，extra 由 pi 自己发现、
 * 用户没有对应开关。
 */
const EXTRA_SOURCE_GROUPS: ReadonlyArray<readonly [PiResourceSource, string, string]> = [
	["workspace", "来自工作目录", "换工作目录或信任状态变化时会跟着变"],
	["extra", "pi 自动发现", "没有对应开关，要去掉请在 pi 侧处理"],
];

const KIND_TEXT: Record<
	Kind,
	{
		title: string;
		label: string;
		emptyHint: string;
		workspaceToggle: string;
		pathsLabel: string;
	}
> = {
	skills: {
		title: "为此智能体启用技能",
		label: "技能",
		emptyHint: "库里还没有技能。",
		workspaceToggle: "加载 Workspace 技能（项目目录 .pi/skills）",
		pathsLabel: "额外技能挂载路径（每行一个；不受勾选管，始终加载）",
	},
	templates: {
		title: "提示词模板",
		label: "模板",
		emptyHint: "库里还没有模板。",
		workspaceToggle: "加载 Workspace 模板（项目目录 .pi/prompts）",
		pathsLabel: "额外模板挂载路径（每行一个；不受勾选管，始终加载）",
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
	const [query, setQuery] = useState("");
	// 页码和搜索词放在一起：搜索变了就在 render 期间把页码拨回第一页
	// （effect 里 setState 会被 react-hooks/set-state-in-effect 拦下）。
	const [pager, setPager] = useState({ query: "", page: 0 });
	if (pager.query !== query) setPager({ query, page: 0 });
	const [rows, setRows] = useState<ResourceRow[] | null>(null);
	const [diagnostics, setDiagnostics] = useState<ResourceDiagnostic[]>([]);
	const [extras, setExtras] = useState<PiPreviewResource[]>([]);
	const [libraryError, setLibraryError] = useState<string | null>(null);
	const [extrasError, setExtrasError] = useState<string | null>(null);
	const [extrasLoading, setExtrasLoading] = useState(true);
	const libraryRequest = useRef(0);
	const extrasRequest = useRef(0);

	const patchEnabled = useCallback(
		(next: string[]) => {
			onChange(kind === "skills" ? { enabledSkills: next } : { enabledPrompts: next });
		},
		[kind, onChange],
	);

	// 读库：加载态由 rows===null 表示，不额外用 setState 触发额外渲染。
	const readLibrary = useCallback((requestId: number) => {
		listLibrary(kind)
			.then((result) => {
				if (requestId !== libraryRequest.current) return;
				setRows(result.rows);
				setDiagnostics(result.diagnostics);
				setLibraryError(null);
			})
			.catch((error: unknown) => {
				if (requestId !== libraryRequest.current) return;
				setLibraryError(error instanceof Error ? error.message : String(error));
			});
	}, [kind]);

	const readExtras = useCallback((requestId: number) => {
		previewAgentPiResources(agent.name)
			.then((preview) => {
				if (requestId !== extrasRequest.current) return;
				// 只保留真正"不由本列表控制"的那些。预览接口返回的是**全部**资源
				// （它要供配置页列出候选项），其中 global 正是上面已经列出的库资源、
				// 由勾选控制——不过滤的话这里会把同一批再列一遍，还贴上"始终启用"的
				// 错误标签。判据是服务端口径：白名单只作用于 global
				// （pi-resources.ts: `!isUnderDir(s.filePath, globalSkillsDir) || enabledSkills.has(s.name)`），
				// 所以只有 workspace / extra 是勾选管不到的。
				const all = kind === "skills" ? preview.skills : preview.prompts;
				setExtras(all.filter((item) => item.source !== "global"));
				setExtrasError(null);
			})
			.catch((error: unknown) => {
				if (requestId !== extrasRequest.current) return;
				setExtrasError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (requestId === extrasRequest.current) setExtrasLoading(false);
			});
	}, [agent.name, kind]);

	const refreshLibrary = useCallback(() => {
		const requestId = ++libraryRequest.current;
		setLibraryError(null);
		readLibrary(requestId);
	}, [readLibrary]);

	const refreshExtras = useCallback(() => {
		const requestId = ++extrasRequest.current;
		setExtrasError(null);
		readExtras(requestId);
	}, [readExtras]);

	// 初始加载：extrasLoading 初值即 true，无需在 effect 里同步置位。
	useEffect(() => {
		const requestId = ++libraryRequest.current;
		readLibrary(requestId);
		return () => { libraryRequest.current += 1; };
	}, [readLibrary]);
	useEffect(() => {
		const requestId = ++extrasRequest.current;
		readExtras(requestId);
		return () => { extrasRequest.current += 1; };
	}, [readExtras]);

	const toggle = (name: string, checked: boolean) => {
		patchEnabled(checked ? [...new Set([...enabled, name])].sort() : enabled.filter((item) => item !== name));
	};
	const search = query.trim().toLocaleLowerCase();
	const visibleRows = rows ? filterResources(rows, query) : null;
	// 搜索词变化就回到第一页，否则可能停在一个已经不存在的页码上（越界则夹回最后一页）。
	const totalRows = visibleRows?.length ?? 0;
	const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
	const currentPage = Math.min(pager.page, pageCount - 1);
	const pagedRows = visibleRows?.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
	const selectedCount = rows?.filter((row) => enabled.includes(row.name)).length ?? 0;
	const libraryHref = kind === "templates" ? "/extensions?tab=templates" : "/extensions?tab=skills";

	return (
		<section className="agent-config-card">
			<div className="agent-config-card-head has-action">
				<div>
					<h2>{text.title}</h2>
					<p>仅对当前智能体生效，勾选后点击顶部「保存配置」。</p>
					<p>导入与编辑在 <Link href={libraryHref} className="agent-config-text-link">扩展 → {text.label === "模板" ? "提示词模板" : text.label}</Link> 管理。</p>
				</div>
				<Button type="button" size="icon" variant="ghost" aria-label={`重新读取${text.label}库`} title={`重新读取${text.label}库`} onClick={refreshLibrary}>
					<RefreshCwIcon className="size-4" />
				</Button>
			</div>
			{rows && rows.length > 0 ? (
				<div className="agent-config-resource-toolbar">
					<label className="agent-config-resource-search">
						<SearchIcon className="size-4" aria-hidden="true" />
						<Input type="search" aria-label={`搜索${text.label}`} placeholder={`搜索${text.label}名称或描述`} value={query} onChange={(event) => setQuery(event.target.value)} />
					</label>
					<span className="agent-config-muted-note" role="status">库内已选 {selectedCount} / {rows.length}{search ? ` · 找到 ${visibleRows?.length ?? 0} 个` : ""}</span>
				</div>
			) : null}

			{/* 库读取诊断：库读不到就不能确认勾选范围，如实报错而不是静默当成空库。 */}
			{libraryError ? (
				<div role="alert" className="agent-config-callout is-warning">
					{text.label}库读取失败，当前内容与选用范围无法确认：{libraryError}
					<Button size="sm" variant="outline" className="ml-3" onClick={refreshLibrary}>重试读取</Button>
				</div>
			) : null}
			{!libraryError && diagnostics.length > 0 ? (
				<div className="agent-config-callout is-warning">
					{diagnostics.map((item, index) => (
						<div key={index} className="flex items-start gap-1.5">
							<TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
							<span>{item.message}{item.path ? ` · ${item.path}` : ""}</span>
						</div>
					))}
				</div>
			) : null}

			{/* 勾选列表：只读资源信息 + 勾选框，不提供新建 / 编辑 / 删除。 */}
			{rows === null && !libraryError ? (
				<p className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
					<LoaderIcon className="size-3.5 animate-spin" />
					正在读取{text.label}库…
				</p>
			) : rows && rows.length === 0 ? (
				<div className="agent-config-empty">
					{text.emptyHint}
					<Link href={libraryHref} className="ml-1 text-primary hover:underline">前往扩展</Link>
					添加。
				</div>
			) : rows && visibleRows?.length === 0 ? (
				<div className="agent-config-empty">没有匹配的{text.label}。<Button type="button" size="sm" variant="ghost" onClick={() => setQuery("")}>清除搜索</Button></div>
			) : (
				<div className="agent-config-choice-list">
					{pagedRows?.map((row) => {
						const checked = enabled.includes(row.name);
						return (
							<label key={row.name} className="agent-config-choice">
								<input
									type="checkbox"
									checked={checked}
									disabled={Boolean(libraryError)}
									onChange={(event) => toggle(row.name, event.target.checked)}
								/>
								<span className="min-w-0 flex-1">
									<strong>{row.name}</strong>
									<small title={row.description || row.argumentHint}>{row.description || row.argumentHint || "（无描述）"}</small>
								</span>
								<span className={`agent-config-choice-state ${checked ? "is-on" : ""}`}>
									{checked ? "已启用" : "未启用"}
								</span>
							</label>
						);
					})}
				</div>
			)}

			{/* 分页：只有超过一页才出现；页码随搜索结果夹紧，不留空白页。 */}
			{totalRows > PAGE_SIZE ? (
				<nav className="agent-config-pager" aria-label={`${text.label}列表分页`}>
					<span className="agent-config-muted-note" role="status">
						第 {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, totalRows)} 个 / 共 {totalRows} 个
					</span>
					<div className="agent-config-pager-actions">
						<Button type="button" size="sm" variant="outline" disabled={currentPage === 0} onClick={() => setPager({ query, page: currentPage - 1 })}>上一页</Button>
						<span className="agent-config-muted-note">{currentPage + 1} / {pageCount}</span>
						<Button type="button" size="sm" variant="outline" disabled={currentPage >= pageCount - 1} onClick={() => setPager({ query, page: currentPage + 1 })}>下一页</Button>
					</div>
				</nav>
			) : null}

			{/* 非 global 来源（工作目录 / pi 自动发现）：勾选管不到，如实告知数量与来源。 */}
			{extrasError ? (
				<div role="alert" className="agent-config-callout is-warning">
					额外来源读取失败，无法确认始终启用的资源：{extrasError}
					<Button type="button" size="sm" variant="outline" className="ml-3" onClick={refreshExtras}>
						{extrasLoading ? "重试中…" : "重试读取"}
					</Button>
				</div>
			) : extrasLoading ? null : extras.length > 0 ? (
				<Collapsible className="agent-config-disclosure">
					<CollapsibleTrigger className="agent-config-disclosure-trigger group">
						<ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
						另有 {extras.length} 个来自别处、始终可用（不受勾选影响）
					</CollapsibleTrigger>
					<CollapsibleContent className="flex flex-col gap-2 pb-2 pl-5">
						{EXTRA_SOURCE_GROUPS.map(([source, label, note]) => {
							const items = extras.filter((item) => item.source === source);
							if (items.length === 0) return null;
							return (
								<div key={source} className="flex flex-col gap-1">
									<small className="agent-config-hint">{label} · {items.length} 个 —— {note}</small>
									{items.map((item) => (
										<div key={`${item.path}-${item.name}`} className="flex items-center gap-2 text-xs">
											<Tooltip>
												<TooltipTrigger asChild>
													<span className="agent-config-mono-tag">{item.name}</span>
												</TooltipTrigger>
												<TooltipContent className="max-w-md font-mono break-all">{item.path}</TooltipContent>
											</Tooltip>
											<span className="truncate text-muted-foreground">{item.description}</span>
										</div>
									))}
								</div>
							);
						})}
					</CollapsibleContent>
				</Collapsible>
			) : null}

			{/* 高级加载选项：Workspace 开关 + 额外挂载路径（草稿，随统一保存提交）。 */}
			<Collapsible className="agent-config-disclosure">
				<CollapsibleTrigger className="agent-config-disclosure-trigger group">
					<ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
					高级加载选项
				</CollapsibleTrigger>
				<CollapsibleContent className="flex flex-col gap-4 pb-1">
					<label className="agent-config-toggle">
						<span>
							<strong>{text.workspaceToggle}</strong>
							<small>在工作区受信任时读取项目级资源目录。</small>
						</span>
						<input
							type="checkbox"
							role="switch"
							checked={kind === "skills" ? draft.loadWorkspaceSkills : draft.loadWorkspacePrompts}
							onChange={(event) => onChange(kind === "skills"
								? { loadWorkspaceSkills: event.target.checked }
								: { loadWorkspacePrompts: event.target.checked })}
						/>
					</label>
					<label className="agent-config-field">
						<span>{text.pathsLabel}</span>
						<Textarea
							value={kind === "skills" ? draft.skillPaths : draft.promptTemplatePaths}
							onChange={(event) => onChange(kind === "skills"
								? { skillPaths: event.target.value }
								: { promptTemplatePaths: event.target.value })}
							rows={2}
							className="font-mono text-xs"
						/>
					</label>
				</CollapsibleContent>
			</Collapsible>

		</section>
	);
}
