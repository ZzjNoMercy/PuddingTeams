"use client";

import {
	createContext,
	useContext,
	useEffect,
	useLayoutEffect,
	useState,
	type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "puddingteams-theme";

// useEffect 在绘制后才执行：若 hydration 失败触发客户端重建（或 dev 下 CSS
// 经 JS 异步注入尚未就绪），html 上的 dark 类/内联背景被剥掉后会先画一帧亮色。
// layout effect 在绘制前同步纠正，保证任何路径下都不闪白。
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

// 与 layout.tsx 内联脚本、globals.css :root/.dark 的 --background 保持一致。
const CANVAS_COLOR: Record<"light" | "dark", string> = {
	light: "#eef3f5",
	dark: "oklch(0.12 0.012 240)",
};

const ThemeContext = createContext<{ theme: Theme; setTheme: (t: Theme) => void } | null>(null);

function resolveTheme(theme: Theme): "light" | "dark" {
	if (theme === "system") {
		return typeof window !== "undefined" &&
			window.matchMedia("(prefers-color-scheme: dark)").matches
			? "dark"
			: "light";
	}
	return theme;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	// SSR 与首次客户端渲染统一用 "dark"。若在 useState 里直接读 localStorage，
	// 服务端拿不到用户偏好，读到 "light" 的用户会在 hydration 时把整棵子树判成不一致
	// （设置页的 aria-pressed 就是这么炸的）。真实偏好在下面的 layout effect 里补，
	// 绘制前同步完成，不会闪白。
	const [theme, setThemeState] = useState<Theme>("dark");

	useIsomorphicLayoutEffect(() => {
		let stored: string | null = null;
		try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* Keep the default usable when browser storage is denied. */ }
		// Calm Ops is intentionally dark by default; an explicit light/system choice
		// remains available from Settings.
		if (stored === "light" || stored === "dark" || stored === "system") setThemeState(stored);
	}, []);

	useIsomorphicLayoutEffect(() => {
		const root = document.documentElement;
		const apply = () => {
			const resolved = resolveTheme(theme);
			root.classList.toggle("dark", resolved === "dark");
			// 首帧由 head 内联脚本上色；这里不移除而是持续同步内联值——
			// dev 下 globals.css 经 JS 异步注入，贸然移除内联背景会闪白。
			root.style.colorScheme = resolved;
			root.style.backgroundColor = CANVAS_COLOR[resolved];
		};
		apply();
		if (theme === "system") {
			const mq = window.matchMedia("(prefers-color-scheme: dark)");
			mq.addEventListener("change", apply);
			return () => mq.removeEventListener("change", apply);
		}
	}, [theme]);

	const setTheme = (next: Theme) => {
		try { localStorage.setItem(STORAGE_KEY, next); } catch { /* This tab can still apply the selected theme. */ }
		setThemeState(next);
	};

	return (
		<ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
	);
}

export function useTheme() {
	const ctx = useContext(ThemeContext);
	if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
	return ctx;
}
