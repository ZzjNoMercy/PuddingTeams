import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// 发行态：server bundle 直接托管静态产物（单进程单端口），build 出纯静态文件。
	// dev 不受影响（next dev 忽略 output）。
	output: "export",
	// Accessing the dev server via 127.0.0.1 (not localhost) is cross-origin for
	// Next 16's dev resources; allow it so the IP form of the URL works.
	allowedDevOrigins: ["127.0.0.1"],
	// Hide the bottom-left "Open Next.js Dev Tools" floating button (dev only).
	devIndicators: false,
};

export default nextConfig;
