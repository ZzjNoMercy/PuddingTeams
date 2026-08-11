import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { WorkspaceResourceKind, WorkspaceStore, WorkspaceTrustState } from "../store/workspaces.js";
import type { PiSessionStore } from "../pi-bridge/session-store.js";
import { pickNativeDirectory } from "../platform/native-directory-picker.js";

export function registerWorkspacesRoutes(
	app: FastifyInstance,
	workspaces: WorkspaceStore,
	nativePicker: (initialPath: string) => Promise<string | undefined> = pickNativeDirectory,
	sessions?: PiSessionStore,
): void {
	app.get("/api/workspaces", async () => ({ workspaces: await workspaces.list() }));

	app.get<{ Params: { id: string } }>("/api/workspaces/:id", async (req, reply) => {
		const workspace = await workspaces.summary(req.params.id);
		if (!workspace) return reply.code(404).send({ error: "workspace not found" });
		return { workspace };
	});

	/**
	 * 信任决策（迁移方案 §7.2）：trusted/denied/pending。撤销信任（→pending/
	 * denied）时把引用该 workspace 的活跃窗口 Session 标 runtimeDirty（§7.3），
	 * 当前轮结束后空闲重建；响应带受影响会话数供前端提示。
	 */
	app.put<{ Params: { id: string }; Body: { state?: WorkspaceTrustState; approvedResources?: WorkspaceResourceKind[] } }>(
		"/api/workspaces/:id/trust",
		async (req, reply) => {
			const state = req.body?.state;
			if (state !== "pending" && state !== "trusted" && state !== "denied") {
				return reply.code(400).send({ error: "body must be { state: pending | trusted | denied, approvedResources? }" });
			}
			try {
				const workspace = await workspaces.setTrust(req.params.id, {
					state,
					...(req.body?.approvedResources !== undefined
						? { approvedResources: req.body.approvedResources }
						: {}),
				});
				const dirtySessions =
					state !== "trusted" && sessions ? await sessions.markWorkspaceDirty(req.params.id) : 0;
				return { workspace, dirtySessions };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return reply.code(msg.includes("not found") ? 404 : 400).send({ error: msg });
			}
		},
	);

	app.post<{ Body: { path?: string; name?: string; managed?: boolean } }>(
		"/api/workspaces",
		async (req, reply) => {
			try {
				const created = req.body?.managed
					? await workspaces.createManaged(req.body?.name)
					: await workspaces.createFromPath({ path: req.body?.path ?? "", name: req.body?.name });
				// 返回信任卡所需的安全元数据（§7.2：路径/gitRoot/资源类型数量，无正文）。
				return { workspace: (await workspaces.summary(created.id)) ?? created };
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
