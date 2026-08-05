"use client";

import { useTheme, type Theme } from "@/components/theme-provider";
import { cn } from "@/lib/utils";

const OPTIONS: { value: Theme; label: string; hint: string }[] = [
	{ value: "system", label: "系统", hint: "跟随系统外观" },
	{ value: "light", label: "浅色", hint: "始终浅色" },
	{ value: "dark", label: "深色", hint: "始终深色" },
];

function ThemePreview({ theme }: { theme: Theme }) {
	const dark = theme === "dark";
	const system = theme === "system";
	return (
		<div
			className={cn(
				"flex h-16 w-full items-end gap-1 rounded-sm p-1.5",
				dark ? "bg-zinc-900" : "bg-zinc-100",
				system && "bg-gradient-to-r from-zinc-100 from-50% to-zinc-900 to-50%",
			)}
		>
			<div className={cn("h-3 w-1/2 rounded-xs", dark ? "bg-zinc-700" : "bg-zinc-300", system && "bg-zinc-500")} />
			<div className={cn("h-3 w-1/4 rounded-xs", dark ? "bg-zinc-600" : "bg-zinc-400")} />
		</div>
	);
}

export function AppearanceSettings() {
	const { theme, setTheme } = useTheme();

	return (
		<div className="flex gap-3">
			{OPTIONS.map((opt) => (
				<button
					type="button"
					key={opt.value}
					onClick={() => setTheme(opt.value)}
					className={cn(
						"flex w-36 flex-col gap-2 rounded-md border p-2 text-left transition-colors",
						theme === opt.value
							? "border-foreground/60 bg-accent"
							: "border-transparent hover:bg-muted/60",
					)}
				>
					<ThemePreview theme={opt.value} />
					<div>
						<div className="text-sm font-medium">{opt.label}</div>
						<div className="text-xs text-muted-foreground">{opt.hint}</div>
					</div>
				</button>
			))}
		</div>
	);
}
