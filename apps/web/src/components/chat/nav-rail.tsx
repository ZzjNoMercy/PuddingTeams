"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
	BugIcon,
	BotIcon,
	BoxesIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	InfoIcon,
	MessageSquareIcon,
	SlidersHorizontalIcon,
} from "lucide-react";
import { GithubIcon } from "@/components/github-icon";
import { ProductAvatar } from "@/components/product-avatar";
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
import { homePortalContainer } from "@/lib/home-portal";
import { getViewerIdentity } from "@/lib/api";
import type { ViewerIdentity } from "@/lib/types";

const GITHUB_URL = "https://github.com/ZzjNoMercy/PuddingTeams";
const ISSUE_URL = "https://github.com/ZzjNoMercy/PuddingTeams/issues/new";
export type AppView = "chat" | "agents" | "extensions";

function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length > 1) return `${parts[0]![0] ?? ""}${parts.at(-1)![0] ?? ""}`.toUpperCase();
	return Array.from(parts[0] ?? "用户").slice(0, 2).join("").toUpperCase();
}

/** 主导航：对话、智能体与扩展是独立路由，切换即跳转。 */
export function NavRail({ view }: { view: AppView }) {
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [aboutOpen, setAboutOpen] = useState(false);
	const [identity, setIdentity] = useState<ViewerIdentity | null>(null);
	useEffect(() => {
		let active = true;
		void getViewerIdentity()
			.then((next) => {
				if (active) setIdentity(next);
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, []);
	const username = identity?.user.displayName || identity?.user.username || "本地用户";

	const toggleExpanded = () => {
		const next = document.documentElement.dataset.nav !== "expanded";
		if (next) document.documentElement.dataset.nav = "expanded";
		else delete document.documentElement.dataset.nav;
		localStorage.setItem("puddingteams:nav-collapsed", next ? "0" : "1");
	};

	const itemClass = (active: boolean) =>
		cn(
			"nav-item flex items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground",
			active && "bg-accent text-accent-foreground",
		);

	return (
		<div className="nav-rail flex shrink-0 flex-col">
			<Link href="/" className="nav-brand" title="PuddingTeams" aria-label="PuddingTeams 首页">
				<ProductAvatar size={38} shape="square" className="nav-brand-mark" />
				<span className="nav-brand-name nav-label">PuddingTeams</span>
			</Link>
			<div className="nav-primary">
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
			<Link
				href="/extensions"
				title="扩展"
				aria-label="扩展"
				aria-current={view === "extensions" ? "page" : undefined}
				className={cn("mt-1", itemClass(view === "extensions"))}
			>
				<BoxesIcon className="size-4 shrink-0" />
				<span className="nav-label">扩展</span>
			</Link>
			</div>

			<div className="flex-1" />

			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						title={`${username}：设置和更多`}
						aria-label={`${username}：设置和更多`}
						className="nav-user"
						data-track="nav.current-user"
						data-user-id={identity?.user.id}
						data-tenant-id={identity?.tenant.id}
					>
						<span className="nav-user-avatar" aria-hidden="true">{initialsOf(username)}</span>
						<span className="nav-user-name">{username}</span>
					</button>
				</DropdownMenuTrigger>
				{/* 菜单关闭默认会把焦点还给触发器，浏览器启发式判定为键盘焦点，
				    导致鼠标用完菜单后 :focus-visible 描边一直挂着；拦截焦点归还。 */}
				<DropdownMenuContent side="top" align="start" className="home-menu w-52" container={homePortalContainer()} onCloseAutoFocus={(event) => event.preventDefault()}>
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

			<button
				type="button"
				title="展开或收起侧边栏"
				aria-label="展开或收起侧边栏"
				onClick={toggleExpanded}
				className="nav-edge-toggle"
			>
				<ChevronRightIcon className="nav-collapsed-only size-3.5" aria-hidden="true" />
				<ChevronLeftIcon className="nav-expanded-only size-3.5" aria-hidden="true" />
			</button>
		</div>
	);
}
