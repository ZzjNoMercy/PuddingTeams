"use client";

import { useEffect, useId, useState } from "react";
import { BlocksIcon, BookOpenIcon, CalendarDaysIcon, ChevronDownIcon, GlobeIcon, InfoIcon, LoaderIcon, NetworkIcon, SearchIcon, ServerIcon, TerminalIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchAgentToolPreview } from "@/lib/api";
import type { AgentConfig, AgentToolPreview, ToolPreviewGroup, ToolPreviewGroupId } from "@/lib/types";
import { filterToolGroups, summarizeToolExposure, TOOL_EXPOSURE_LABELS, TOOL_GROUP_LABELS } from "./tool-preview-model";
import styles from "./tool-preview-section.module.css";

const GROUP_ICONS: Record<ToolPreviewGroupId, typeof TerminalIcon> = {
	native: TerminalIcon, orchestration: NetworkIcon, knowledge: BookOpenIcon,
	calendar: CalendarDaysIcon, web: GlobeIcon, mcp: ServerIcon, capability: BlocksIcon,
};

const ROLE_LABELS: Record<AgentToolPreview["role"], string> = {
	manager: "Manager",
	worker: "Worker",
	wiki: "Wiki 策展",
};

function ToolGroup({ group, initiallyOpen }: { group: ToolPreviewGroup; initiallyOpen: boolean }) {
	const [open, setOpen] = useState(initiallyOpen);
	const contentId = useId();
	const Icon = GROUP_ICONS[group.id];
	const mixed = new Set(group.tools.map((tool) => tool.exposure)).size > 1;
	return (
		<section className={styles.group}>
			<h3 className={styles.groupHeading}>
				<button type="button" className={styles.groupTrigger} aria-expanded={open} aria-controls={contentId} onClick={() => setOpen(!open)}>
					<Icon size={17} aria-hidden="true" className={styles.groupIcon} />
					<span className={styles.groupName}>{TOOL_GROUP_LABELS[group.id]}<span className={styles.count}>{group.tools.length} 项</span></span>
					<span className={styles.exposureSummary} title={summarizeToolExposure(group)}>{mixed ? "混合声明" : summarizeToolExposure(group)}</span>
					<ChevronDownIcon size={15} aria-hidden="true" className={styles.chevron} />
				</button>
			</h3>
			<div id={contentId} hidden={!open}>
				{group.note ? <p className={styles.groupNote}>{group.note}</p> : null}
				<ul className={styles.tools} aria-label={`${TOOL_GROUP_LABELS[group.id]}条目`}>
					{group.tools.map((tool) => (
						<li key={tool.name} className={styles.tool}>
							<div className={styles.toolName}><code>{tool.name}</code>{mixed ? <span className={styles.exposure}>{TOOL_EXPOSURE_LABELS[tool.exposure]}</span> : null}</div>
							{tool.condition ? <p className={styles.condition}>{tool.condition}</p> : null}
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}

/** 工具分区：只读展示服务端按当前配置解析出的实际装配工具面。 */
export function ToolPreviewSection({ agent }: { agent: AgentConfig }) {
	const [query, setQuery] = useState("");
	const [attempt, setAttempt] = useState(0);
	const [result, setResult] = useState<{ agentName: string; data: AgentToolPreview } | null>(null);
	const [error, setError] = useState<{ agentName: string; message: string } | null>(null);

	useEffect(() => {
		let cancelled = false;
		const agentName = agent.name;
		void fetchAgentToolPreview(agentName)
			.then((data) => { if (!cancelled) { setResult({ agentName, data }); setError(null); } })
			.catch((err: unknown) => {
				if (!cancelled) {
					setResult(null);
					setError({ agentName, message: err instanceof Error ? err.message : String(err) });
				}
			});
		return () => { cancelled = true; };
	}, [agent.name, attempt]);

	const preview = result?.agentName === agent.name ? result.data : null;
	const currentError = error?.agentName === agent.name ? error.message : null;
	const loading = !preview && !currentError;
	const groups = filterToolGroups(preview?.groups ?? [], query);
	const searching = Boolean(query.trim());
	const total = preview?.groups.reduce((count, group) => count + group.tools.length, 0) ?? 0;
	const matched = groups.reduce((count, group) => count + group.tools.length, 0);

	return (
		<section className={`agent-config-card ${styles.section}`} aria-label="工具目录">
				<div className="agent-config-card-head">
					<h2>工具</h2>
					<p>{preview ? `${ROLE_LABELS[preview.role]} 运行时的工具目录，按来源查看。` : "按来源查看此智能体的工具目录。"}只读预览，不修改配置。</p>
				</div>
				{loading ? (
					<div className={styles.loading} role="status">
						<LoaderIcon className="size-3.5 animate-spin" aria-hidden="true" />
						正在读取工具清单…
					</div>
				) : null}
				{currentError ? (
					<div role="alert" className={styles.error}>
						<span>工具清单读取失败：{currentError}</span>
						<Button type="button" size="sm" variant="outline" onClick={() => { setResult(null); setError(null); setAttempt((value) => value + 1); }}>
							重试
						</Button>
					</div>
				) : null}
			{preview ? <>
				<div className={styles.toolbar}>
					<div className={styles.search}>
						<SearchIcon size={15} aria-hidden="true" />
						<input aria-label="搜索工具" placeholder="搜索名称、来源或条件" value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" spellCheck={false} />
						{query ? <button type="button" aria-label="清空工具搜索" onClick={() => setQuery("")}><XIcon size={14} aria-hidden="true" /></button> : null}
					</div>
					<span className={styles.resultCount} role="status">{searching ? `找到 ${matched} 项` : `${preview.groups.length} 个来源 · ${total} 项`}</span>
				</div>
				{groups.length ? <div className={styles.groups}>{groups.map((group) => <ToolGroup key={`${agent.name}:${searching ? "search" : "browse"}:${group.id}`} group={group} initiallyOpen={searching} />)}</div> : <div className={styles.empty}>{searching ? "没有匹配的工具，试试其他名称或条件。" : "当前没有工具条目。"}</div>}
				<details className={styles.legend}>
					<summary><InfoIcon size={14} aria-hidden="true" />声明方式与使用条件<ChevronDownIcon size={13} aria-hidden="true" /></summary>
					<div><p><strong>直接</strong>：常驻工具列表。<strong>渐进声明</strong>：经 tool_search 按需加载。<strong>仅模型</strong>：模型可见的发现入口。</p><p>目录反映装配规则，不代表当前会话全部可用；请同时查看分类说明与条目条件。MCP 条目列出服务，具体工具由连接后的服务声明。</p></div>
				</details>
			</> : null}
		</section>
	);
}
