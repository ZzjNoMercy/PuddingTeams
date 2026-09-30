import type { FastifyInstance, FastifyReply } from "fastify";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ArtifactIntegrityError, type ArtifactStore } from "../agent-runtime/artifact-store.js";
import { openNativeFile } from "../platform/native-file-opener.js";
import { readBoundedPreviewBytes, TEXT_PREVIEW_EXTENSIONS, TEXT_PREVIEW_LIMIT } from "./file-preview.js";

function sendDownloadError(accept: string | undefined, reply: FastifyReply, status: number, message: string): FastifyReply {
	if (accept?.includes("text/html")) {
		reply.header("content-type", "text/plain; charset=utf-8");
		return reply.code(status).send(message);
	}
	return reply.code(status).send({ error: message });
}

/**
 * 交付物查询 API（§15.6：第一阶段只要求登记 + API 可查，不做产物面板）。
 *
 * - GET /api/artifacts?windowId=&delegationId=  列表（按窗口/委托过滤）；
 * - GET /api/artifacts/:id/content              下载登记文件本身。
 * - GET /api/artifacts/:id/preview              只读有界文本预览。
 *
 * 防穿越：只读 store 里登记过的 artifact 的登记路径本身——没有路径参数，
 * realpath 必须等于登记路径（拒绝 symlink 指向登记目录之外）。
 */
export function registerArtifactsRoutes(
	app: FastifyInstance,
	artifacts: ArtifactStore,
	options: { open?: (targetPath: string) => Promise<void> } = {},
): void {
	const openFile = options.open ?? openNativeFile;
	app.get<{ Querystring: { windowId?: string; delegationId?: string } }>("/api/artifacts", async (req) => {
		return {
			artifacts: await artifacts.list({
				windowId: req.query.windowId || undefined,
				delegationId: req.query.delegationId || undefined,
			}),
		};
	});

	app.get<{ Params: { id: string } }>("/api/artifacts/:id/content", async (req, reply) => {
		let prepared: Awaited<ReturnType<ArtifactStore["prepareDownload"]>>;
		try {
			prepared = await artifacts.prepareDownload(req.params.id);
			if (!prepared) return sendDownloadError(req.headers.accept, reply, 404, "交付物不存在，无法下载");
			const download = prepared;
			const handle = await open(prepared.filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
			const stream = handle.createReadStream({ autoClose: true });
			stream.once("close", () => { void download.cleanup().catch(() => undefined); });
			reply.raw.once("close", () => { stream.destroy(); });
			const { record } = prepared;
			reply.header("content-type", "application/octet-stream");
			reply.header("etag", `"sha256-${record.contentHash}"`);
			reply.header("x-content-sha256", record.contentHash);
			reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`);
			return reply.send(stream);
		} catch (error) {
			await prepared?.cleanup().catch(() => undefined);
			const code = (error as NodeJS.ErrnoException).code;
			const status = error instanceof ArtifactIntegrityError ? 409 : code === "ENOENT" ? 404 : code === "ENOSPC" ? 507 : 500;
			const message = error instanceof ArtifactIntegrityError
				? "交付物冻结快照与登记哈希不一致，无法下载"
				: code === "ENOSPC" ? "临时空间不足，无法生成已验证的完整下载" : "交付物文件不可用，无法下载";
			return sendDownloadError(req.headers.accept, reply, status, message);
		}
	});

	app.get<{ Params: { id: string } }>("/api/artifacts/:id/preview", async (req, reply) => {
		const record = await artifacts.get(req.params.id);
		if (!record) return reply.code(404).send({ error: "artifact not found" });
		if (!TEXT_PREVIEW_EXTENSIONS.has(path.extname(record.name).toLowerCase())) {
			return reply.code(415).send({ error: "artifact does not support inline preview" });
		}
		const resolved = path.resolve(record.snapshotPath);
		let handle;
		try {
			handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
			const [real, root, pathInfo, fdInfo] = await Promise.all([
				realpath(resolved),
				realpath(path.dirname(record.snapshotPath)),
				stat(resolved),
				handle.stat(),
			]);
			const relative = path.relative(root, real);
			if (
				root !== path.dirname(record.snapshotPath) || real !== record.snapshotPath ||
				relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
			) return reply.code(403).send({ error: "artifact path rejected" });
			if (!fdInfo.isFile() || pathInfo.dev !== fdInfo.dev || pathInfo.ino !== fdInfo.ino) {
				return reply.code(404).send({ error: "artifact is not a stable file" });
			}
			if (fdInfo.size > TEXT_PREVIEW_LIMIT) {
				return reply.code(413).send({ error: "交付物超过 2 MB，无法内嵌预览；请下载或用系统打开完整文件", limit: TEXT_PREVIEW_LIMIT });
			}
			const buffer = await readBoundedPreviewBytes(handle);
			if (!buffer) {
				return reply.code(413).send({ error: "交付物超过 2 MB，无法内嵌预览；请下载或用系统打开完整文件", limit: TEXT_PREVIEW_LIMIT });
			}
			if (createHash("sha256").update(buffer).digest("hex") !== record.contentHash) {
				return reply.code(409).send({ error: "交付物冻结快照与登记哈希不一致，无法作为已验证内容预览" });
			}
			let content: string;
			try {
				content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
			} catch {
				return reply.code(415).send({ error: "artifact is not valid UTF-8 text" });
			}
			reply.header("content-type", "text/plain; charset=utf-8");
			reply.header("content-disposition", "inline");
			return reply.send(content);
		} catch {
			return reply.code(404).send({ error: "artifact file unavailable" });
		} finally {
			await handle?.close().catch(() => undefined);
		}
	});

	app.post<{ Params: { id: string } }>("/api/artifacts/:id/open", async (req, reply) => {
		try {
			const target = await artifacts.materializeForOpen(req.params.id);
			if (!target) return reply.code(404).send({ error: "artifact not found" });
			await openFile(target);
			return { opened: true };
		} catch (error) {
			return reply.code(error instanceof ArtifactIntegrityError ? 409 : 500).send({ error: error instanceof Error ? error.message : String(error) });
		}
	});
}
