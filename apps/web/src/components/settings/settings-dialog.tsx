"use client";

import { XIcon } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { AppearanceSettings } from "./appearance-settings";
import { ProviderSettings } from "./provider-settings";

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="settings-panel"
				overlayClassName="settings-overlay"
				positionMode="drawer"
				showCloseButton={false}
			>
				<header className="settings-header">
					<div>
						<p className="settings-kicker">PREFERENCES</p>
						<DialogTitle className="settings-title">设置</DialogTitle>
					</div>
					<DialogClose asChild>
						<button type="button" className="settings-close" aria-label="关闭设置">
							<XIcon />
						</button>
					</DialogClose>
				</header>
				<div className="settings-scroll">
					<section className="settings-card" aria-labelledby="appearance-heading">
						<h2 id="appearance-heading">外观</h2>
						<AppearanceSettings />
					</section>
					<section className="settings-card settings-provider-card" aria-labelledby="providers-heading">
						<h2 id="providers-heading">模型 Provider</h2>
						<ProviderSettings />
					</section>
				</div>
			</DialogContent>
		</Dialog>
	);
}
