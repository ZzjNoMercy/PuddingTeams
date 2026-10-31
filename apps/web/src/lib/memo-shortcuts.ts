export interface CaptureShortcutEvent {
	key: string;
	code?: string;
	repeat?: boolean;
	defaultPrevented?: boolean;
	isComposing?: boolean;
	keyCode?: number;
	metaKey?: boolean;
	ctrlKey?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
}

/** Meta（macOS）/Ctrl（Windows/Linux）+ Shift + Space；输入法正在组词时让路。 */
export function isCaptureShortcut(event: CaptureShortcutEvent): boolean {
	if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return false;
	if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return false;
	return event.code === "Space" || event.key === " ";
}

/** 已有模态层打开时不叠加捕获层。 */
export function shouldOpenCapture(event: CaptureShortcutEvent, options: { modalOpen: boolean }): boolean {
	return !options.modalOpen && isCaptureShortcut(event);
}

/** 速记页只保留自己的输入快捷键：⌘K 属于全局搜索，不能被速记接管。 */
export function isGlobalSearchShortcut(event: CaptureShortcutEvent): boolean {
	return Boolean(!event.defaultPrevented && !event.isComposing && (event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "k");
}
