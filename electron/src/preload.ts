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

contextBridge.exposeInMainWorld("puddingteams", {
	/** 标记运行在桌面宿主内（web 端据此切换原生目录选择器）。 */
	isDesktop: true,
	pickDirectory: (initialPath?: string) => ipcRenderer.invoke(IPC.pickDirectory, initialPath),
	revealInFinder: (targetPath: string) => ipcRenderer.invoke(IPC.revealInFinder, targetPath),
	openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
});
