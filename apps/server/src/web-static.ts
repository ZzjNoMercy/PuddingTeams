import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * 发行态静态托管：Next `output: "export"` 的产物（apps/web/out）由 server 同源
 * 托管，单进程单端口。dev 下 out/ 通常不存在（next dev 独立跑在 :8934），此时
 * 不注册；存在时也照常服务（可能是旧构建，仅作兜底）。
 *
 * 路径解析复刻仓库布局：本文件（或 esbuild bundle）位于 apps/server/src/ 下，
 * `../../../apps/web/out` 在仓库与 npm 包（apps/server/src/server.bundle.mjs）
 * 两种布局中都指向同一份产物。
 */
const WEB_OUT_DIR = fileURLToPath(new URL("../../../apps/web/out", import.meta.url));

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webp": "image/webp",
	".avif": "image/avif",
	".map": "application/json",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

function sendFile(reply: FastifyReply, filePath: string, status = 200): FastifyReply {
	return reply
		.status(status)
		.header("content-type", MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream")
		.send(createReadStream(filePath));
}

function resolvePage(urlPath: string, webOutDir: string): string | undefined {
	const rel = urlPath.replace(/^\/+/, "");
	if (!rel) return path.join(webOutDir, "index.html");
	// 防路径穿越：归一化后必须仍在 out/ 内。
	const candidates = [
		path.resolve(webOutDir, rel),
		path.resolve(webOutDir, `${rel}.html`),
		path.resolve(webOutDir, rel, "index.html"),
	];
	for (const candidate of candidates) {
		if (!candidate.startsWith(webOutDir + path.sep)) continue;
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

/**
 * out/index.html 存在时注册静态托管并返回 true。走 setNotFoundHandler：已注册
 * 的 /api/* 路由不受影响，未匹配的 /api/* 仍回 JSON 404，其余按页面/资源解析。
 */
export function registerWebStatic(app: FastifyInstance, webOutDir = WEB_OUT_DIR): boolean {
	if (!existsSync(path.join(webOutDir, "index.html"))) return false;
	const notFoundPage = path.join(webOutDir, "404.html");
	app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
		if (req.method !== "GET" && req.method !== "HEAD") {
			return reply.status(404).send({ message: `Route ${req.method}:${req.url} not found`, error: "Not Found", statusCode: 404 });
		}
		let urlPath = "/";
		try {
			urlPath = new URL(req.url, "http://localhost").pathname;
		} catch {
			return reply.status(404).send({ message: "Not Found", error: "Not Found", statusCode: 404 });
		}
		let decodedPath: string;
		try {
			decodedPath = decodeURIComponent(urlPath);
		} catch {
			return reply.status(404).send({ message: "Not Found", error: "Not Found", statusCode: 404 });
		}
		if (decodedPath === "/api" || decodedPath.startsWith("/api/")) {
			return reply.status(404).send({ message: `Route GET:${decodedPath} not found`, error: "Not Found", statusCode: 404 });
		}
		const file = resolvePage(decodedPath, webOutDir);
		if (file) return sendFile(reply, file);
		if (existsSync(notFoundPage)) return sendFile(reply, notFoundPage, 404);
		return reply.status(404).send({ message: "Not Found", error: "Not Found", statusCode: 404 });
	});
	return true;
}
