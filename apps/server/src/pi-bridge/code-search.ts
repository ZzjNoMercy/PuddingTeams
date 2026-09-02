import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import fffExtension from "./pi-fff-runtime.js";
import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension,
	LoadExtensionsResult,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

export type HarnessCodeSearchProvider = "builtin" | "fff";
export type WorkerCodeSearchOverride = "inherit" | HarnessCodeSearchProvider;
export type ManagerCodeSearchProvider = "off" | HarnessCodeSearchProvider;

export interface WorkspaceCodeSearchScope {
	id: string;
	canonicalPath: string;
	trusted: boolean;
}

export function resolveWorkerCodeSearch(
	override: WorkerCodeSearchOverride | undefined,
	globalDefault: HarnessCodeSearchProvider,
): HarnessCodeSearchProvider {
	return !override || override === "inherit" ? globalDefault : override;
}

/** A stable, non-reversible directory key. Both identity and canonical path are required. */
export function workspaceSearchKey(scope: Pick<WorkspaceCodeSearchScope, "id" | "canonicalPath">): string {
	return createHash("sha256")
		.update(`${scope.id}\0${scope.canonicalPath}`)
		.digest("hex")
		.slice(0, 32);
}

function isPiFffExtension(extension: LoadExtensionsResult["extensions"][number]): boolean {
	const source = [extension.path, extension.resolvedPath]
		.filter(Boolean)
		.join("/")
		.replaceAll("\\", "/")
		.toLowerCase();
	return source.includes("@ff-labs/pi-fff") || source.includes("/pi-fff/");
}

function isPlatformManagedMcpAdapter(extension: LoadExtensionsResult["extensions"][number]): boolean {
	const source = [extension.path, extension.resolvedPath]
		.filter(Boolean)
		.join("/")
		.replaceAll("\\", "/")
		.toLowerCase();
	return source.includes("/pi-mcp-adapter/") || source.includes("/pi-mcp-adapter@");
}

/** Product policy wins over pi user-global discovery for platform-managed extensions. */
export function stripUnmanagedPlatformExtensions(base: LoadExtensionsResult): LoadExtensionsResult {
	return {
		...base,
		extensions: base.extensions.filter((extension) => !isPiFffExtension(extension) && !isPlatformManagedMcpAdapter(extension)),
	};
}

/** @deprecated Use stripUnmanagedPlatformExtensions. */
export const stripUnmanagedPiFff = stripUnmanagedPlatformExtensions;

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/**
 * Reject symlink traversal in the existing, non-glob prefix immediately before
 * handing a constraint to FFF. FFF owns the final scan, so fail closed instead
 * of accepting even an in-workspace symlink that could be retargeted later.
 */
async function assertNoSymlinkEscape(workspaceRoot: string, constraint: string): Promise<void> {
	const candidate = path.resolve(workspaceRoot, constraint);
	if (!isInside(workspaceRoot, candidate)) throw new Error("FFF 搜索范围不能离开当前 Workspace");
	const relative = path.relative(workspaceRoot, candidate);
	const components = relative.split(path.sep).filter(Boolean);
	let current = workspaceRoot;
	for (const component of components) {
		if (/[*?\[\]{}()]/.test(component)) break;
		current = path.join(current, component);
		try {
			const info = await lstat(current);
			if (info.isSymbolicLink()) throw new Error("FFF 搜索范围不能经过符号链接");
			const canonical = await realpath(current);
			if (!isInside(workspaceRoot, canonical)) throw new Error("FFF 搜索范围不能离开当前 Workspace");
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") break;
			throw err;
		}
	}
}

export async function buildWorkspaceFffExtension(input: {
	stateRoot: string;
	workspace: WorkspaceCodeSearchScope;
}): Promise<InlineExtension> {
	if (!input.workspace.trusted) throw new Error("FFF 只能为已信任的 Workspace 建立索引");
	const directory = path.join(input.stateRoot, workspaceSearchKey(input.workspace));
	const cursorPrefix = `pt_${workspaceSearchKey(input.workspace)}_`;
	const issuedCursors = new Set<string>();
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const flags = new Map<string, boolean | string>([
		["fff-mode", "override"],
		// FFF uses LMDB environments; these values are directories, not SQLite files.
		["fff-frecency-db", path.join(directory, "frecency")],
		["fff-history-db", path.join(directory, "history")],
		["fff-enable-root-scan", false],
		["fff-enable-home-scan", false],
	]);
	return {
		name: "puddingteams-workspace-fff",
		factory: (pi) => {
			const controlled = new Proxy(pi, {
				get(target, property, receiver) {
					if (property === "on") {
						return (event: string, handler: (event: SessionStartEvent, ctx: ExtensionContext) => unknown) => {
							if (event !== "session_start") return Reflect.apply(target.on, target, [event, handler]);
							// PuddingTeams 的 Workspace scope 是产品授权边界，不能让扩展
							// 从宿主进程 cwd 或调用方传错的 cwd 推导索引根。
							return Reflect.apply(target.on, target, [event, async (sessionEvent: SessionStartEvent, ctx: ExtensionContext) => handler(sessionEvent, {
								...ctx,
								cwd: input.workspace.canonicalPath,
							})]);
						};
					}
					if (property === "getFlag") {
						return (name: string) => flags.has(name) ? flags.get(name) : target.getFlag(name);
					}
					if (property === "registerCommand") {
						return (name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
							// Mode is a product policy, not mutable session state.
							if (name !== "fff-mode") target.registerCommand(name, options);
						};
					}
					if (property === "registerTool") {
						return (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => {
							if (!["grep", "find", "multi_grep"].includes(tool.name)) {
								target.registerTool(tool);
								return;
							}
							const originalExecute = tool.execute.bind(tool);
							const schema = tool.parameters as unknown as { properties?: Record<string, Record<string, unknown>> };
							const scopedParameters = schema.properties?.path
								? {
									...tool.parameters,
									properties: {
										...schema.properties,
										path: {
											...schema.properties.path,
											description: "仅限当前 Workspace 内的相对路径、文件名或 glob；禁止绝对路径、~/ 与 ../ 越界。",
										},
									},
								}
								: tool.parameters;
							target.registerTool({
								...tool,
								description: `${tool.description} Search scope is restricted to the current Workspace.`,
								parameters: scopedParameters,
								async execute(toolCallId, rawParams, signal, onUpdate, ctx) {
									const params = { ...(rawParams as Record<string, unknown>) };
									const constraint = typeof params.path === "string" ? params.path.trim() : undefined;
									if (constraint) {
										if (constraint === "~" || constraint.startsWith("~/") || path.isAbsolute(constraint)) throw new Error("FFF 搜索范围只能使用当前 Workspace 内的相对路径");
										await assertNoSymlinkEscape(input.workspace.canonicalPath, constraint);
									}
									if (typeof params.constraints === "string") {
										const constraints = params.constraints.split(/[\s,]+/).filter(Boolean);
										const escapes = constraints.some((item) => {
											const token = item.replace(/^!/, "");
											return path.isAbsolute(token) || token === ".." || token.startsWith("../") || token === "~" || token.startsWith("~/");
										});
										if (escapes) throw new Error("FFF multi_grep constraints 不能离开当前 Workspace");
										for (const item of constraints) {
											const token = item.replace(/^!/, "");
											await assertNoSymlinkEscape(input.workspace.canonicalPath, token);
										}
									}
									if (typeof params.cursor === "string") {
										if (!params.cursor.startsWith(cursorPrefix)) throw new Error("分页 cursor 不属于当前 Workspace");
										const rawCursor = params.cursor.slice(cursorPrefix.length);
										if (!issuedCursors.has(rawCursor)) throw new Error("分页 cursor 不属于当前 FFF Session");
										params.cursor = rawCursor;
									}
									const result = await originalExecute(toolCallId, params, signal, onUpdate, ctx);
									for (const block of result.content) {
										if (block.type !== "text") continue;
										block.text = block.text.replace(/cursor="([^"]+)"/g, (_match, cursor: string) => {
											const rawCursor = cursor.startsWith(cursorPrefix) ? cursor.slice(cursorPrefix.length) : cursor;
											issuedCursors.add(rawCursor);
											return `cursor="${cursorPrefix}${rawCursor}"`;
										});
									}
									return result;
								},
							});
						};
					}
					return Reflect.get(target, property, receiver);
				},
			}) as ExtensionAPI;
			// pi-fff 0.10.5 exposes multi_grep only through this construction-time env flag.
			// Scope the mutation to the synchronous factory call so it cannot become product-global state.
			const previousMultiGrep = process.env.PI_FFF_MULTIGREP;
			process.env.PI_FFF_MULTIGREP = "1";
			try {
				return fffExtension(controlled);
			} finally {
				if (previousMultiGrep === undefined) delete process.env.PI_FFF_MULTIGREP;
				else process.env.PI_FFF_MULTIGREP = previousMultiGrep;
			}
		},
	};
}
