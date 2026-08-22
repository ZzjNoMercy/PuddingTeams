import { contextBridge, ipcRenderer } from "electron";

/**
 * 桌面宿主 bridge（白名单 IPC）：web 渲染进程通过 window.puddingteams 使用
 * 原生能力（系统目录选择器、Finder 显示、外部链接）。禁止直接暴露 ipcRenderer。
 */
const IPC = {
	pickDirectory: "puddingteams:pick-directory",
	revealInFinder: "puddingteams:reveal-in-finder",
	openExternal: "puddingteams:open-external",
} as const;

const desktopPlatform = process.platform;
// 同步标记首帧，并在真实页面 DOM 就绪后再次确认，避免首次导航时标记丢失。
const markDesktopPlatform = () => {
	document.documentElement.dataset.desktopPlatform = desktopPlatform;
};

if (document.documentElement) {
	markDesktopPlatform();
} else {
	window.addEventListener("DOMContentLoaded", markDesktopPlatform, { once: true });
}

contextBridge.exposeInMainWorld("puddingteams", {
	/** 标记运行在桌面宿主内（web 端据此切换原生目录选择器）。 */
	isDesktop: true,
	platform: desktopPlatform,
	pickDirectory: (initialPath?: string) => ipcRenderer.invoke(IPC.pickDirectory, initialPath),
	revealInFinder: (targetPath: string) => ipcRenderer.invoke(IPC.revealInFinder, targetPath),
	openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
});
