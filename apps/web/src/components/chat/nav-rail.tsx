"use client";

import { useState } from "react";
import Link from "next/link";
import { BugIcon, BotIcon, InfoIcon, MessageSquareIcon, SettingsIcon, SlidersHorizontalIcon } from "lucide-react";
import { GithubIcon } from "@/components/github-icon";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { AboutDialog } from "@/components/settings/about-dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const GITHUB_URL = "https://github.com/ZzjNoMercy/PuddingTeams";
const ISSUE_URL = "https://github.com/ZzjNoMercy/PuddingTeams/issues/new";

export type AppView = "chat" | "agents";

/** 主导航：chat（/）与智能体（/agents）是独立路由，切换即跳转。 */
export function NavRail({ view }: { view: AppView }) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [aboutOpen, setAboutOpen] = useState(false);

	return (
		<div className="flex w-14 shrink-0 flex-col items-center border-r bg-muted/50 py-2">
			<Link
				href="/"
				title="对话"
				aria-label="对话"
				aria-current={view === "chat" ? "page" : undefined}
				className={cn(
					"flex size-9 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground",
					view === "chat" && "bg-accent text-accent-foreground",
				)}
			>
				<MessageSquareIcon className="size-4" />
			</Link>
			<Link
				href="/agents"
				title="智能体"
				aria-label="智能体"
				aria-current={view === "agents" ? "page" : undefined}
				className={cn(
					"mt-1 flex size-9 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground",
					view === "agents" && "bg-accent text-accent-foreground",
				)}
			>
				<BotIcon className="size-4" />
			</Link>

			<div className="flex-1" />

			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						title="设置和更多"
						aria-label="设置和更多"
						className="flex size-9 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
					>
						<SettingsIcon className="size-4" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent side="top" align="start" className="w-52">
					<DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
						<SlidersHorizontalIcon />
						设置
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem onSelect={() => window.open(GITHUB_URL, "_blank", "noreferrer")}>
						<GithubIcon />
						在 GitHub 上查看
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => window.open(ISSUE_URL, "_blank", "noreferrer")}>
						<BugIcon />
						报告问题
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => setAboutOpen(true)}>
						<InfoIcon />
						关于 PuddingTeams
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
			<AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
		</div>
	);
}
