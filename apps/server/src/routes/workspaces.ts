import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { WorkspaceStore } from "../store/workspaces.js";
import { pickNativeDirectory } from "../platform/native-directory-picker.js";

export function registerWorkspacesRoutes(
	app: FastifyInstance,
	workspaces: WorkspaceStore,
	nativePicker: (initialPath: string) => Promise<string | undefined> = pickNativeDirectory,
): void {
	app.get("/api/workspaces", async () => ({ workspaces: await workspaces.list() }));

	app.post<{ Body: { path?: string; name?: string; managed?: boolean } }>(
		"/api/workspaces",
		async (req, reply) => {
			try {
				const workspace = req.body?.managed
					? await workspaces.createManaged(req.body?.name)
					: await workspaces.createFromPath({ path: req.body?.path ?? "", name: req.body?.name });
				return { workspace };
			} catch (err) {
				return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
			}
		},
	);

	/** 服务端目录浏览：只返回目录，不把浏览器本机目录误当成 server cwd。 */
	app.get<{ Querystring: { path?: string } }>("/api/workspaces/browse", async (req, reply) => {
		const requested = req.query.path?.trim();
		if (!requested || !path.isAbsolute(requested)) {
			return reply.code(400).send({ error: "path 必须是服务端绝对路径" });
		}
		try {
			const current = await realpath(requested);
			if (!(await stat(current)).isDirectory()) throw new Error("not a directory");
			const entries = await readdir(current, { withFileTypes: true });
			return {
				path: current,
				parent: path.dirname(current),
				directories: entries
					.filter((entry) => entry.isDirectory())
					.map((entry) => ({ name: entry.name, path: path.join(current, entry.name) }))
					.sort((a, b) => a.name.localeCompare(b.name)),
			};
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.post<{ Body: { initialPath?: string } }>("/api/workspaces/pick-directory", async (req, reply) => {
		const requested = req.body?.initialPath?.trim();
		if (!requested || !path.isAbsolute(requested)) {
			return reply.code(400).send({ error: "initialPath 必须是服务端绝对路径" });
		}
		try {
			const initialPath = await realpath(requested);
			if (!(await stat(initialPath)).isDirectory()) throw new Error("not a directory");
			const selected = await nativePicker(initialPath);
			if (!selected) return { cancelled: true };
			const canonical = await realpath(selected);
			if (!(await stat(canonical)).isDirectory()) throw new Error("系统选择结果不是目录");
			return { path: canonical, cancelled: false };
		} catch (err) {
			return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
		}
	});
}
