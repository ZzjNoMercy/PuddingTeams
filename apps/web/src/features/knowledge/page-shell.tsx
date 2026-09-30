"use client";

import Link from "next/link";
import { ArrowLeftIcon } from "lucide-react";

/**
 * 知识库二级页外壳：返回箭头 + 单行标题的顶栏，下面按 layout 决定内容容器。
 * 结构页（/knowledge/schema）与发布审核页（/knowledge/review）共用，保证两页顶栏一致。
 *
 * layout：
 * - centered 居中限宽阅读栏（结构页、审核列表）
 * - bleed    内容自己接管滚动与撑满（审核工作台的左右分栏）
 */
export function KnowledgePageShell({ title, back, actions, layout = "centered", children }: {
	title: string;
	back?: { href: string; label: string };
	/** 顶栏右侧操作位（返回列表、次级导航等）。 */
	actions?: React.ReactNode;
	layout?: "centered" | "bleed";
	children: React.ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
			<header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
				<div className="flex min-w-0 items-center gap-2">
					{back ? (
						<Link
							href={back.href}
							aria-label={back.label}
							className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
						>
							<ArrowLeftIcon size={18} aria-hidden="true" />
						</Link>
					) : null}
					<h1 className="truncate text-2xl font-medium tracking-tight">{title}</h1>
				</div>
				{actions ? <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">{actions}</div> : null}
			</header>
			{layout === "bleed" ? children : (
				<div className="min-h-0 flex-1 overflow-y-auto">
					<div className="mx-auto w-full max-w-5xl px-6 py-6">{children}</div>
				</div>
			)}
		</div>
	);
}
