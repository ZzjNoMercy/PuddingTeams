"use client";

import { useEffect, useMemo, useState } from "react";
import { FileTextIcon, SearchIcon, XIcon } from "lucide-react";
import { searchKnowledge, type KnowledgeSearchHit, type KnowledgeTreeNode } from "@/lib/api";

const DEBOUNCE_MS = 300;
const MAX_RESULTS = 20;

function findPathMatches(nodes: KnowledgeTreeNode[], needle: string): { results: KnowledgeSearchHit[]; truncated: boolean } {
	const results: KnowledgeSearchHit[] = [];
	let truncated = false;
	const visit = (items: KnowledgeTreeNode[]) => {
		for (const node of items) {
			if (node.type === "directory") {
				visit(node.children ?? []);
			} else if (node.path.toLocaleLowerCase().includes(needle)) {
				if (results.length < MAX_RESULTS) {
					results.push({ path: node.path, title: node.name, snippet: "", score: 0 });
				} else {
					truncated = true;
				}
			}
		}
	};
	visit(nodes);
	return { results, truncated };
}

/**
 * 单一入口检索当前文件路径与笔记正文。
 * 防抖触发全文检索，结果去重后以浮层覆盖在文件树上方。
 */
export function KnowledgeSearchPanel({ bindingId, nodes, onOpenNote }: {
	bindingId: string;
	nodes: KnowledgeTreeNode[];
	onOpenNote: (path: string) => void;
}) {
	const [input, setInput] = useState("");
	const [query, setQuery] = useState("");
	const [retryNonce, setRetryNonce] = useState(0);
	const [state, setState] = useState<{ key: string; results: KnowledgeSearchHit[]; truncated: boolean; error: string | null } | null>(null);

	useEffect(() => {
		const timer = setTimeout(() => setQuery(input.trim()), DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [input]);

	useEffect(() => {
		if (!query) return;
		let active = true;
		const key = `${bindingId}${query}${retryNonce}`;
		void searchKnowledge(bindingId, query)
			.then((value) => { if (active) setState({ key, results: value.results, truncated: value.truncated, error: null }); })
			.catch((cause) => { if (active) setState({ key, results: [], truncated: false, error: cause instanceof Error ? cause.message : String(cause) }); });
		return () => { active = false; };
	}, [bindingId, query, retryNonce]);

	const current = state && state.key === `${bindingId}${query}${retryNonce}` ? state : null;
	const pathMatches = useMemo(() => query ? findPathMatches(nodes, query.toLocaleLowerCase()) : { results: [], truncated: false }, [nodes, query]);
	const pathSet = new Set(pathMatches.results.map((hit) => hit.path));
	const contentMatches = current?.results.filter((hit) => !pathSet.has(hit.path)) ?? [];
	const results = [...pathMatches.results, ...contentMatches].slice(0, MAX_RESULTS);
	const truncated = pathMatches.truncated || Boolean(current?.truncated) || pathMatches.results.length + contentMatches.length > MAX_RESULTS;

	return (
		<div className="relative">
			<div className="relative">
				<SearchIcon size={14} className="absolute left-2 top-2.5 text-muted-foreground" />
				<input
					aria-label="搜索笔记名称或内容"
					value={input}
					onChange={(event) => setInput(event.target.value)}
					onKeyDown={(event) => { if (event.key === "Escape") setInput(""); }}
					placeholder="搜索笔记名称或内容…"
					className="w-full rounded border border-border bg-background py-2 pl-8 pr-7 text-sm"
				/>
				{input ? (
					<button
						type="button"
						aria-label="清除搜索"
						onClick={() => setInput("")}
						className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						<XIcon size={13} />
					</button>
				) : null}
			</div>
			{query ? (
				<div className="knowledge-search-pop" role="region" aria-label="搜索结果">
					{results.length > 0 ? (
						<>
							<ul className="max-h-80 overflow-y-auto py-1">
								{results.map((hit) => (
									<li key={hit.path}>
										<button
											type="button"
											onClick={() => { onOpenNote(hit.path); setInput(""); }}
											className="w-full rounded px-3 py-2 text-left hover:bg-muted"
										>
											<span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
												<FileTextIcon size={12} className="shrink-0 text-muted-foreground" />
												<span className="truncate">{hit.title}</span>
											</span>
											<span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{hit.path}</span>
											{hit.snippet && hit.snippet !== hit.title ? (
												<span className="mt-0.5 line-clamp-2 block text-[10px] leading-relaxed text-muted-foreground">{hit.snippet}</span>
											) : null}
										</button>
									</li>
								))}
							</ul>
							{!current && results.length < MAX_RESULTS ? (
								<p className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">正在搜索笔记内容…</p>
							) : null}
						</>
					) : !current ? (
						<p className="px-3 py-3 text-xs text-muted-foreground">正在搜索…</p>
					) : current.error ? (
						<p role="alert" className="px-3 py-3 text-xs text-destructive">
							内容搜索失败：{current.error}{" "}
							<button type="button" onClick={() => setRetryNonce((value) => value + 1)} className="underline">重试</button>
						</p>
					) : (
						<p className="px-3 py-3 text-xs text-muted-foreground">
							没有找到匹配的笔记。
						</p>
					)}
					{current?.error && results.length > 0 ? (
						<p role="alert" className="border-t border-border px-3 py-2 text-[10px] text-destructive">
							内容搜索失败：{current.error}{" "}
							<button type="button" onClick={() => setRetryNonce((value) => value + 1)} className="underline">重试</button>
						</p>
					) : null}
					{truncated ? (
						<p className="border-t border-border px-3 py-2 text-[10px] text-muted-foreground">结果过多，仅显示前 {MAX_RESULTS} 条，请换更精确的关键词。</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}
