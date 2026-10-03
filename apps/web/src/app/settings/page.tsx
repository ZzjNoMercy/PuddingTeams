"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { NavRail } from "@/components/chat/nav-rail";
import { DesktopTitlebar } from "@/components/desktop-titlebar";
import { SectionTopbar } from "@/components/section-topbar";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { HarnessSettingsPanel, type HarnessTab } from "@/components/settings/harness-settings";
import { ProviderSettings } from "@/components/settings/provider-settings";
import { WebResearchSettingsPanel } from "@/components/settings/web-research-settings";
import { FeishuSettings } from "@/components/settings/feishu-settings";

type SettingsSection = "appearance" | "harness" | "providers" | "network" | "feishu";

const sections: Array<{ id: SettingsSection; title: string }> = [
	{ id: "appearance", title: "外观" },
	{ id: "harness", title: "Harness" },
	{ id: "providers", title: "模型" },
	{ id: "network", title: "联网" },
	{ id: "feishu", title: "飞书默认应用" },
];

function SettingsPageContent() {
	const router = useRouter();
	const query = useSearchParams();
	const requested = query.get("section");
	const section: SettingsSection = requested === "harness" || requested === "providers" || requested === "network" || requested === "feishu" ? requested : "appearance";
	const requestedSub = query.get("sub");
	const harnessTab: HarnessTab = requestedSub === "results" || requestedSub === "activation" || requestedSub === "recovery" || requestedSub === "verification" || requestedSub === "workspace" ? requestedSub : "search";
	const [harnessVisited, setHarnessVisited] = useState(section === "harness");
	const contentRef = useRef<HTMLElement>(null);
	useEffect(() => {
		contentRef.current?.scrollTo({ top: 0, behavior: "instant" });
	}, [section, harnessTab]);
	const selectSection = (next: SettingsSection) => {
		if (next === "harness") setHarnessVisited(true);
		router.push(next === "appearance" ? "/settings" : `/settings?section=${next}`);
	};
	const selectHarnessTab = (next: HarnessTab) => router.push(next === "search" ? "/settings?section=harness" : `/settings?section=harness&sub=${next}`);
	return (
		<div className="settings-route-panel">
			<header className="settings-header">
				<div><h1 className="settings-title">设置</h1><p className="settings-description">调整你的界面偏好与平台运行方式。</p></div>
			</header>
			<div className="settings-body">
				<nav className="settings-nav" aria-label="设置分类">
					{sections.map((item) => <button key={item.id} type="button" className="settings-nav-item" data-active={section === item.id ? "true" : "false"} aria-current={section === item.id ? "page" : undefined} onClick={() => selectSection(item.id)}>{item.title}</button>)}
				</nav>
				<main ref={contentRef} className="settings-content" aria-label="设置内容">
					{section === "feishu" ? <FeishuSettings /> : null}
					{section === "network" ? <div className="settings-content-column"><div className="settings-section-heading"><h2>联网</h2><p>统一管理搜索供应商，按 Worker 授权联网。</p></div><WebResearchSettingsPanel /></div> : null}
					{section === "appearance" ? <div className="settings-content-column"><div className="settings-section-heading"><h2 id="appearance-heading">外观</h2><p>跟随你的工作习惯。</p></div><section className="settings-card settings-appearance-card" aria-labelledby="appearance-heading"><AppearanceSettings /></section></div> : null}
					{harnessVisited || section === "harness" ? <div className="settings-content-column" hidden={section !== "harness"}><div className="settings-section-heading"><h2 id="harness-heading">Harness</h2><p>控制 Manager 上下文预算、Goal 激活与安全恢复。</p></div><HarnessSettingsPanel selectedTab={harnessTab} onTabChange={selectHarnessTab} /></div> : null}
					{section === "providers" ? <div className="settings-content-column"><div className="settings-section-heading"><h2 id="providers-heading">模型</h2><p>管理模型凭证、可用模型与默认模型。</p></div><section className="settings-card settings-provider-card" aria-labelledby="providers-heading"><ProviderSettings /></section></div> : null}
				</main>
			</div>
		</div>
	);
}

export default function SettingsPage() {
	return (
		<div className="desktop-app-frame m1-app-shell h-dvh">
			<DesktopTitlebar />
			<div className="desktop-app-body">
				<div className="desktop-sidebar-stack desktop-sidebar-nav-only" data-app-sidebar-shell><NavRail view="settings" /></div>
				<div className="settings-route-shell">
					<SectionTopbar title="设置" />
					<Suspense fallback={<div className="settings-route-loading" role="status">正在加载设置…</div>}><SettingsPageContent /></Suspense>
				</div>
			</div>
		</div>
	);
}
