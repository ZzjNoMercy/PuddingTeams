"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
	BugIcon,
	BotIcon,
	BoxesIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	InfoIcon,
	MessageSquareIcon,
	LayoutDashboardIcon,
	BookOpenIcon,
	BookmarkIcon,
	CalendarDaysIcon,
	UsersIcon,
	SearchIcon,
	SlidersHorizontalIcon,
	MoonIcon,
	SunIcon,
	UserRoundPenIcon,
} from "lucide-react";
import { GithubIcon } from "@/components/github-icon";
import { ProductAvatar } from "@/components/product-avatar";
import { AboutDialog } from "@/components/settings/about-dialog";
import { ProfileDialog } from "@/components/settings/profile-dialog";
import { GlobalSearchDialog } from "@/components/chat/global-search-dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { homePortalContainer } from "@/lib/home-portal";
import { getViewerIdentity, viewerAvatarUrl } from "@/lib/api";
import { useTheme } from "@/components/theme-provider";
import type { ViewerIdentity } from "@/lib/types";
import { readingRequest, type ReadingList } from "@/lib/read-later";

const GITHUB_URL = "https://github.com/ZzjNoMercy/PuddingTeams";
const ISSUE_URL = "https://github.com/ZzjNoMercy/PuddingTeams/issues/new";
const navListeners = new Set<() => void>();
const subscribeNav = (listener: () => void) => { navListeners.add(listener); return () => { navListeners.delete(listener); }; };
const navExpanded = () => document.documentElement.dataset.nav === "expanded";
export type AppView = "workbench" | "chat" | "agents" | "extensions" | "settings" | "knowledge" | "review" | "calendar" | "contacts" | "read-later";

function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length > 1) return `${parts[0]![0] ?? ""}${parts.at(-1)![0] ?? ""}`.toUpperCase();
	return Array.from(parts[0] ?? "用户").slice(0, 2).join("").toUpperCase();
}

/** 主导航：对话、智能体与扩展是独立路由，切换即跳转。 */
export function NavRail({ view, returnSessionId }: { view: AppView; returnSessionId?: string | null }) {
	const router = useRouter();
	const { setTheme } = useTheme();
	const [aboutOpen, setAboutOpen] = useState(false);
	const [profileOpen, setProfileOpen] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	const expanded = useSyncExternalStore(subscribeNav, navExpanded, () => false);
	const [identityState, setIdentityState] = useState<{ status: "loading" | "ready" | "error"; identity: ViewerIdentity | null }>({ status: "loading", identity: null });
	const [identityRetry, setIdentityRetry] = useState(0);
	const [readLaterUnread, setReadLaterUnread] = useState<number | null>(null);
	useEffect(() => {
		let active = true;
		const refresh = () => { void readingRequest<ReadingList>("?limit=1").then(data => { if (active) setReadLaterUnread(data.counts.unread ?? 0); }).catch(() => { if (active) setReadLaterUnread(null); }); };
		refresh(); const timer = setInterval(refresh, 30_000);
		window.addEventListener("pudding-read-later-changed", refresh);
		return () => { active = false; clearInterval(timer); window.removeEventListener("pudding-read-later-changed", refresh); };
	}, []);
	useEffect(() => {
		let active = true;
		void getViewerIdentity()
			.then((next) => {
				if (active) setIdentityState({ status: "ready", identity: next });
			})
			.catch(() => {
				if (active) setIdentityState({ status: "error", identity: null });
			});
		return () => {
			active = false;
		};
	}, [identityRetry]);
	const identity = identityState.identity;
	const username = identity ? identity.user.displayName.trim() || identity.user.username.trim() || "未命名用户" : identityState.status === "error" ? "身份读取失败" : "正在加载身份";
	useEffect(() => {
		const onShortcut = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				typeof event.key !== "string" ||
				event.key.toLowerCase() !== "k" ||
				!(event.metaKey || event.ctrlKey)
			) return;
			event.preventDefault();
			setSearchOpen(true);
		};
		window.addEventListener("keydown", onShortcut);
		return () => window.removeEventListener("keydown", onShortcut);
	}, []);

	const toggleWebExpanded = () => {
		const next = document.documentElement.dataset.nav !== "expanded";
		if (next) document.documentElement.dataset.nav = "expanded";
		else delete document.documentElement.dataset.nav;
		for (const listener of navListeners) listener();
		try { localStorage.setItem("puddingteams:web-nav-expanded", next ? "1" : "0"); }
		catch { /* The current page still reflects the user's choice when storage is denied. */ }
	};

	// 颜色/字重由 globals.css 的 .nav-item 规则接管（对齐原型色板），这里只留结构类。
	const itemClass = () =>
		"nav-item flex items-center rounded-md outline-none transition-colors";

	return (
		<div id="app-primary-navigation" className="nav-rail flex shrink-0 flex-col" data-app-sidebar="nav">
			<Link href="/" className="nav-brand" title="PuddingTeams" aria-label="PuddingTeams 首页">
				<ProductAvatar size={38} shape="square" className="nav-brand-mark" />
				<span className="nav-brand-name nav-label">
					<strong>PuddingTeams</strong>
					<small className="nav-brand-caption" aria-hidden="true">YOUR PERSONAL WORKSPACE</small>
				</span>
			</Link>
			<button type="button" className="nav-search-trigger" title="搜索工作、对话、智能体与资料（⌘/Ctrl+K）" aria-label="搜索工作、对话、智能体与资料" onClick={() => setSearchOpen(true)}>
				<SearchIcon className="size-4 shrink-0" />
				<span className="nav-search-label">搜索工作与资料</span>
				<kbd className="nav-search-shortcut">⌘ K</kbd>
			</button>
			<div className="nav-primary">
			<Link href="/" title="工作台" aria-label="工作台" aria-current={view === "workbench" ? "page" : undefined} className={itemClass()}>
				<LayoutDashboardIcon className="size-4 shrink-0" />
				<span className="nav-label">工作台</span>
				<span className="nav-workbench-sub" aria-hidden="true">Manager</span>
			</Link>
			<Link href="/chats" title="对话" aria-label="对话" aria-current={view === "chat" ? "page" : undefined} className={cn("mt-1", itemClass())}>
				<MessageSquareIcon className="size-4 shrink-0" />
				<span className="nav-label">对话</span>
			</Link>
			<Link href="/contacts" title="通讯录" aria-label="通讯录" aria-current={view === "contacts" ? "page" : undefined} className={cn("mt-1", itemClass())}>
				<UsersIcon className="size-4 shrink-0" /><span className="nav-label">通讯录</span>
			</Link>
			<Link href="/calendar" title="日历" aria-label="日历" aria-current={view === "calendar" ? "page" : undefined} className={cn("mt-1", itemClass())}>
				<CalendarDaysIcon className="size-4 shrink-0" />
				<span className="nav-label">日历</span>
			</Link>
			<Link href="/knowledge" title="知识库" aria-label="知识库" aria-current={view === "knowledge" || view === "review" ? "page" : undefined} className={cn("mt-1", itemClass())}>
				<BookOpenIcon className="size-4 shrink-0" />
				<span className="nav-label">知识库</span>
			</Link>
			<Link href="/read-later" title="稍后读" aria-label="稍后读" aria-current={view === "read-later" ? "page" : undefined} className={cn("mt-1", itemClass())}>
				<BookmarkIcon className="size-4 shrink-0" />
				<span className="nav-label">稍后读</span>
				{readLaterUnread !== null && readLaterUnread > 0 ? <span className="nav-label ml-auto text-[10px] text-muted-foreground" aria-label={`${readLaterUnread} 篇未读`}>{readLaterUnread}</span> : null}
			</Link>
			<Link
				href="/agents"
				title="智能体"
				aria-label="智能体"
				aria-current={view === "agents" ? "page" : undefined}
				className={cn("mt-1", itemClass())}
			>
				<BotIcon className="size-4 shrink-0" />
				<span className="nav-label">智能体</span>
			</Link>
			<Link
				href="/extensions"
				title="扩展"
				aria-label="扩展"
				aria-current={view === "extensions" ? "page" : undefined}
				className={cn("mt-1", itemClass())}
			>
				<BoxesIcon className="size-4 shrink-0" />
				<span className="nav-label">扩展</span>
			</Link>
			</div>

			<div className="flex-1" />

			<div className="nav-user-row">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						title={`${username}：个人资料与设置`}
						aria-label={`${username}：个人资料与设置`}
						className="nav-user"
						data-track="nav.current-user"
						data-user-id={identity?.user.id}
						data-tenant-id={identity?.tenant.id}
					>
						<span className="nav-user-avatar" aria-hidden="true">{identity?.user.avatarVersion !== undefined ? (
							// A tiny local API image; Next's remote image optimizer is unavailable in static export.
							// eslint-disable-next-line @next/next/no-img-element
							<img src={viewerAvatarUrl(identity.user.avatarVersion)} alt="" />
						) : identity ? initialsOf(username) : "?"}</span>
						<span className="nav-user-name">{username}</span>
						<ChevronRightIcon className="nav-user-chevron size-3" aria-hidden="true" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent side="top" align="start" className="home-menu w-52" container={homePortalContainer()}>
						{identityState.status === "error" ? <DropdownMenuItem onSelect={() => { setIdentityState({ status: "loading", identity: null }); setIdentityRetry((value) => value + 1); }}>重试读取身份</DropdownMenuItem> : null}
						{identity ? <DropdownMenuItem onSelect={() => setProfileOpen(true)}><UserRoundPenIcon />编辑个人资料</DropdownMenuItem> : null}
						<DropdownMenuItem onSelect={() => router.push("/settings")}>
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
			<button type="button" className="nav-theme-toggle" aria-label="切换主题" title="切换主题" onClick={() => setTheme(document.documentElement.classList.contains("dark") ? "light" : "dark")}>
				<MoonIcon className="size-4 dark:hidden" aria-hidden="true" />
				<SunIcon className="hidden size-4 dark:block" aria-hidden="true" />
			</button>
			</div>

			<AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />
			{identity && profileOpen ? <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} identity={identity} onSaved={(next) => setIdentityState({ status: "ready", identity: next })} /> : null}
			{searchOpen ? <GlobalSearchDialog open onOpenChange={setSearchOpen} returnSessionId={returnSessionId} /> : null}

			<button
				type="button"
				title={expanded ? "收起侧边栏" : "展开侧边栏"}
				aria-label={expanded ? "收起侧边栏" : "展开侧边栏"}
				aria-controls="app-primary-navigation"
				aria-expanded={expanded}
				onClick={toggleWebExpanded}
				className="nav-edge-toggle"
			>
				<ChevronRightIcon className="nav-collapsed-only size-3.5" aria-hidden="true" />
				<ChevronLeftIcon className="nav-expanded-only size-3.5" aria-hidden="true" />
			</button>
		</div>
	);
}
