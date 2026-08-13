"use client";

import { useState } from "react";
import Link from "next/link";
import {
	BugIcon,
	BotIcon,
	InfoIcon,
	MessageSquareIcon,
	PanelLeftCloseIcon,
	PanelLeftOpenIcon,
	SettingsIcon,
	SlidersHorizontalIcon,
} from "lucide-react";
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
const COLLAPSED_KEY = "puddingteams:nav-collapsed";

export type AppView = "chat" | "agents";

/** 主导航：chat（/）与智能体（/agents）是独立路由，切换即跳转。可展开显示文字标签。 */
export function NavRail({ view }: { view: AppView }) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [aboutOpen, setAboutOpen] = useState(false);
	// 默认收起（纯图标）；持久化到 localStorage，initializer 守卫 SSR。
	const [collapsed, setCollapsed] = useState(() => {
		if (typeof window === "undefined") return true;
		return localStorage.getItem(COLLAPSED_KEY) !== "0";
	});
	const toggleCollapsed = () => {
		setCollapsed((prev) => {
			localStorage.setItem(COLLAPSED_KEY, prev ? "0" : "1");
			return !prev;
		});
	};

	const itemClass = (active: boolean) =>
		cn(
			"flex items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground",
			collapsed ? "size-9 justify-center" : "h-9 w-full gap-2.5 px-2.5 text-sm",
			active && "bg-accent text-accent-foreground",
		);

	return (
		<div
			className={cn(
				"flex shrink-0 flex-col border-r bg-muted/50 py-2 transition-[width] duration-150",
				collapsed ? "w-14 items-center" : "w-36 items-stretch px-2",
			)}
		>
			<Link href="/" title="对话" aria-label="对话" aria-current={view === "chat" ? "page" : undefined} className={itemClass(view === "chat")}>
				<MessageSquareIcon className="size-4 shrink-0" />
				{collapsed ? null : "对话"}
			</Link>
			<Link
				href="/agents"
				title="智能体"
				aria-label="智能体"
				aria-current={view === "agents" ? "page" : undefined}
				className={cn("mt-1", itemClass(view === "agents"))}
			>
				<BotIcon className="size-4 shrink-0" />
				{collapsed ? null : "智能体"}
			</Link>

			<div className="flex-1" />

			<button
				type="button"
				title={collapsed ? "展开导航" : "收起导航"}
				aria-label={collapsed ? "展开导航" : "收起导航"}
				aria-expanded={!collapsed}
				onClick={toggleCollapsed}
				className={cn("mb-1", itemClass(false))}
			>
				{collapsed ? <PanelLeftOpenIcon className="size-4 shrink-0" /> : <PanelLeftCloseIcon className="size-4 shrink-0" />}
				{collapsed ? null : "收起"}
			</button>

			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						title="设置和更多"
						aria-label="设置和更多"
						className={cn(itemClass(false), "data-[state=open]:bg-muted data-[state=open]:text-foreground")}
					>
						<SettingsIcon className="size-4 shrink-0" />
						{collapsed ? null : "设置"}
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
