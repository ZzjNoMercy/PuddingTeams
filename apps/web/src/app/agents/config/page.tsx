"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AgentConfigPage } from "@/components/agent-config/agent-config-page";
import { NavRail } from "@/components/chat/nav-rail";

// 静态导出（output: "export"）不支持动态段 /agents/[name]，改为查询参数
// /agents/config?name=xxx。useSearchParams 必须包在 Suspense 里（Next 静态导
// 出要求），否则 build 报错。
function AgentConfigContent() {
	const name = useSearchParams().get("name") ?? "";
	if (!name) {
		return <div className="p-6 text-sm text-muted-foreground">缺少 agent 名称（?name=）。</div>;
	}
	return <AgentConfigPage name={name} />;
}

export default function Page() {
	return (
		<div className="flex h-dvh">
			<NavRail view="agents" />
			<Suspense>
				<AgentConfigContent />
			</Suspense>
		</div>
	);
}
