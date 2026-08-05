import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// Accessing the dev server via 127.0.0.1 (not localhost) is cross-origin for
	// Next 16's dev resources; allow it so the IP form of the URL works.
	allowedDevOrigins: ["127.0.0.1"],
	// Hide the bottom-left "Open Next.js Dev Tools" floating button (dev only).
	devIndicators: false,
};

export default nextConfig;
