import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { AppToaster } from "@/components/app-toaster";

export const metadata: Metadata = {
	title: "PuddingTeams",
	description: "基于 pi 的 agent teams 平台",
};

// Parser-blocking inline initialization: apply persisted visual preferences
// and an explicit canvas color before the full stylesheet can paint.
const visualPreferenceInitScript = `(function(){try{var r=document.documentElement;var t=localStorage.getItem("puddingteams-theme");var d=t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d)r.classList.add("dark");r.style.colorScheme=d?"dark":"light";r.style.backgroundColor=d?"oklch(0.24 0.0036 106.64)":"oklch(0.9855 0.0098 87.47)";if(localStorage.getItem("puddingteams:nav-collapsed")==="0")r.dataset.nav="expanded"}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
			<head>
				<script dangerouslySetInnerHTML={{ __html: visualPreferenceInitScript }} />
			</head>
			<body className="flex min-h-full flex-col">
				<ThemeProvider>
					{children}
					<AppToaster />
				</ThemeProvider>
			</body>
		</html>
	);
}
