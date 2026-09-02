import { createMDX } from "fumadocs-mdx/next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const withMDX = createMDX();
const docsDir = fileURLToPath(new URL(".", import.meta.url));
const basePath = process.env.NEXT_PUBLIC_SITE_BASE_PATH ?? "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
  ...(basePath ? { basePath } : {}),
  turbopack: { root: path.resolve(docsDir, "../..") }
};

export default withMDX(nextConfig);
