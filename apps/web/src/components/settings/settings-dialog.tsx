"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { AppearanceSettings } from "./appearance-settings";
import { ProviderSettings } from "./provider-settings";

const TABS = [
	{ id: "providers", label: "模型 / Provider" },
	{ id: "appearance", label: "外观" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const [tab, setTab] = useState<TabId>("providers");

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex h-[70vh] gap-0 p-0 sm:max-w-3xl">
				<DialogTitle className="sr-only">设置</DialogTitle>
				<nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r bg-muted/30 p-3">
					<span className="px-2 pb-2 text-xs text-muted-foreground">设置</span>
					{TABS.map((t) => (
						<button
							type="button"
							key={t.id}
							onClick={() => setTab(t.id)}
							className={cn(
								"rounded-md px-2 py-1.5 text-left text-sm",
								tab === t.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted",
							)}
						>
							{t.label}
						</button>
					))}
				</nav>
				<div className="flex min-w-0 flex-1 flex-col p-4">
					{tab === "providers" ? <ProviderSettings /> : <AppearanceSettings />}
				</div>
			</DialogContent>
		</Dialog>
	);
}
