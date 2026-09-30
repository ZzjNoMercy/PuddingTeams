"use client";

import { useEffect, useState } from "react";
import { Link2Icon } from "lucide-react";
import { getKnowledgeBacklinks, type KnowledgeBacklink } from "@/lib/api";

/** 反链面板：谁链接到当前笔记。数据来自已同步索引，未同步笔记自然为空。 */
export function BacklinksPanel({ bindingId, notePath, refreshKey, onOpenNote }: {
	bindingId: string;
	notePath: string;
	refreshKey: number;
	onOpenNote: (path: string) => void;
}) {
	const key = `${bindingId}${notePath}${refreshKey}`;
	const [state, setState] = useState<{ key: string; value: KnowledgeBacklink[]; error: string | null } | null>(null);
	const [retryNonce, setRetryNonce] = useState(0);
	const activeKey = `${key}${retryNonce}`;

	useEffect(() => {
		let active = true;
		void getKnowledgeBacklinks(bindingId, notePath)
			.then((value) => { if (active) setState({ key: activeKey, value, error: null }); })
			.catch((cause) => { if (active) setState({ key: activeKey, value: [], error: cause instanceof Error ? cause.message : String(cause) }); });
		return () => { active = false; };
	}, [bindingId, notePath, activeKey]);

	const current = state && state.key === activeKey ? state : null;

	return (
		<section className="mt-10 border-t border-border pt-5">
			<h3 className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				<Link2Icon size={13} />
				反链{current && !current.error && current.value.length > 0 ? ` · ${current.value.length}` : ""}
			</h3>
			{!current ? (
				<p className="text-xs text-muted-foreground">正在加载反链…</p>
			) : current.error ? (
				<p role="alert" className="text-xs text-destructive">
					{current.error}{" "}
					<button type="button" onClick={() => setRetryNonce((value) => value + 1)} className="underline">重试</button>
				</p>
			) : current.value.length === 0 ? (
				<p className="text-xs text-muted-foreground">暂无反链——还没有已同步的笔记链接到这里。</p>
			) : (
				<ul className="space-y-1.5">
					{current.value.map((backlink, index) => (
						<li key={`${backlink.sourcePath}${index}`}>
							<button
								type="button"
								onClick={() => onOpenNote(backlink.sourcePath)}
								className="w-full rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-muted"
							>
								<span className="flex items-center gap-2 text-xs">
									<span className="min-w-0 flex-1 truncate font-medium text-foreground">{backlink.sourceTitle}</span>
									<span className="shrink-0 text-[10px] text-muted-foreground">{backlink.kind === "wiki" ? "双链" : "链接"}</span>
								</span>
								<span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{backlink.sourcePath}</span>
								{backlink.snippet ? (
									<span className="mt-1 line-clamp-2 block text-[11px] leading-relaxed text-muted-foreground">{backlink.snippet}</span>
								) : null}
							</button>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
