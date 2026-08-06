"use client";

import { useState } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
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
			<DialogContent className="flex h-[70vh] flex-col gap-0 p-0 sm:max-w-3xl" showCloseButton={false}>
				<DialogTitle className="sr-only">设置</DialogTitle>
				<header className="flex shrink-0 items-center justify-between border-b px-4 py-2">
					<span className="text-sm font-medium">设置</span>
					<DialogClose asChild>
						<Button type="button" size="sm" variant="outline" className="gap-1">
							<XIcon className="size-3.5" />
							关闭
						</Button>
					</DialogClose>
				</header>
				<div className="flex min-h-0 flex-1">
					<nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r p-3">
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
				</div>
			</DialogContent>
		</Dialog>
	);
}
