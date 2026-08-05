"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "puddingteams-theme";

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
		if (typeof window === "undefined") return "system";
		const stored = localStorage.getItem(STORAGE_KEY);
		return stored === "light" || stored === "dark" ? stored : "system";
	});

	useEffect(() => {
		const root = document.documentElement;
		const apply = () => {
			root.classList.toggle("dark", resolveTheme(theme) === "dark");
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
