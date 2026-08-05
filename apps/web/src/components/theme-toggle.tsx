"use client";

import { MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/theme-provider";

export function ThemeToggle() {
	const { theme, setTheme } = useTheme();
	const isDark =
		theme === "dark" ||
		(theme === "system" &&
			typeof window !== "undefined" &&
			window.matchMedia("(prefers-color-scheme: dark)").matches);

	return (
		<Button
			type="button"
			size="icon-sm"
			variant="ghost"
			aria-label={isDark ? "切换到亮色模式" : "切换到暗色模式"}
			onClick={() => setTheme(isDark ? "light" : "dark")}
		>
			{isDark ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
		</Button>
	);
}
