"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { PanelLeftIcon } from "lucide-react";
import { getDesktopBridge } from "@/lib/desktop";

const SIDEBAR_STORAGE_KEY = "puddingteams:desktop-sidebar-hidden";
const SIDEBAR_CHANGE_EVENT = "puddingteams:sidebar-change";

function persistedSidebarHidden(): boolean {
	if (typeof window === "undefined") return false;
	return document.documentElement.dataset.sidebar === "hidden";
}

function applySidebarHidden(hidden: boolean): void {
	if (hidden) document.documentElement.dataset.sidebar = "hidden";
	else delete document.documentElement.dataset.sidebar;
	window.localStorage.setItem(SIDEBAR_STORAGE_KEY, hidden ? "1" : "0");
	window.dispatchEvent(new Event(SIDEBAR_CHANGE_EVENT));
}

function subscribeSidebarChange(callback: () => void): () => void {
	window.addEventListener(SIDEBAR_CHANGE_EVENT, callback);
	return () => window.removeEventListener(SIDEBAR_CHANGE_EVENT, callback);
}

/**
 * Electron macOS 专用标题栏。原生交通灯占据左侧安全区，应用操作从其后开始；
 * 浏览器中保持隐藏，不改变 Web 版现有的信息层级。
 */
export function DesktopTitlebar() {
	const sidebarHidden = useSyncExternalStore(subscribeSidebarChange, persistedSidebarHidden, () => false);

	useEffect(() => {
		for (const shell of document.querySelectorAll<HTMLElement>("[data-app-sidebar-shell]")) {
			if (sidebarHidden) {
				shell.setAttribute("inert", "");
				shell.setAttribute("aria-hidden", "true");
			} else {
				shell.removeAttribute("inert");
				shell.removeAttribute("aria-hidden");
			}
		}
	}, [sidebarHidden]);

	const toggleSidebar = useCallback(() => {
		const next = document.documentElement.dataset.sidebar !== "hidden";
		applySidebarHidden(next);
	}, []);

	useEffect(() => {
		if (!getDesktopBridge()) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.metaKey && event.key.toLocaleLowerCase() === "b") {
				event.preventDefault();
				toggleSidebar();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [toggleSidebar]);

	return (
		<header className="desktop-titlebar" aria-label="应用导航栏">
			<div className="desktop-titlebar-traffic-zone" aria-hidden="true" />
			<button
				type="button"
				className="desktop-titlebar-button"
				onClick={toggleSidebar}
				aria-label={sidebarHidden ? "展开侧边栏" : "收起侧边栏"}
				title={`${sidebarHidden ? "展开" : "收起"}侧边栏（⌘B）`}
			>
				<PanelLeftIcon aria-hidden="true" />
			</button>
			<div className="desktop-titlebar-drag-fill" />
		</header>
	);
}
