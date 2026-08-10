import type { FastifyInstance } from "fastify";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ArtifactStore } from "../agent-runtime/artifact-store.js";

/**
 * 交付物查询 API（§15.6：第一阶段只要求登记 + API 可查，不做产物面板）。
 *
 * - GET /api/artifacts?windowId=&delegationId=  列表（按窗口/委托过滤）；
 * - GET /api/artifacts/:id/content              下载登记文件本身。
 *
 * 防穿越：只读 store 里登记过的 artifact 的登记路径本身——没有路径参数，
 * realpath 必须等于登记路径（拒绝 symlink 指向登记目录之外）。
 */
export function registerArtifactsRoutes(app: FastifyInstance, artifacts: ArtifactStore): void {
	app.get<{ Querystring: { windowId?: string; delegationId?: string } }>("/api/artifacts", async (req) => {
		return {
			artifacts: await artifacts.list({
				windowId: req.query.windowId || undefined,
				delegationId: req.query.delegationId || undefined,
			}),
		};
	});

	app.get<{ Params: { id: string } }>("/api/artifacts/:id/content", async (req, reply) => {
		const record = await artifacts.get(req.params.id);
		if (!record) return reply.code(404).send({ error: "artifact not found" });

		const resolved = path.resolve(record.snapshotPath);
		let real: string;
		let root: string;
		let handle;
		try {
			// Open the final component without following a symlink. Validation and
			// streaming below stay bound to this descriptor, not a mutable pathname.
			handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
			real = await realpath(resolved);
			root = await realpath(path.dirname(record.snapshotPath));
		} catch {
			await handle?.close().catch(() => undefined);
			return reply.code(404).send({ error: "artifact file missing" });
		}
		const relative = path.relative(root, real);
		if (
			root !== path.dirname(record.snapshotPath) ||
			real !== record.snapshotPath ||
			relative === "" ||
			relative === ".." ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		) {
			await handle.close();
			return reply.code(403).send({ error: "artifact path rejected" });
		}
		let pathInfo;
		let fdInfo;
		try {
			[pathInfo, fdInfo] = await Promise.all([stat(real), handle.stat()]);
		} catch {
			await handle.close().catch(() => undefined);
			return reply.code(404).send({ error: "artifact file changed during download" });
		}
		if (!fdInfo.isFile() || pathInfo.dev !== fdInfo.dev || pathInfo.ino !== fdInfo.ino) {
			await handle.close();
			return reply.code(404).send({ error: "artifact is not a stable file" });
		}

		reply.header("content-type", "application/octet-stream");
		reply.header("etag", `"sha256-${record.contentHash}"`);
		reply.header("x-content-sha256", record.contentHash);
		reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(record.name)}`);
		return reply.send(handle.createReadStream({ autoClose: true }));
	});
}
