import { createHash, randomUUID } from "node:crypto";
import { access, chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Execution ownership is deliberately separate from WorkspaceStore's trust
 * decision.  Trust answers "may this project be used?"; this coordinator
 * answers "where may this particular Run write, and who owns that write?".
 */
export type WorkspaceAccessMode = "read_only_shared" | "isolated_worktree" | "exclusive_write";
export type WorkspaceScopeState = "active" | "fenced" | "promoted" | "released";
export type WorkspaceLeaseState = "active" | "fenced" | "released";

export interface WorkspaceExecutionPolicy {
	mode: WorkspaceAccessMode;
	source: "harness_default" | "manager_derived" | "user";
	reason: string;
	baselineStrategy: "git_tree" | "filesystem_manifest" | "external_snapshot";
	promoteOnAcceptance: boolean;
}

export interface WorkspaceExecutionRequest {
	workspacePath: string;
	workspaceId?: string;
	gitRoot?: string;
	mode: WorkspaceAccessMode;
	delegationId: string;
	goalId?: string;
	goalEpoch?: number;
	/** Reuse this id for a WorkItem's continue/follow-up attempts. */
	executionScopeId?: string;
	/** Required when reusing/promoting a write scope. */
	ownerToken?: string;
	/** A Driver that can only observe mutations is not enough for shared read-only. */
	readOnlyEnforcement?: "strong" | "mutation_guard" | "none";
}

export interface WorkspaceLease {
	key: string;
	canonicalRoot: string;
	executionScopeId: string;
	delegationIds: string[];
	goalId?: string;
	goalEpoch?: number;
	ownerToken: string;
	expiresAt: string;
	state: WorkspaceLeaseState;
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceExecutionScope {
	id: string;
	workspaceId?: string;
	/** The canonical target workspace (or its Git root for a subdirectory workspace). */
	canonicalRoot: string;
	/** The exact cwd handed to the Driver. */
	executionCwd: string;
	mode: WorkspaceAccessMode;
	delegationIds: string[];
	goalId?: string;
	goalEpoch?: number;
	baselineFingerprint: string;
	state: WorkspaceScopeState;
	/** Opaque capability for scope reuse/promotion; never derive this from a path. */
	ownerToken?: string;
	lease?: WorkspaceLease;
	createdAt: string;
	updatedAt: string;
}

export interface WorkspaceChangeSet {
	id: string;
	executionScopeId: string;
	delegationIds: string[];
	workspaceId?: string;
	mode: WorkspaceAccessMode;
	baselineFingerprint: string;
	outputFingerprint: string;
	changedPaths: string[];
	diffHash: string;
	promotionState: "not_required" | "pending" | "applied" | "conflict" | "failed";
	createdAt: string;
	promotedAt?: string;
	/** A shared read-only Run that changed files is an integrity violation. */
	integrity: "clean" | "violation";
}

interface SnapshotEntry {
	path: string;
	hash: string;
	mode: number;
}

interface ScopeRecord extends WorkspaceExecutionScope {
	/** Root of the original workspace, when workspacePath is a subdirectory. */
	workspaceRoot: string;
	/** Git worktree root; differs from executionCwd for a repository subdirectory. */
	executionRoot: string;
	baselineSnapshotPath: string;
	baselineEntries: SnapshotEntry[];
	leaseKey?: string;
	ownerToken?: string;
	latestChangeSetId?: string;
}

interface StateFile {
	version: 2;
	scopes: Record<string, ScopeRecord>;
	leases: Record<string, WorkspaceLease>;
	changeSets: Record<string, WorkspaceChangeSet>;
	verificationCopies: Record<string, VerificationEnvironmentCopy>;
}

export interface VerificationEnvironmentCopy {
	id: string;
	verificationId: string;
	executionScopeId: string;
	executionCwd: string;
	root: string;
	inputFingerprint: string;
	kind: "git_worktree" | "filesystem_copy" | "guarded_target";
	baselineEntries?: Array<{ path: string; hash: string; mode: number }>;
	state: "active" | "released";
	createdAt: string;
}

export interface VerificationEnvironmentObservation {
	inputFingerprint: string;
	outputFingerprint: string;
	changedPaths: string[];
}

export interface StandaloneVerificationEnvironment {
	environment: VerificationEnvironmentCopy;
	sourceScopeId: string;
}

export class WorkspaceExecutionError extends Error {
	constructor(readonly code: "invalid_policy" | "workspace_not_found" | "lease_conflict" | "lease_fenced" | "scope_conflict" | "baseline_changed" | "promotion_conflict" | "unsupported_layout" | "scope_not_found", message: string) {
		super(message);
		this.name = "WorkspaceExecutionError";
	}
}

interface CommandResult { code: number; stdout: string; stderr: string }

function command(command: string, args: string[], options: { cwd?: string; input?: string; allowCodes?: number[] } = {}): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => {
			const result = { code: code ?? -1, stdout, stderr };
			if (result.code === 0 || (options.allowCodes ?? []).includes(result.code)) resolve(result);
			else reject(new WorkspaceExecutionError("unsupported_layout", `${command} ${args.join(" ")} failed (${result.code}): ${stderr.trim() || stdout.trim()}`));
		});
		if (options.input !== undefined) child.stdin.end(options.input);
		else child.stdin.end();
	});
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
	return JSON.stringify(value);
}

function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}

function fileDigest(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function now(): string { return new Date().toISOString(); }

function safeRelative(relative: string): string {
	const normalized = relative.split(path.sep).join("/");
	if (!relative || normalized === "." || normalized.startsWith("../") || normalized === ".." || path.isAbsolute(relative) || normalized.includes("\0")) {
		throw new WorkspaceExecutionError("unsupported_layout", `unsafe workspace path: ${relative}`);
	}
	return normalized;
}

function absoluteInside(root: string, relative: string): string {
	const safe = safeRelative(relative);
	const target = path.resolve(root, safe);
	const rel = path.relative(root, target);
	if (rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel)) throw new WorkspaceExecutionError("unsupported_layout", `path escapes workspace: ${relative}`);
	return target;
}

async function canonicalDirectory(input: string): Promise<string> {
	if (!input || !path.isAbsolute(input)) throw new WorkspaceExecutionError("workspace_not_found", "workspacePath must be an absolute path");
	const resolved = await realpathSafe(input);
	const info = await stat(resolved).catch(() => undefined);
	if (!info?.isDirectory()) throw new WorkspaceExecutionError("workspace_not_found", `workspace is not a directory: ${input}`);
	await access(resolved, fsConstants.R_OK | fsConstants.X_OK);
	return resolved;
}

async function realpathSafe(input: string): Promise<string> {
	try { return await import("node:fs/promises").then(({ realpath }) => realpath(input)); }
	catch { throw new WorkspaceExecutionError("workspace_not_found", `workspace is unavailable: ${input}`); }
}

async function isSymlinkOrUnsupported(target: string): Promise<boolean> {
	const info = await lstat(target);
	return info.isSymbolicLink();
}

/** Walk only files selected by the Git index plus non-ignored untracked files. */
async function gitPaths(root: string): Promise<string[]> {
	const tracked = await command("git", ["-C", root, "ls-files", "-z"]);
	const untracked = await command("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "-z"]);
	return [...tracked.stdout, ...untracked.stdout]
		.join("")
		.split("\0")
		.filter(Boolean)
		.map((item) => safeRelative(item))
		.filter((item, index, all) => all.indexOf(item) === index)
		.sort();
}

async function genericPaths(root: string, current = root, result: string[] = []): Promise<string[]> {
	for (const entry of await readdir(current, { withFileTypes: true })) {
		if (entry.name === ".git") continue;
		const absolute = path.join(current, entry.name);
		const relative = safeRelative(path.relative(root, absolute));
		if (entry.isSymbolicLink()) throw new WorkspaceExecutionError("unsupported_layout", `symbolic links are not supported in execution scope: ${relative}`);
		if (entry.isDirectory()) await genericPaths(root, absolute, result);
		else if (entry.isFile()) result.push(relative);
	}
	return result.sort();
}

async function entriesFor(root: string, git = false): Promise<SnapshotEntry[]> {
	const paths = git ? await gitPaths(root) : await genericPaths(root);
	const entries: SnapshotEntry[] = [];
	for (const relative of paths) {
		const absolute = absoluteInside(root, relative);
		const info = await lstat(absolute).catch(() => undefined);
		if (!info) continue; // A tracked file can be deleted; absence is part of the manifest comparison.
		if (!info.isFile() || info.isSymbolicLink()) throw new WorkspaceExecutionError("unsupported_layout", `only regular files are supported: ${relative}`);
		const content = await readFile(absolute);
		entries.push({ path: relative, hash: fileDigest(content), mode: info.mode & 0o777 });
	}
	return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function fingerprint(root: string, entries: SnapshotEntry[], gitHead?: string): string {
	return digest({ root, gitHead, entries });
}

function entriesMap(entries: SnapshotEntry[]): Map<string, SnapshotEntry> {
	return new Map(entries.map((entry) => [entry.path, entry]));
}

function changedPaths(before: SnapshotEntry[], after: SnapshotEntry[]): string[] {
	const left = entriesMap(before);
	const right = entriesMap(after);
	return [...new Set([...left.keys(), ...right.keys()])].filter((name) => {
		const a = left.get(name);
		const b = right.get(name);
		return !a || !b || a.hash !== b.hash || a.mode !== b.mode;
	}).sort();
}

async function gitHead(root: string): Promise<string> {
	return (await command("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
}

async function resolveGitRoot(workspacePath: string, supplied?: string): Promise<{ root: string; workspaceRelative: string }> {
	const root = supplied ? await canonicalDirectory(supplied) : (await command("git", ["-C", workspacePath, "rev-parse", "--show-toplevel"])).stdout.trim();
	const canonicalRoot = supplied ? root : await canonicalDirectory(root);
	const relative = path.relative(canonicalRoot, workspacePath);
	if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new WorkspaceExecutionError("unsupported_layout", "workspacePath is outside gitRoot");
	const inside = relative ? safeRelative(relative) : "";
	const submodules = (await command("git", ["-C", canonicalRoot, "ls-files", "-s"])).stdout.split("\n").some((line) => line.startsWith("160000 "));
	if (submodules) throw new WorkspaceExecutionError("unsupported_layout", "submodules cannot be materialized safely");
	return { root: canonicalRoot, workspaceRelative: inside };
}

async function assertNoNestedGit(root: string, current = root): Promise<void> {
	for (const entry of await readdir(current, { withFileTypes: true })) {
		if (entry.name === ".git") continue;
		const absolute = path.join(current, entry.name);
		if (entry.isSymbolicLink()) throw new WorkspaceExecutionError("unsupported_layout", `symbolic links are not supported: ${path.relative(root, absolute)}`);
		if (entry.isDirectory()) {
			const marker = await lstat(path.join(absolute, ".git")).catch(() => undefined);
			if (marker) throw new WorkspaceExecutionError("unsupported_layout", `nested repositories cannot be materialized: ${path.relative(root, absolute)}`);
			await assertNoNestedGit(root, absolute);
		}
	}
}

async function snapshot(root: string, destination: string, entries: SnapshotEntry[]): Promise<void> {
	await mkdir(destination, { recursive: true });
	for (const entry of entries) {
		const source = absoluteInside(root, entry.path);
		const target = absoluteInside(destination, entry.path);
		const info = await lstat(source).catch(() => undefined);
		if (!info) continue;
		if (!info.isFile() || info.isSymbolicLink()) throw new WorkspaceExecutionError("unsupported_layout", `cannot snapshot non-regular file: ${entry.path}`);
		await mkdir(path.dirname(target), { recursive: true });
		await copyFile(source, target);
		await chmod(target, entry.mode);
	}
}

async function applyTrackedDirtyState(sourceRoot: string, executionRoot: string): Promise<void> {
	const diff = (await command("git", ["-C", sourceRoot, "diff", "--binary", "HEAD", "--"])).stdout;
	if (diff.trim()) await command("git", ["-C", executionRoot, "apply", "--binary", "--whitespace=nowarn", "-"], { input: diff });
	for (const relative of (await command("git", ["-C", sourceRoot, "ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean).map(safeRelative)) {
		const source = absoluteInside(sourceRoot, relative);
		const target = absoluteInside(executionRoot, relative);
		const info = await lstat(source);
		if (!info.isFile() || info.isSymbolicLink()) throw new WorkspaceExecutionError("unsupported_layout", `untracked non-regular file cannot be materialized: ${relative}`);
		await mkdir(path.dirname(target), { recursive: true });
		await copyFile(source, target);
		await chmod(target, info.mode & 0o777);
	}
}

async function entryAt(root: string, relative: string): Promise<SnapshotEntry | undefined> {
	const absolute = absoluteInside(root, relative);
	const info = await lstat(absolute).catch(() => undefined);
	if (!info) return undefined;
	if (!info.isFile() || info.isSymbolicLink()) throw new WorkspaceExecutionError("promotion_conflict", `target path has incompatible type: ${relative}`);
	return { path: relative, hash: fileDigest(await readFile(absolute)), mode: info.mode & 0o777 };
}

function sameEntry(actual: SnapshotEntry | undefined, expected: SnapshotEntry | undefined): boolean {
	return actual === undefined ? expected === undefined : expected !== undefined && actual.hash === expected.hash && actual.mode === expected.mode;
}

interface PromotionStep {
	relative: string;
	target: string;
	backup?: string;
	finalEntry?: SnapshotEntry;
}

async function installExact(
	sourceRoot: string,
	targetRoot: string,
	relative: string,
	baselineEntry: SnapshotEntry | undefined,
	finalEntry: SnapshotEntry | undefined,
	promotionId: string,
): Promise<PromotionStep> {
	const target = absoluteInside(targetRoot, relative);
	await mkdir(path.dirname(target), { recursive: true });
	if (!sameEntry(await entryAt(targetRoot, relative), baselineEntry)) throw new WorkspaceExecutionError("promotion_conflict", `target changed before promotion: ${relative}`);
	const step: PromotionStep = { relative, target, ...(finalEntry ? { finalEntry } : {}) };
	if (baselineEntry) {
		const backup = `${target}.puddingteams-${promotionId}.bak`;
		await rename(target, backup);
		step.backup = backup;
		const backupInfo = await lstat(backup);
		const moved = { path: relative, hash: fileDigest(await readFile(backup)), mode: backupInfo.mode & 0o777 };
		if (!sameEntry(moved, baselineEntry)) {
			await rename(backup, target).catch(() => undefined);
			throw new WorkspaceExecutionError("promotion_conflict", `target changed during promotion: ${relative}`);
		}
	}
	if (!finalEntry) return step;
	const source = absoluteInside(sourceRoot, relative);
	const sourceInfo = await lstat(source);
	if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new WorkspaceExecutionError("unsupported_layout", `cannot promote non-regular path: ${relative}`);
	const temporary = `${target}.${promotionId}.tmp`;
	try {
		await copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
		await chmod(temporary, finalEntry.mode);
		const staged = await entryAt(path.dirname(temporary), path.basename(temporary));
		if (!sameEntry(staged ? { ...staged, path: relative } : undefined, finalEntry)) throw new WorkspaceExecutionError("promotion_conflict", `execution output changed during promotion: ${relative}`);
		await copyFile(temporary, target, fsConstants.COPYFILE_EXCL);
		await chmod(target, finalEntry.mode);
	} catch (error) {
		if (step.backup && !await lstat(target).catch(() => undefined)) await rename(step.backup, target).catch(() => undefined);
		if (error instanceof WorkspaceExecutionError) throw error;
		throw new WorkspaceExecutionError("promotion_conflict", `target changed during promotion: ${relative}`);
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
	return step;
}

async function rollbackPromotion(targetRoot: string, steps: PromotionStep[]): Promise<void> {
	for (const step of [...steps].reverse()) {
		const current = await entryAt(targetRoot, step.relative).catch(() => undefined);
		if (sameEntry(current, step.finalEntry)) {
			if (current) await rm(step.target, { force: true }).catch(() => undefined);
			if (step.backup) await rename(step.backup, step.target).catch(() => undefined);
		}
	}
}

export class WorkspaceExecutionCoordinator {
	private readonly file: string;
	private readonly worktreeRoot: string;
	private leaseTimeoutMs: number;
	private readonly clock: () => number;
	private readonly promotionCheckpoint?: (scope: WorkspaceExecutionScope) => Promise<void>;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly stateDir: string, options: { worktreeRoot?: string; leaseTimeoutMs?: number; now?: () => number; promotionCheckpoint?: (scope: WorkspaceExecutionScope) => Promise<void> } = {}) {
		this.file = path.join(stateDir, "workspace-execution.json");
		this.worktreeRoot = options.worktreeRoot ?? path.join(stateDir, "worktrees");
		this.leaseTimeoutMs = Math.max(5_000, Math.min(options.leaseTimeoutMs ?? 600_000, 86_400_000));
		this.clock = options.now ?? (() => Date.now());
		this.promotionCheckpoint = options.promotionCheckpoint;
	}

	async init(): Promise<void> {
		await mkdir(this.stateDir, { recursive: true });
		await mkdir(this.worktreeRoot, { recursive: true });
	}

	configure(options: { leaseTimeoutMs: number }): void {
		this.leaseTimeoutMs = Math.max(5_000, Math.min(options.leaseTimeoutMs, 86_400_000));
	}

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	private async load(): Promise<StateFile> {
		try {
			const value = JSON.parse(await readFile(this.file, "utf8")) as Partial<StateFile>;
			if (value.version !== 2) throw new Error(`workspace-execution.json 必须使用 v2：${this.file}`);
			return { version: 2, scopes: value.scopes ?? {}, leases: value.leases ?? {}, changeSets: value.changeSets ?? {}, verificationCopies: value.verificationCopies ?? {} };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return { version: 2, scopes: {}, leases: {}, changeSets: {}, verificationCopies: {} };
		}
	}

	private async write(state: StateFile): Promise<void> {
		const temporary = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
		await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
		await rename(temporary, this.file);
	}

	private leaseKey(workspaceId: string | undefined, canonicalRoot: string): string {
		return workspaceId ? `workspace:${workspaceId}` : `path:${canonicalRoot}`;
	}

	private async currentEntries(scope: ScopeRecord): Promise<{ entries: SnapshotEntry[]; fingerprint: string }> {
		const git = scope.mode === "isolated_worktree";
		const root = git ? scope.executionRoot : scope.executionCwd;
		const entries = await entriesFor(root, git);
		const head = git ? await gitHead(root) : undefined;
		return { entries, fingerprint: fingerprint(scope.canonicalRoot, entries, head) };
	}

	async begin(input: WorkspaceExecutionRequest): Promise<WorkspaceExecutionScope> {
		if (!input.delegationId?.trim()) throw new WorkspaceExecutionError("invalid_policy", "delegationId is required");
		if (input.mode === "read_only_shared" && input.readOnlyEnforcement !== "strong") throw new WorkspaceExecutionError("invalid_policy", "read_only_shared requires a Driver-enforced read-only boundary");
		return this.serialize(async () => {
			const state = await this.load();
			const workspacePath = await canonicalDirectory(input.workspacePath);
			let canonicalRoot = workspacePath;
			let workspaceRelative = "";
			let git = false;
			if (input.mode === "isolated_worktree") {
				const resolved = await resolveGitRoot(workspacePath, input.gitRoot);
				canonicalRoot = resolved.root;
				workspaceRelative = resolved.workspaceRelative;
				git = true;
				await assertNoNestedGit(canonicalRoot);
			}
			const key = this.leaseKey(input.workspaceId, canonicalRoot);
			const configRoot = path.resolve(this.stateDir);
			const rootRelation = path.relative(canonicalRoot, configRoot);
			if (!rootRelation.startsWith(`..${path.sep}`) && rootRelation !== ".." && !path.isAbsolute(rootRelation)) {
				throw new WorkspaceExecutionError("unsupported_layout", "execution state must not be stored inside the target workspace");
			}
			const worktreeRelation = path.relative(canonicalRoot, path.resolve(this.worktreeRoot));
			if (!worktreeRelation.startsWith(`..${path.sep}`) && worktreeRelation !== ".." && !path.isAbsolute(worktreeRelation)) {
				throw new WorkspaceExecutionError("unsupported_layout", "worktree root must not be inside the target workspace");
			}
			if (input.executionScopeId) {
				const existing = state.scopes[input.executionScopeId];
				if (!existing || existing.state === "released") throw new WorkspaceExecutionError("scope_not_found", `execution scope not found: ${input.executionScopeId}`);
				if (existing.mode !== input.mode || existing.canonicalRoot !== canonicalRoot) throw new WorkspaceExecutionError("scope_conflict", "execution scope binding is immutable");
				if (existing.ownerToken && input.ownerToken !== existing.ownerToken) throw new WorkspaceExecutionError("lease_conflict", "execution scope owner token mismatch");
				if (input.mode === "exclusive_write" && existing.lease && existing.lease.state !== "active") throw new WorkspaceExecutionError("lease_fenced", "execution scope lease is fenced or released");
				if (input.mode === "exclusive_write" && existing.lease && new Date(existing.lease.expiresAt).getTime() <= this.clock()) throw new WorkspaceExecutionError("lease_fenced", "expired lease must be reconciled before scope reuse");
				if (!existing.delegationIds.includes(input.delegationId)) existing.delegationIds.push(input.delegationId);
				existing.updatedAt = now();
				if (existing.lease) {
					existing.lease.delegationIds = [...existing.delegationIds];
						existing.lease.expiresAt = new Date(this.clock() + this.leaseTimeoutMs).toISOString();
					existing.lease.updatedAt = existing.updatedAt;
						if (existing.leaseKey) state.leases[existing.leaseKey] = existing.lease;
				}
				await this.write(state);
				return structuredClone(existing);
			}
			if (input.mode === "exclusive_write") {
				const occupied = Object.values(state.leases).find((lease) => lease.state !== "released" && (lease.key === key || lease.canonicalRoot === canonicalRoot));
				if (occupied) {
					if (occupied.state === "fenced") throw new WorkspaceExecutionError("lease_fenced", `workspace lease is fenced: ${canonicalRoot}`);
					if (new Date(occupied.expiresAt).getTime() <= this.clock()) {
						occupied.state = "fenced";
						occupied.updatedAt = now();
						await this.write(state);
						throw new WorkspaceExecutionError("lease_fenced", "expired lease was fenced; reconcile or manually take over before writing");
					}
					throw new WorkspaceExecutionError("lease_conflict", `workspace is exclusively leased: ${canonicalRoot}`);
				}
			}
			const baselineEntries = await entriesFor(canonicalRoot, git);
			const baselineFingerprint = fingerprint(canonicalRoot, baselineEntries, git ? await gitHead(canonicalRoot) : undefined);
			const id = randomUUID();
			const baselineSnapshotPath = path.join(this.stateDir, "baselines", id);
			await snapshot(canonicalRoot, baselineSnapshotPath, baselineEntries);
			let executionCwd = canonicalRoot;
			if (input.mode === "isolated_worktree") {
				executionCwd = path.join(this.worktreeRoot, id);
				await command("git", ["-C", canonicalRoot, "worktree", "add", "--detach", executionCwd, "HEAD"]);
				try {
					await applyTrackedDirtyState(canonicalRoot, executionCwd);
					// Worktree cwd may be a subdirectory of the repository.
					executionCwd = workspaceRelative ? absoluteInside(executionCwd, workspaceRelative) : executionCwd;
				} catch (error) {
					await command("git", ["-C", canonicalRoot, "worktree", "remove", "--force", path.join(this.worktreeRoot, id)], { allowCodes: [1] }).catch(() => undefined);
					throw error;
				}
			}
			const timestamp = now();
			const scope: ScopeRecord = {
				id,
				...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
				canonicalRoot,
				workspaceRoot: workspacePath,
				executionRoot: input.mode === "isolated_worktree" ? path.join(this.worktreeRoot, id) : canonicalRoot,
				executionCwd,
				mode: input.mode,
				delegationIds: [input.delegationId],
				...(input.goalId ? { goalId: input.goalId } : {}),
				...(input.goalEpoch === undefined ? {} : { goalEpoch: input.goalEpoch }),
				baselineFingerprint,
				state: "active",
				createdAt: timestamp,
				updatedAt: timestamp,
					baselineSnapshotPath,
				baselineEntries,
			};
			if (input.mode !== "read_only_shared") scope.ownerToken = randomUUID();
			if (input.mode === "exclusive_write") {
				const ownerToken = scope.ownerToken!;
				const lease: WorkspaceLease = {
					key,
					canonicalRoot,
					executionScopeId: id,
					delegationIds: [input.delegationId],
					...(input.goalId ? { goalId: input.goalId } : {}),
					...(input.goalEpoch === undefined ? {} : { goalEpoch: input.goalEpoch }),
					ownerToken,
					expiresAt: new Date(this.clock() + this.leaseTimeoutMs).toISOString(),
					state: "active",
					createdAt: timestamp,
					updatedAt: timestamp,
				};
				scope.lease = lease;
				scope.leaseKey = key;
				scope.ownerToken = ownerToken;
				state.leases[key] = lease;
			}
			state.scopes[id] = scope;
			await this.write(state);
			return structuredClone(scope);
		});
	}

	async get(scopeId: string): Promise<WorkspaceExecutionScope | undefined> {
		const state = await this.load();
		const scope = state.scopes[scopeId];
		return scope ? structuredClone(scope) : undefined;
	}

	async getChangeSet(changeSetId: string): Promise<WorkspaceChangeSet | undefined> {
		const changeSet = (await this.load()).changeSets[changeSetId];
		return changeSet ? structuredClone(changeSet) : undefined;
	}

	async createVerificationCopy(scopeId: string, verificationId: string, ownerToken?: string): Promise<VerificationEnvironmentCopy> {
		return this.serialize(async () => {
			const state = await this.load();
			const scope = state.scopes[scopeId];
			if (!scope || scope.state === "released") throw new WorkspaceExecutionError("scope_not_found", `execution scope not found: ${scopeId}`);
			if (scope.ownerToken && ownerToken !== scope.ownerToken) throw new WorkspaceExecutionError("lease_conflict", "execution scope owner token mismatch");
			const id = `verify-${createHash("sha256").update(verificationId).digest("hex").slice(0, 20)}`;
			const existing = state.verificationCopies[id];
			if (existing?.state === "active") return structuredClone(existing);
			const root = path.join(this.worktreeRoot, id);
			await rm(root, { recursive: true, force: true });
			const current = await this.currentEntries(scope);
			let executionCwd = root;
			let kind: VerificationEnvironmentCopy["kind"] = "filesystem_copy";
			if (scope.mode === "isolated_worktree") {
				kind = "git_worktree";
				await command("git", ["-C", scope.canonicalRoot, "worktree", "add", "--detach", root, "HEAD"]);
				try {
					await applyTrackedDirtyState(scope.executionRoot, root);
					const relative = path.relative(scope.executionRoot, scope.executionCwd);
					executionCwd = relative ? absoluteInside(root, relative) : root;
				} catch (error) {
					await command("git", ["-C", scope.canonicalRoot, "worktree", "remove", "--force", root], { allowCodes: [1] }).catch(() => undefined);
					throw error;
				}
			} else {
				await snapshot(scope.executionCwd, root, await entriesFor(scope.executionCwd, false));
			}
			const record: VerificationEnvironmentCopy = { id, verificationId, executionScopeId: scopeId, executionCwd, root, inputFingerprint: current.fingerprint, kind, state: "active", createdAt: now() };
			state.verificationCopies[id] = record;
			await this.write(state);
			return structuredClone(record);
		});
	}

	/**
	 * Goal-level verification observes the current integrated workspace rather than
	 * a particular WorkItem scope. Build a control-plane source scope first, then
	 * copy it. Git uses a dirty-state-preserving worktree; non-Git uses an exclusive
	 * snapshot lease so the copy has one attributable baseline.
	 */
	async createStandaloneVerificationCopy(input: {
		workspacePath: string;
		workspaceId?: string;
		verificationId: string;
		goalId: string;
		goalEpoch: number;
	}): Promise<StandaloneVerificationEnvironment> {
		const canonical = await canonicalDirectory(input.workspacePath);
		const gitRepository = await command("git", ["-C", canonical, "rev-parse", "--show-toplevel"]).then(() => true, () => false);
		const scope = await this.begin({
			workspacePath: canonical,
			workspaceId: input.workspaceId,
			mode: gitRepository ? "isolated_worktree" : "exclusive_write",
			delegationId: `verification-source:${input.verificationId}`,
			goalId: input.goalId,
			goalEpoch: input.goalEpoch,
			readOnlyEnforcement: "none",
		});
		try {
			const environment = await this.createVerificationCopy(scope.id, input.verificationId, scope.ownerToken);
			return { environment, sourceScopeId: scope.id };
		} catch (error) {
			await this.release(scope.id, { ownerToken: scope.ownerToken }).catch(() => undefined);
			throw error;
		}
	}

	async createGuardedVerificationTarget(scopeId: string, verificationId: string, ownerToken?: string): Promise<VerificationEnvironmentCopy> {
		return this.serialize(async () => {
			const state = await this.load();
			const scope = state.scopes[scopeId];
			if (!scope || scope.state === "released") throw new WorkspaceExecutionError("scope_not_found", `execution scope not found: ${scopeId}`);
			if (scope.ownerToken && ownerToken !== scope.ownerToken) throw new WorkspaceExecutionError("lease_conflict", "execution scope owner token mismatch");
			const id = `verify-${createHash("sha256").update(verificationId).digest("hex").slice(0, 20)}`;
			const existing = state.verificationCopies[id];
			if (existing?.state === "active") return structuredClone(existing);
			const current = await this.currentEntries(scope);
			const record: VerificationEnvironmentCopy = {
				id, verificationId, executionScopeId: scopeId, executionCwd: scope.executionCwd, root: scope.executionRoot,
				inputFingerprint: current.fingerprint, kind: "guarded_target", baselineEntries: current.entries,
				state: "active", createdAt: now(),
			};
			state.verificationCopies[id] = record;
			await this.write(state);
			return structuredClone(record);
		});
	}

	async resolveVerificationTarget(copyId: string, verificationId: string): Promise<VerificationEnvironmentCopy> {
		const copy = (await this.load()).verificationCopies[copyId];
		if (!copy || copy.state !== "active") throw new WorkspaceExecutionError("scope_not_found", `verification environment not found: ${copyId}`);
		if (copy.verificationId !== verificationId) throw new WorkspaceExecutionError("scope_conflict", "verification environment is bound to another VerificationRecord");
		return structuredClone(copy);
	}

	async releaseVerificationCopy(copyId: string): Promise<void> {
		await this.serialize(async () => {
			const state = await this.load();
			const copy = state.verificationCopies[copyId];
			if (!copy || copy.state === "released") return;
			const scope = state.scopes[copy.executionScopeId];
			if (copy.kind === "git_worktree" && scope) await command("git", ["-C", scope.canonicalRoot, "worktree", "remove", "--force", copy.root], { allowCodes: [1] }).catch(() => undefined);
			else if (copy.kind === "filesystem_copy") await rm(copy.root, { recursive: true, force: true });
			copy.state = "released";
			await this.write(state);
		});
	}

	async observeVerificationCopy(copyId: string): Promise<VerificationEnvironmentObservation> {
		const state = await this.load();
		const copy = state.verificationCopies[copyId];
		if (!copy || copy.state !== "active") throw new WorkspaceExecutionError("scope_not_found", `verification copy not found: ${copyId}`);
		const scope = state.scopes[copy.executionScopeId];
		if (!scope) throw new WorkspaceExecutionError("scope_not_found", `execution scope not found: ${copy.executionScopeId}`);
		const before = copy.kind === "guarded_target"
			? copy.baselineEntries ?? []
			: scope.mode === "isolated_worktree" ? await entriesFor(scope.executionRoot, true) : await entriesFor(scope.executionCwd, false);
		const after = copy.kind === "git_worktree"
			? await entriesFor(copy.root, true)
			: copy.kind === "guarded_target" && scope.mode === "isolated_worktree"
				? await entriesFor(scope.executionRoot, true)
				: await entriesFor(copy.executionCwd, false);
		const verificationHead = copy.kind === "git_worktree"
			? await gitHead(copy.root)
			: copy.kind === "guarded_target" && scope.mode === "isolated_worktree" ? await gitHead(scope.executionRoot) : undefined;
		const outputFingerprint = fingerprint(scope.canonicalRoot, after, verificationHead);
		return { inputFingerprint: copy.inputFingerprint, outputFingerprint, changedPaths: changedPaths(before, after) };
	}

	async capture(scopeId: string, ownerToken?: string): Promise<WorkspaceChangeSet> {
		return this.serialize(async () => {
			const state = await this.load();
			const scope = state.scopes[scopeId];
			if (!scope || scope.state === "released") throw new WorkspaceExecutionError("scope_not_found", `execution scope not found: ${scopeId}`);
			if (scope.ownerToken && ownerToken !== scope.ownerToken) throw new WorkspaceExecutionError("lease_conflict", "execution scope owner token mismatch");
			const current = await this.currentEntries(scope);
			const paths = changedPaths(scope.baselineEntries, current.entries);
			const changeSet: WorkspaceChangeSet = {
				id: randomUUID(), executionScopeId: scope.id, delegationIds: [...scope.delegationIds],
				...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}), mode: scope.mode,
				baselineFingerprint: scope.baselineFingerprint, outputFingerprint: current.fingerprint,
				changedPaths: paths,
				diffHash: digest({ baseline: scope.baselineEntries, output: current.entries, changedPaths: paths }),
				promotionState: scope.mode === "isolated_worktree" ? "pending" : "not_required",
				createdAt: now(), integrity: scope.mode === "read_only_shared" && paths.length ? "violation" : "clean",
			};
			state.changeSets[changeSet.id] = changeSet;
			scope.latestChangeSetId = changeSet.id;
			scope.updatedAt = now();
			await this.write(state);
			return structuredClone(changeSet);
		});
	}

	async promote(scopeId: string, changeSetId?: string, ownerToken?: string): Promise<WorkspaceChangeSet> {
		return this.serialize(async () => {
			const state = await this.load();
			const scope = state.scopes[scopeId];
			if (!scope || scope.state === "released") throw new WorkspaceExecutionError("scope_not_found", `execution scope not found: ${scopeId}`);
			if (scope.ownerToken && ownerToken !== scope.ownerToken) throw new WorkspaceExecutionError("lease_conflict", "execution scope owner token mismatch");
			if (scope.mode !== "isolated_worktree") throw new WorkspaceExecutionError("invalid_policy", "only isolated_worktree scopes can be promoted");
			const promotionLockDir = path.join(this.stateDir, "promotion-locks");
			await mkdir(promotionLockDir, { recursive: true });
			const promotionLockPath = path.join(promotionLockDir, `${createHash("sha256").update(scope.canonicalRoot).digest("hex")}.lock`);
			const promotionLock = await open(promotionLockPath, "wx").catch(() => undefined);
			if (!promotionLock) throw new WorkspaceExecutionError("promotion_conflict", "another promotion owns the target workspace");
			try {
			const changeSet = state.changeSets[changeSetId ?? scope.latestChangeSetId ?? ""];
			if (!changeSet || changeSet.executionScopeId !== scopeId) throw new WorkspaceExecutionError("scope_not_found", "change-set not found for execution scope");
			if (changeSet.promotionState === "applied") return structuredClone(changeSet);
			if (scope.state === "fenced") throw new WorkspaceExecutionError("promotion_conflict", "execution scope is fenced");
			const currentExecution = await this.currentEntries(scope);
			if (currentExecution.fingerprint !== changeSet.outputFingerprint) {
				changeSet.promotionState = "failed";
				scope.state = "fenced";
				scope.updatedAt = now();
				await this.write(state);
				return structuredClone(changeSet);
			}
			const targetEntries = await entriesFor(scope.canonicalRoot, true);
			const targetFingerprint = fingerprint(scope.canonicalRoot, targetEntries, await gitHead(scope.canonicalRoot));
			if (targetFingerprint !== scope.baselineFingerprint) {
				changeSet.promotionState = "conflict";
				scope.state = "fenced";
				scope.updatedAt = now();
				await this.write(state);
				return structuredClone(changeSet);
			}
			const finalEntries = await entriesFor(scope.executionRoot, true);
			const finalMap = entriesMap(finalEntries);
			const baselineMap = entriesMap(scope.baselineEntries);
			await this.promotionCheckpoint?.(structuredClone(scope));
			for (const relative of changeSet.changedPaths) {
				if (!baselineMap.has(relative) && finalMap.has(relative) && await lstat(absoluteInside(scope.canonicalRoot, relative)).then(() => true, () => false)) {
					changeSet.promotionState = "conflict";
					scope.state = "fenced";
					scope.updatedAt = now();
					await this.write(state);
					return structuredClone(changeSet);
				}
			}
			const promotionId = randomUUID().replaceAll("-", "");
			const applied: PromotionStep[] = [];
			try {
				for (const relative of changeSet.changedPaths) {
					applied.push(await installExact(scope.executionRoot, scope.canonicalRoot, relative, baselineMap.get(relative), finalMap.get(relative), promotionId));
				}
				const transientBackups = new Set(applied.flatMap((step) => step.backup ? [safeRelative(path.relative(scope.canonicalRoot, step.backup))] : []));
				const after = (await entriesFor(scope.canonicalRoot, true)).filter((entry) => !transientBackups.has(entry.path));
				const afterFingerprint = fingerprint(scope.canonicalRoot, after, await gitHead(scope.canonicalRoot));
				if (afterFingerprint !== changeSet.outputFingerprint) throw new WorkspaceExecutionError("promotion_conflict", "promoted workspace fingerprint differs from change-set output");
				for (const step of applied) if (step.backup) await rm(step.backup, { force: true });
				changeSet.promotionState = "applied";
				changeSet.promotedAt = now();
				scope.state = "promoted";
				scope.updatedAt = now();
				await this.write(state);
				return structuredClone(changeSet);
			} catch (error) {
				await rollbackPromotion(scope.canonicalRoot, applied);
				changeSet.promotionState = error instanceof WorkspaceExecutionError && error.code === "promotion_conflict" ? "conflict" : "failed";
				scope.state = "fenced";
				scope.updatedAt = now();
				await this.write(state);
				if (error instanceof WorkspaceExecutionError && error.code === "promotion_conflict") return structuredClone(changeSet);
				throw error;
			}
			} finally {
				await promotionLock.close().catch(() => undefined);
				await rm(promotionLockPath, { force: true }).catch(() => undefined);
			}
		});
	}

	async renewLease(scopeId: string, ownerToken: string): Promise<WorkspaceLease> {
		return this.serialize(async () => {
			const state = await this.load();
			const scope = state.scopes[scopeId];
			const lease = scope?.lease;
			if (!scope || !lease) throw new WorkspaceExecutionError("scope_not_found", `exclusive lease not found: ${scopeId}`);
			if (lease.ownerToken !== ownerToken) throw new WorkspaceExecutionError("lease_conflict", "lease owner token mismatch");
			if (lease.state !== "active" || new Date(lease.expiresAt).getTime() <= this.clock()) throw new WorkspaceExecutionError("lease_fenced", "expired or fenced lease cannot be renewed");
			lease.expiresAt = new Date(this.clock() + this.leaseTimeoutMs).toISOString();
			lease.updatedAt = now();
			if (scope.leaseKey) state.leases[scope.leaseKey] = lease;
			await this.write(state);
			return structuredClone(lease);
		});
	}

	async fence(scopeId: string, ownerToken?: string): Promise<WorkspaceExecutionScope> {
		return this.serialize(async () => {
			const state = await this.load();
			const scope = state.scopes[scopeId];
			if (!scope) throw new WorkspaceExecutionError("scope_not_found", `execution scope not found: ${scopeId}`);
			if (scope.lease && ownerToken && scope.lease.ownerToken !== ownerToken) throw new WorkspaceExecutionError("lease_conflict", "lease owner token mismatch");
			scope.state = "fenced";
			if (scope.lease) {
				scope.lease.state = "fenced";
				scope.lease.updatedAt = now();
				if (scope.leaseKey) state.leases[scope.leaseKey] = scope.lease;
			}
			scope.updatedAt = now();
			await this.write(state);
			return structuredClone(scope);
		});
	}

	async release(scopeId: string, options: { ownerToken?: string; allowFenced?: boolean; cleanup?: boolean } = {}): Promise<WorkspaceExecutionScope> {
		return this.serialize(async () => {
			const state = await this.load();
			const scope = state.scopes[scopeId];
			if (!scope) throw new WorkspaceExecutionError("scope_not_found", `execution scope not found: ${scopeId}`);
			if (scope.state === "fenced" && !options.allowFenced) throw new WorkspaceExecutionError("lease_fenced", "fenced scope requires explicit manual release");
			if (scope.ownerToken && options.ownerToken !== scope.ownerToken) throw new WorkspaceExecutionError("lease_conflict", "execution scope owner token mismatch");
			if (scope.lease && options.ownerToken !== scope.lease.ownerToken) throw new WorkspaceExecutionError("lease_conflict", "lease owner token mismatch");
			if (scope.lease) {
				scope.lease.state = "released";
				scope.lease.updatedAt = now();
				if (scope.leaseKey) state.leases[scope.leaseKey] = scope.lease;
			}
			scope.state = "released";
			scope.updatedAt = now();
			if (options.cleanup !== false && scope.mode === "isolated_worktree") {
				await command("git", ["-C", scope.canonicalRoot, "worktree", "remove", "--force", path.join(this.worktreeRoot, scope.id)], { allowCodes: [1] }).catch(() => undefined);
			}
			await this.write(state);
			return structuredClone(scope);
		});
	}
}
