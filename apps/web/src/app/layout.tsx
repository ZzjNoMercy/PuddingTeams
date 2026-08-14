import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { AppToaster } from "@/components/app-toaster";

export const metadata: Metadata = {
	title: "PuddingTeams",
	description: "基于 pi 的 agent teams 平台",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
			<head>
				{/* 首帧初始化（public/boot-init.js）：主题 dark class + 导航 data-nav。
				    async+src 走 React 19 原生 script 提升（head、去重、无告警）；
				    blocking=render 保证偏好应用前不绘制，避免展开态刷新闪动。 */}
				<script async blocking="render" src="/boot-init.js" />
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
