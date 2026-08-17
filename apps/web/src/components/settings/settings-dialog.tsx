"use client";

import { useState } from "react";
import { PaletteIcon, ServerCogIcon, XIcon } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AppearanceSettings } from "./appearance-settings";
import { ProviderSettings } from "./provider-settings";

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const [section, setSection] = useState<"appearance" | "providers">("appearance");
	const sectionKicker = section === "appearance" ? "APPEARANCE" : "PROVIDERS";

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
						<DialogDescription className="sr-only">调整界面外观和模型 Provider。</DialogDescription>
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
						<button
							type="button"
							className="settings-nav-item"
							data-active={section === "providers" ? "true" : "false"}
							onClick={() => setSection("providers")}
						>
							<ServerCogIcon aria-hidden="true" />
							<span><strong>模型 Provider</strong><small>凭证与默认模型</small></span>
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
						) : (
							<div className="settings-content-column">
								<div className="settings-section-heading">
									<h2 id="providers-heading">模型 Provider</h2>
									<p>管理模型凭证、可用模型与默认模型。</p>
								</div>
								<section className="settings-card settings-provider-card" aria-labelledby="providers-heading">
									<ProviderSettings />
								</section>
							</div>
						)}
					</main>
				</div>
			</DialogContent>
		</Dialog>
	);
}
