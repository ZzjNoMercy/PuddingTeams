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
	const [theme, setThemeState] = useState<Theme>(() => {
		if (typeof window === "undefined") return "dark";
		const stored = localStorage.getItem(STORAGE_KEY);
		// Calm Ops is intentionally dark by default; an explicit light/system choice
		// remains available from Settings.
		return stored === "light" || stored === "dark" || stored === "system" ? stored : "dark";
	});

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
		localStorage.setItem(STORAGE_KEY, next);
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
