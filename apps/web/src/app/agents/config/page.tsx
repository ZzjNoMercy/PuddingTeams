"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AgentConfigPage } from "@/components/agent-config/agent-config-page";
import { NavRail } from "@/components/chat/nav-rail";
import { DesktopTitlebar } from "@/components/desktop-titlebar";
import { SectionTopbar } from "@/components/section-topbar";

// 静态导出（output: "export"）不支持动态段 /agents/[name]，改为查询参数
// /agents/config?name=xxx。useSearchParams 必须包在 Suspense 里（Next 静态导
// 出要求），否则 build 报错。
function AgentConfigContent() {
	const name = useSearchParams().get("name") ?? "";
	return (
		<main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
			<SectionTopbar crumbs={[{ label: "智能体", href: "/agents" }, { label: name || "配置" }]} />
			{!name ? (
				<div className="p-6 text-sm text-muted-foreground">缺少 agent 名称（?name=）。</div>
			) : (
				<AgentConfigPage key={name} name={name} />
			)}
		</main>
	);
}

export default function Page() {
	return (
		<div className="desktop-app-frame m1-app-shell h-dvh">
			<DesktopTitlebar />
			<div className="desktop-app-body">
				<div className="desktop-sidebar-stack desktop-sidebar-nav-only" data-app-sidebar-shell>
					<NavRail view="agents" />
				</div>
				<Suspense>
					<AgentConfigContent />
				</Suspense>
			</div>
		</div>
	);
}
