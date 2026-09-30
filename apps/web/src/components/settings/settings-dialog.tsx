"use client";

import { useState } from "react";
import { BrainCircuitIcon, PaletteIcon, ServerCogIcon, XIcon } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AppearanceSettings } from "./appearance-settings";
import { ProviderSettings } from "./provider-settings";
import { HarnessSettingsPanel } from "./harness-settings";

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const [section, setSection] = useState<"appearance" | "providers" | "harness">("appearance");
	const [harnessVisited, setHarnessVisited] = useState(false);
	const sectionKicker = section === "appearance" ? "APPEARANCE" : section === "providers" ? "PROVIDERS" : "HARNESS";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="settings-panel"
				overlayClassName="settings-overlay"
				showCloseButton={false}
			>
				<header className="settings-header">
					<div>
						<p className="settings-kicker" aria-live="polite">{sectionKicker}</p>
						<DialogTitle className="settings-title">设置</DialogTitle>
						<DialogDescription className="sr-only">调整界面外观和模型设置。</DialogDescription>
					</div>
					<DialogClose asChild>
						<button type="button" className="settings-close" aria-label="关闭设置">
							<XIcon />
						</button>
					</DialogClose>
				</header>
				<div className="settings-body">
					<nav className="settings-nav" aria-label="设置分类">
						<button
							type="button"
							className="settings-nav-item"
							data-active={section === "appearance" ? "true" : "false"}
							onClick={() => setSection("appearance")}
						>
							<PaletteIcon aria-hidden="true" />
							<span><strong>外观</strong><small>主题与动态效果</small></span>
						</button>
						<button type="button" className="settings-nav-item" data-active={section === "harness" ? "true" : "false"} onClick={() => { setHarnessVisited(true); setSection("harness"); }}>
							<BrainCircuitIcon aria-hidden="true" />
							<span><strong>Harness</strong><small>上下文与恢复策略</small></span>
						</button>
						<button
							type="button"
							className="settings-nav-item"
							data-active={section === "providers" ? "true" : "false"}
							onClick={() => setSection("providers")}
						>
							<ServerCogIcon aria-hidden="true" />
							<span><strong>模型</strong><small>凭证与默认模型</small></span>
						</button>
					</nav>
					<main className="settings-content">
						{section === "appearance" ? (
							<div className="settings-content-column">
								<div className="settings-section-heading">
									<h2 id="appearance-heading">外观</h2>
									<p>选择界面主题，并控制非必要的动态效果。</p>
								</div>
								<section className="settings-card" aria-labelledby="appearance-heading">
									<AppearanceSettings />
								</section>
							</div>
						) : null}
						{section === "providers" ? (
							<div className="settings-content-column">
								<div className="settings-section-heading">
									<h2 id="providers-heading">模型</h2>
									<p>管理模型凭证、可用模型与默认模型。</p>
								</div>
								<section className="settings-card settings-provider-card" aria-labelledby="providers-heading">
									<ProviderSettings />
								</section>
							</div>
						) : null}
						{harnessVisited ? (
							<div className="settings-content-column" hidden={section !== "harness"}>
								<div className="settings-section-heading"><h2 id="harness-heading">Harness</h2><p>控制 Manager 上下文预算、Goal 激活与安全恢复。</p></div>
								<HarnessSettingsPanel />
							</div>
						) : null}
					</main>
				</div>
			</DialogContent>
		</Dialog>
	);
}
