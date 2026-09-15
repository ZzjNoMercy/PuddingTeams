import type { FastifyInstance } from "fastify";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { DelegationStore } from "../agent-runtime/delegation-store.js";
import type { WorkspaceExecutionCoordinator, WorkspaceExecutionScope } from "../agent-runtime/workspace-execution.js";
import { openNativeFile } from "../platform/native-file-opener.js";

const PREVIEW_LIMIT = 2 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
	".md", ".mdx", ".txt", ".log", ".json", ".jsonl", ".csv", ".tsv",
	".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".js", ".jsx",
	".ts", ".tsx", ".py", ".sh", ".zsh", ".sql", ".rs", ".go", ".java",
]);

export type RuntimeFilePreview = "markdown" | "json" | "csv" | "text" | "external";

export interface RuntimeFileItem {
	name: string;
	path: string;
	extension: string;
	size?: number;
	updatedAt?: string;
	state: "available" | "deleted";
	preview: RuntimeFilePreview;
}

function normalizedRelative(input: string): string | undefined {
	if (!input || input.includes("\0") || path.isAbsolute(input)) return undefined;
	const normalized = input.replaceAll("\\", "/");
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.normalize(normalized) !== normalized) return undefined;
	return normalized;
}

function previewKind(relative: string): RuntimeFilePreview {
	const extension = path.extname(relative).toLowerCase();
	if (extension === ".md" || extension === ".mdx") return "markdown";
	if (extension === ".json" || extension === ".jsonl") return "json";
	if (extension === ".csv" || extension === ".tsv") return "csv";
	return TEXT_EXTENSIONS.has(extension) ? "text" : "external";
}

function absoluteInside(root: string, relative: string): string | undefined {
	const target = path.resolve(root, ...relative.split("/"));
	const relation = path.relative(root, target);
	if (!relation || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) return undefined;
	return target;
}

async function changedPathsFor(
	delegation: Awaited<ReturnType<DelegationStore["getDelegation"]>>,
	workspaceExecution: WorkspaceExecutionCoordinator,
): Promise<{ scope: WorkspaceExecutionScope; paths: string[] } | undefined> {
	if (!delegation?.workspaceExecutionScopeId) return undefined;
	const scope = await workspaceExecution.get(delegation.workspaceExecutionScopeId);
	if (!scope || !scope.delegationIds.includes(delegation.id)) return undefined;
	if (delegation.workspaceChangeSetId) {
		const changeSet = await workspaceExecution.getChangeSet(delegation.workspaceChangeSetId);
		if (changeSet?.executionScopeId === scope.id && changeSet.delegationIds.includes(delegation.id)) {
			return { scope, paths: changeSet.changedPaths };
		}
	}
	const observation = await workspaceExecution.observeChanges(scope.id);
	return { scope, paths: observation.changedPaths };
}

async function resolveChangedFile(
	delegationId: string,
	requestedPath: string,
	delegations: DelegationStore,
	workspaceExecution: WorkspaceExecutionCoordinator,
): Promise<{ target: string; relative: string } | { error: string; status: number }> {
	const delegation = await delegations.getDelegation(delegationId);
	if (!delegation) return { error: "delegation not found", status: 404 };
	const relative = normalizedRelative(requestedPath);
	if (!relative) return { error: "runtime file path rejected", status: 400 };
	let source;
	try {
		source = await changedPathsFor(delegation, workspaceExecution);
	} catch {
		return { error: "runtime file scope unavailable", status: 404 };
	}
	if (!source || !source.paths.includes(relative)) return { error: "runtime file is not attributed to this delegation", status: 404 };
	const target = absoluteInside(source.scope.executionRoot, relative);
	if (!target) return { error: "runtime file path rejected", status: 403 };
	let rootReal: string;
	let targetReal: string;
	try {
		[rootReal, targetReal] = await Promise.all([realpath(source.scope.executionRoot), realpath(target)]);
	} catch {
		return { error: "runtime file missing", status: 404 };
	}
	const relation = path.relative(rootReal, targetReal);
	if (targetReal !== target || relation === "" || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
		return { error: "runtime file path rejected", status: 403 };
	}
	return { target, relative };
}

export function registerRuntimeFilesRoutes(
	app: FastifyInstance,
	delegations: DelegationStore,
	workspaceExecution: WorkspaceExecutionCoordinator,
	options: { open?: (targetPath: string) => Promise<void> } = {},
): void {
	const openFile = options.open ?? openNativeFile;

	app.get<{ Params: { id: string } }>("/api/delegations/:id/files", async (req, reply) => {
		const delegation = await delegations.getDelegation(req.params.id);
		if (!delegation) return reply.code(404).send({ error: "delegation not found" });
		let source;
		try {
			source = await changedPathsFor(delegation, workspaceExecution);
		} catch (error) {
			return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
		}
		if (!source) return { files: [], scopeAvailable: false };
		const files: RuntimeFileItem[] = await Promise.all(source.paths.map(async (relative) => {
			const target = absoluteInside(source.scope.executionRoot, relative);
			const info = target ? await stat(target).catch(() => undefined) : undefined;
			const available = Boolean(info?.isFile());
			return {
				name: path.posix.basename(relative),
				path: relative,
				extension: path.extname(relative).slice(1).toLowerCase(),
				...(available ? { size: info!.size, updatedAt: info!.mtime.toISOString() } : {}),
				state: available ? "available" as const : "deleted" as const,
				preview: previewKind(relative),
			};
		}));
		return { files, scopeAvailable: true };
	});

	app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/delegations/:id/files/content", async (req, reply) => {
		const resolved = await resolveChangedFile(req.params.id, req.query.path ?? "", delegations, workspaceExecution);
		if ("error" in resolved) return reply.code(resolved.status).send({ error: resolved.error });
		if (!TEXT_EXTENSIONS.has(path.extname(resolved.relative).toLowerCase())) return reply.code(415).send({ error: "runtime file does not support inline preview" });
		let handle;
		try {
			handle = await open(resolved.target, constants.O_RDONLY | constants.O_NOFOLLOW);
			const info = await handle.stat();
			if (!info.isFile()) throw new Error("not a file");
			if (info.size > PREVIEW_LIMIT) {
				await handle.close();
				return reply.code(413).send({ error: "runtime file is too large to preview", limit: PREVIEW_LIMIT });
			}
			const content = await handle.readFile({ encoding: "utf8" });
			await handle.close();
			reply.header("content-type", "text/plain; charset=utf-8");
			reply.header("content-disposition", "inline");
			return reply.send(content);
		} catch {
			await handle?.close().catch(() => undefined);
			return reply.code(404).send({ error: "runtime file unavailable" });
		}
	});

	app.post<{ Params: { id: string }; Body: { path?: string } }>("/api/delegations/:id/files/open", async (req, reply) => {
		const resolved = await resolveChangedFile(req.params.id, req.body?.path ?? "", delegations, workspaceExecution);
		if ("error" in resolved) return reply.code(resolved.status).send({ error: resolved.error });
		try {
			await openFile(resolved.target);
			return { opened: true };
		} catch (error) {
			return reply.code(500).send({ error: error instanceof Error ? error.message : String(error) });
		}
	});
}
