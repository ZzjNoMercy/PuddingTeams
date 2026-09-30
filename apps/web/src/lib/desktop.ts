/**
 * Electron 桌面宿主 bridge（electron/src/preload.ts 注入 window.puddingteams）。
 * 纯类型声明 + 探测辅助，不依赖任何运行时环境。
 */
export interface PuddingTeamsDesktop {
	isDesktop: boolean;
	platform: "darwin" | "win32" | "linux";
	pickDirectory: (initialPath?: string) => Promise<string | null>;
	revealInFinder: (targetPath: string) => Promise<void>;
	openExternal: (url: string) => Promise<void>;
	/** 在 Obsidian 中打开（T24）：主进程复核 obsidian:// URI 后调起，失败返回 error。 */
	openInObsidian: (uri: string) => Promise<{ ok: boolean; error?: string }>;
}

declare global {
	interface Window {
		puddingteams?: PuddingTeamsDesktop;
	}
}

export function getDesktopBridge(): PuddingTeamsDesktop | undefined {
	if (typeof window === "undefined") return undefined;
	return window.puddingteams;
}
