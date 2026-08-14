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

/**
 * 展开/收起不走 React state：渲染输出与状态无关（SSR/客户端恒一致），布局与
 * 文字显隐由 globals.css 的 html[data-nav] 规则驱动；boot-init.js 在首帧绘制
 * 前按 localStorage 设置该属性，因此展开态刷新无"先收后展"闪动。
 * 这里只负责切换属性 + 持久化。
 */
function toggleNav(): void {
	const el = document.documentElement;
	const expanded = el.dataset.nav === "expanded";
	if (expanded) delete el.dataset.nav;
	else el.dataset.nav = "expanded";
	localStorage.setItem(COLLAPSED_KEY, expanded ? "1" : "0");
}

/** 主导航：chat（/）与智能体（/agents）是独立路由，切换即跳转。 */
export function NavRail({ view }: { view: AppView }) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [aboutOpen, setAboutOpen] = useState(false);

	const itemClass = (active: boolean) =>
		cn(
			"nav-item flex items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground",
			active && "bg-accent text-accent-foreground",
		);

	return (
		<div className="nav-rail flex shrink-0 flex-col border-r bg-muted/50 py-2 transition-[width] duration-150">
			<Link href="/" title="对话" aria-label="对话" aria-current={view === "chat" ? "page" : undefined} className={itemClass(view === "chat")}>
				<MessageSquareIcon className="size-4 shrink-0" />
				<span className="nav-label">对话</span>
			</Link>
			<Link
				href="/agents"
				title="智能体"
				aria-label="智能体"
				aria-current={view === "agents" ? "page" : undefined}
				className={cn("mt-1", itemClass(view === "agents"))}
			>
				<BotIcon className="size-4 shrink-0" />
				<span className="nav-label">智能体</span>
			</Link>

			<div className="flex-1" />

			<button
				type="button"
				title="展开/收起导航"
				aria-label="展开/收起导航"
				onClick={toggleNav}
				className={cn("mb-1", itemClass(false))}
			>
				<PanelLeftOpenIcon className="nav-collapsed-only size-4 shrink-0" />
				<PanelLeftCloseIcon className="nav-expanded-only size-4 shrink-0" />
				<span className="nav-label">收起</span>
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
						<span className="nav-label">设置</span>
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
