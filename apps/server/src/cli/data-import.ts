import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolvePuddingTeamsPaths, type PuddingTeamsPaths } from "../paths.js";
import { AVATAR_MAX_BYTES, DEFAULT_TEAMS, MANAGER_AGENT_NAME, type AgentConfig } from "../store/teams.js";
import { WORKSPACE_TRUST_POLICY_VERSION, type WorkspaceRecord } from "../store/workspaces.js";
import { parseExtensionManifest } from "../agent-runtime/extensions.js";

/**
 * `puddingteams data import-legacy`（迁移方案 §9）：把旧开发数据
 * （`<repo>/apps/server/.teams` + `.sessions` + 旧 secrets 备份）一次性
 * 导入 PUDDINGTEAMS_HOME 新目录树。
 *
 * 流程严格按 §9.4：
 *   1. 全部迁移产物先在内存中构建为候选计划（dry-run 零写入）；
 *   2. --execute 时在 `migrations/staging-<id>/` 物化完整候选树并校验
 *      （JSON 可解析、secret 可解密、artifact digest、路径边界）；
 *   3. 目标不存在才发布；同名不同内容记冲突、不覆盖现有用户事实；
 *   4. 同卷 rename 原子发布（staging 与目标同在 home 下，必同卷）；
 *   5. 写 `migrations/user-home-v1.json` 报告；旧目录不删除。
 *
 * §9.3：无项目且 cwd 指向源码仓的旧 Session 不恢复，归档到
 * `migrations/legacy-unscoped-sessions/`，对应窗口换发全新的 unscoped
 * Session（stub JSONL，仅 header）。
 */

// ---- 数据结构 ----

interface PlanItem {
	/** 相对 home 的目标路径（发布前先做边界校验）。 */
	targetRel: string;
	kind: "write" | "copy";
	/** kind=write 的候选内容。 */
	content?: Buffer;
	/** kind=copy 的源文件。 */
	source?: string;
	/** 文件权限（secrets 0600）。 */
	mode?: number;
	/** 人类可读的来源说明（dry-run 映射输出用）。 */
	origin: string;
}

interface Note {
	item: string;
	reason: string;
}

export interface ImportReport {
	version: 1;
	from: string;
	home: string;
	secretsFrom?: string;
	dryRun: boolean;
	startedAt: string;
	finishedAt?: string;
	/** 分类计数（sessions.migrated / windows.restubbed / …）。 */
	counts: Record<string, number>;
	/** 同名不同内容的目标，未覆盖。 */
	conflicts: Note[];
	/** 归档到 migrations/legacy-unscoped-sessions/ 的旧 Session。 */
	archived: Note[];
	/** 被丢弃/跳过的记录与文件。 */
	dropped: Note[];
	/** execute 实际发布的相对路径。 */
	published: string[];
}

export interface ImportOptions {
	from: string;
	home?: string;
	secretsFrom?: string;
	execute: boolean;
}

const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const PAYLOAD_PREFIX = "v1.";

function bump(counts: Record<string, number>, key: string, by = 1): void {
	counts[key] = (counts[key] ?? 0) + by;
}

function sha256Hex(buf: Buffer): string {
	return createHash("sha256").update(buf).digest("hex");
}

/** 目标路径边界：必须解析到 home 内部（§9.4 路径边界校验）。 */
function assertInsideHome(home: string, targetRel: string): string {
	if (path.isAbsolute(targetRel)) throw new Error(`目标必须是相对路径：${targetRel}`);
	const resolved = path.resolve(home, targetRel);
	if (resolved !== home && !resolved.startsWith(home + path.sep)) {
		throw new Error(`目标越出 home：${targetRel}`);
	}
	return resolved;
}

/** realpath 解析到最近一个存在的祖先，再把不存在的尾段拼回（目录可能还没创建）。 */
async function canonicalizePending(p: string): Promise<string> {
	const resolved = path.resolve(p);
	let current = resolved;
	const tail: string[] = [];
	while (true) {
		const rp = await realpath(current).catch(() => undefined);
		if (rp) return tail.length ? path.join(rp, ...tail.reverse()) : rp;
		const parent = path.dirname(current);
		if (parent === current) return resolved;
		tail.push(path.basename(current));
		current = parent;
	}
}

/** AES-256-GCM v1. payload 解密（与 CredentialsStore/InteractionSecretStore 同格式）。 */
function decryptV1(key: Buffer, payload: string): string {
	if (!payload.startsWith(PAYLOAD_PREFIX)) throw new Error("unsupported payload format");
	const [ivB64, tagB64, ctB64] = payload.slice(PAYLOAD_PREFIX.length).split(".");
	if (!ivB64 || !tagB64 || !ctB64) throw new Error("malformed payload");
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
	decipher.setAuthTag(Buffer.from(tagB64, "base64"));
	return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf-8");
}

async function readJsonFile(file: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf-8")) as unknown;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`JSON 解析失败：${file}（${err instanceof Error ? err.message : String(err)}）`);
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// ---- 头像 magic bytes（与 TeamsStore 同一白名单） ----

type AvatarSniff = (b: Buffer) => boolean;
const AVATAR_SNIFFS: Record<string, AvatarSniff> = {
	png: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
	jpg: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
	gif: (b) => b.length >= 6 && b.toString("ascii", 0, 4) === "GIF8",
	webp: (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
};

// ---- Extension 包 digest（与 ExtensionRegistry.computePackageDigest 同算法） ----

const PACKAGE_DIGEST_EXCLUDES = new Set(["node_modules", ".git"]);

async function computePackageDigest(dir: string): Promise<string> {
	const files: string[] = [];
	async function walk(current: string, prefix: string): Promise<void> {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			if (PACKAGE_DIGEST_EXCLUDES.has(entry.name)) continue;
			const abs = path.join(current, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await walk(abs, rel);
			else if (entry.isFile()) files.push(rel);
		}
	}
	await walk(dir, "");
	files.sort();
	const hash = createHash("sha256");
	for (const rel of files) {
		hash.update(rel).update("\0").update(sha256Hex(await readFile(path.join(dir, rel)))).update("\n");
	}
	return `sha256:${hash.digest("hex")}`;
}

// ---- 旧 Session JSONL ----

interface SessionHeader {
	id: string;
	cwd: string;
}

/** 校验文件名与 JSONL 头（§9.2 sessions 行）；非法返回 undefined。 */
async function readSessionHeader(file: string): Promise<SessionHeader | undefined> {
	const raw = await readFile(file, "utf-8").catch(() => undefined);
	if (raw === undefined) return undefined;
	const firstLine = raw.split("\n", 1)[0] ?? "";
	let entry: unknown;
	try {
		entry = JSON.parse(firstLine);
	} catch {
		return undefined;
	}
	const header = asRecord(entry);
	if (header.type !== "session" || typeof header.id !== "string" || !SESSION_ID_RE.test(header.id)) return undefined;
	if (typeof header.cwd !== "string" || !header.cwd) return undefined;
	return { id: header.id, cwd: header.cwd };
}

/** 递归收集目录下的普通文件（跳过符号链接，防越界）。 */
async function collectFiles(dir: string, prefix = ""): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) out.push(...(await collectFiles(path.join(dir, entry.name), rel)));
		else if (entry.isFile()) out.push(rel);
	}
	return out;
}

// ---- 主流程 ----

interface BuildContext {
	from: string;
	paths: PuddingTeamsPaths;
	repoCanonical: string;
	items: PlanItem[];
	archiveItems: PlanItem[];
	report: ImportReport;
	/** 存活窗口 id 集合。 */
	survivingWindowIds: Set<string>;
	/** 迁移后可用 session id 集合（迁移的 + stub）。 */
	survivingSessionIds: Set<string>;
	/** 旧 cwd（managed 旧 canonical/rootPath）→ 新 canonical。 */
	cwdRewrites: Map<string, string>;
}

function rewriteCwd(ctx: BuildContext, cwd: unknown): unknown {
	if (typeof cwd !== "string") return cwd;
	return ctx.cwdRewrites.get(cwd) ?? cwd;
}

/** 无项目窗口的 §9.3 处理：旧 Session 归档，窗口换发新 unscoped stub Session。 */
async function restubWindow(ctx: BuildContext, window: Record<string, unknown>): Promise<void> {
	const id = randomUUID();
	const cwd = await canonicalizePending(ctx.paths.unscopedWorkspace);
	const timestamp = new Date().toISOString();
	const fileName = `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`;
	const header = { type: "session", version: 3, id, timestamp, cwd };
	ctx.items.push({
		targetRel: path.join("sessions", fileName),
		kind: "write",
		content: Buffer.from(JSON.stringify(header) + "\n", "utf-8"),
		origin: `窗口 ${String(window.id ?? "?")} 的新 unscoped Session（§9.3）`,
	});
	window.sessions = [id];
	window.activeSession = id;
	delete window.workspaceId;
	window.cwdSnapshot = cwd;
	ctx.survivingSessionIds.add(id);
	bump(ctx.report.counts, "sessions.stubs");
	bump(ctx.report.counts, "windows.restubbed");
}

async function buildPlan(opts: ImportOptions & { from: string }, paths: PuddingTeamsPaths): Promise<BuildContext> {
	const report: ImportReport = {
		version: 1,
		from: opts.from,
		home: paths.home,
		...(opts.secretsFrom ? { secretsFrom: opts.secretsFrom } : {}),
		dryRun: !opts.execute,
		startedAt: new Date().toISOString(),
		counts: {},
		conflicts: [],
		archived: [],
		dropped: [],
		published: [],
	};
	const ctx: BuildContext = {
		from: opts.from,
		paths,
		repoCanonical: await realpath(path.dirname(opts.from)).catch(() => path.dirname(opts.from)),
		items: [],
		archiveItems: [],
		report,
		survivingWindowIds: new Set(),
		survivingSessionIds: new Set(),
		cwdRewrites: new Map(),
	};
	const teamsDir = path.join(opts.from, ".teams");
	const sessionsDir = path.join(opts.from, ".sessions");
	const isInsideRepo = (cwd: string): boolean => {
		const resolved = path.resolve(cwd);
		return resolved === ctx.repoCanonical || resolved.startsWith(ctx.repoCanonical + path.sep);
	};

	// ---- workspaces（§9.2）：外部保留 + trust pending；managed 复制 + 重算 canonical ----
	const oldWorkspacesRaw = asRecord(await readJsonFile(path.join(teamsDir, "workspaces.json")));
	const oldWorkspaces = asRecord(oldWorkspacesRaw.workspaces);
	const newWorkspaces: Record<string, WorkspaceRecord> = {};
	for (const [id, raw] of Object.entries(oldWorkspaces)) {
		const rec = asRecord(raw) as Partial<WorkspaceRecord>;
		if (typeof rec.name !== "string" || typeof rec.rootPath !== "string" || typeof rec.canonicalPath !== "string") {
			report.dropped.push({ item: `workspaces.json[${id}]`, reason: "记录缺少 name/rootPath/canonicalPath" });
			bump(report.counts, "workspaces.dropped");
			continue;
		}
		if (rec.managed === true) {
			const oldDir = path.join(teamsDir, "workspaces", id);
			if (!existsSync(oldDir) || !(await stat(oldDir)).isDirectory()) {
				report.dropped.push({ item: `managed workspace ${id}`, reason: "旧目录 .teams/workspaces/" + id + " 不存在" });
				bump(report.counts, "workspaces.dropped");
				continue;
			}
			const newRoot = path.join(paths.managedWorkspaces, id);
			const newCanonical = await canonicalizePending(newRoot);
			for (const rel of await collectFiles(oldDir)) {
				ctx.items.push({
					targetRel: path.join("workspaces", "managed", id, rel),
					kind: "copy",
					source: path.join(oldDir, rel),
					origin: `.teams/workspaces/${id}/${rel}`,
				});
			}
			ctx.cwdRewrites.set(rec.canonicalPath, newCanonical);
			ctx.cwdRewrites.set(rec.rootPath, newRoot);
			newWorkspaces[id] = {
				...(rec as WorkspaceRecord),
				id,
				rootPath: newRoot,
				canonicalPath: newCanonical,
				managed: true,
				// managed 按现状缺省规则（WorkspaceStore.normalizeTrust）：平台自有目录直接 trusted。
				trust: {
					state: "trusted",
					decidedAt: typeof rec.createdAt === "string" ? rec.createdAt : new Date().toISOString(),
					policyVersion: WORKSPACE_TRUST_POLICY_VERSION,
					canonicalPathAtDecision: newCanonical,
				},
			};
			bump(report.counts, "workspaces.managed");
		} else {
			// 外部路径保留；§9.3：迁移即重置为 pending，批准前不带项目资源。
			newWorkspaces[id] = {
				...(rec as WorkspaceRecord),
				id,
				managed: false,
				trust: { state: "pending", policyVersion: WORKSPACE_TRUST_POLICY_VERSION },
			};
			bump(report.counts, "workspaces.external");
		}
	}
	if (Object.keys(oldWorkspaces).length > 0) {
		ctx.items.push({
			targetRel: path.join("state", "workspaces.json"),
			kind: "write",
			content: Buffer.from(JSON.stringify({ version: 1, workspaces: newWorkspaces }, null, 2) + "\n", "utf-8"),
			origin: ".teams/workspaces.json",
		});
	}

	// ---- 旧 Session 扫描（§9.2/§9.3）----
	interface OldSession {
		file: string;
		header: SessionHeader;
	}
	const sessionFiles = new Map<string, OldSession>(); // sessionId → file
	if (existsSync(sessionsDir)) {
		for (const entry of await readdir(sessionsDir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			if (!/^[A-Za-z0-9._-]+\.jsonl$/.test(entry.name)) {
				report.dropped.push({ item: `.sessions/${entry.name}`, reason: "文件名非法（非安全的 *.jsonl）" });
				bump(report.counts, "sessions.dropped");
				continue;
			}
			const file = path.join(sessionsDir, entry.name);
			const header = await readSessionHeader(file);
			if (!header) {
				report.dropped.push({ item: `.sessions/${entry.name}`, reason: "JSONL 头非法（缺 session header / id / cwd）" });
				bump(report.counts, "sessions.dropped");
				continue;
			}
			sessionFiles.set(header.id, { file, header });
		}
	}

	// ---- windows（§9.2/§9.3）：校验 Session 引用；repo cwd 的无项目窗口 restub ----
	const oldWindowsRaw = asRecord(await readJsonFile(path.join(teamsDir, "windows.json")));
	const oldWindows = asRecord(oldWindowsRaw.windows);
	const newWindows: Record<string, unknown> = {};
	const sessionsToMigrate = new Map<string, OldSession>();
	for (const [id, raw] of Object.entries(oldWindows)) {
		const w = asRecord(raw);
		const workspaceId = typeof w.workspaceId === "string" && w.workspaceId ? w.workspaceId : undefined;
		if (workspaceId && !newWorkspaces[workspaceId]) {
			report.dropped.push({ item: `windows.json[${id}]`, reason: `引用的 workspace 不存在或已丢弃：${workspaceId}` });
			bump(report.counts, "windows.dropped");
			continue;
		}
		const oldSessionIds = Array.isArray(w.sessions) ? w.sessions.filter((s): s is string => typeof s === "string") : [];
		const cwdSnapshot = rewriteCwd(ctx, w.cwdSnapshot);
		const unscopedRepoCwd = !workspaceId && typeof cwdSnapshot === "string" && isInsideRepo(cwdSnapshot);
		const kept: string[] = [];
		for (const sessionId of oldSessionIds) {
			const found = sessionFiles.get(sessionId);
			if (!found) {
				report.dropped.push({ item: `window ${id} 的 session ${sessionId}`, reason: "JSONL 文件缺失或非法" });
				bump(report.counts, "sessions.dropped");
				continue;
			}
			if (unscopedRepoCwd || (!workspaceId && isInsideRepo(found.header.cwd))) {
				// §9.3：无项目且 cwd 指向源码仓的旧 Session 归档，不恢复。
				ctx.archiveItems.push({
					targetRel: path.join("migrations", "legacy-unscoped-sessions", path.basename(found.file)),
					kind: "copy",
					source: found.file,
					origin: `.sessions/${path.basename(found.file)}`,
				});
				report.archived.push({ item: `.sessions/${path.basename(found.file)}`, reason: `无项目旧 Session，cwd 指向源码仓（${found.header.cwd}），归档不恢复` });
				bump(report.counts, "sessions.archived");
				continue;
			}
			kept.push(sessionId);
			sessionsToMigrate.set(sessionId, found);
		}
		const next: Record<string, unknown> = { ...w, sessions: kept, cwdSnapshot };
		if (workspaceId) next.workspaceId = workspaceId;
		if (kept.length === 0) {
			// 全部 Session 被归档/丢失：§9.3 要求窗口换发新 unscoped Session。
			await restubWindow(ctx, next);
		} else {
			next.activeSession = typeof w.activeSession === "string" && kept.includes(w.activeSession) ? w.activeSession : kept[0];
			for (const s of kept) ctx.survivingSessionIds.add(s);
			bump(report.counts, "windows.migrated");
		}
		// workerBindings 的 managed cwd 快照同步改写。
		const bindings = asRecord(next.workerBindings);
		for (const [agent, bindingRaw] of Object.entries(bindings)) {
			const binding = asRecord(bindingRaw);
			if (typeof binding.cwdSnapshot === "string") binding.cwdSnapshot = rewriteCwd(ctx, binding.cwdSnapshot);
			bindings[agent] = binding;
		}
		if (Object.keys(bindings).length) next.workerBindings = bindings;
		newWindows[id] = next;
		ctx.survivingWindowIds.add(id);
	}
	// 孤儿 Session（没有任何存活窗口引用）：运行时无法打开（无窗口归属），归档供查看。
	for (const [sessionId, found] of sessionFiles) {
		if (sessionsToMigrate.has(sessionId)) continue;
		const alreadyArchived = ctx.archiveItems.some((item) => item.source === found.file);
		if (alreadyArchived) continue;
		ctx.archiveItems.push({
			targetRel: path.join("migrations", "legacy-unscoped-sessions", path.basename(found.file)),
			kind: "copy",
			source: found.file,
			origin: `.sessions/${path.basename(found.file)}`,
		});
		report.archived.push({ item: `.sessions/${path.basename(found.file)}`, reason: "无窗口归属的旧 Session，归档不恢复" });
		bump(report.counts, "sessions.archived");
	}
	for (const [sessionId, found] of sessionsToMigrate) {
		ctx.items.push({
			targetRel: path.join("sessions", path.basename(found.file)),
			kind: "copy",
			source: found.file,
			origin: `.sessions/${path.basename(found.file)}`,
		});
		ctx.survivingSessionIds.add(sessionId);
		bump(report.counts, "sessions.migrated");
	}
	if (Object.keys(oldWindows).length > 0) {
		ctx.items.push({
			targetRel: path.join("state", "windows.json"),
			kind: "write",
			content: Buffer.from(JSON.stringify({ version: 1, windows: newWindows }, null, 2) + "\n", "utf-8"),
			origin: ".teams/windows.json",
		});
	}

	// ---- agents（§9.2）：用户 Agent/Profile/绑定 + 内置默认按稳定名合并 ----
	const oldAgentsRaw = asRecord(await readJsonFile(path.join(teamsDir, "teams.json")));
	const oldAgents = Array.isArray(oldAgentsRaw.agents) ? (oldAgentsRaw.agents as AgentConfig[]) : [];
	const referencedAvatars = new Set<string>();
	if (oldAgents.length > 0) {
		const merged: AgentConfig[] = [];
		const seen = new Set<string>();
		const oldManager = oldAgents.find((a) => a && a.name === MANAGER_AGENT_NAME);
		const defaultManager = DEFAULT_TEAMS.find((a) => a.name === MANAGER_AGENT_NAME)!;
		// pinned manager：保留用户可编辑字段（描述/manager settings/piResources/
		// responsibility/头像），pinned/invoke/enabled 由新模型强制。
		merged.push({
			...defaultManager,
			...(oldManager
				? {
						description: oldManager.description || defaultManager.description,
						...(oldManager.manager ? { manager: oldManager.manager } : {}),
						...(oldManager.piResources ? { piResources: oldManager.piResources } : {}),
						...(oldManager.responsibility ? { responsibility: oldManager.responsibility } : {}),
						...(oldManager.avatar ? { avatar: oldManager.avatar } : {}),
					}
				: {}),
			name: MANAGER_AGENT_NAME,
			invoke: { type: "pi" },
			pinned: true,
			enabled: true,
		});
		seen.add(MANAGER_AGENT_NAME);
		for (const agent of oldAgents) {
			if (!agent || typeof agent.name !== "string" || seen.has(agent.name)) continue;
			merged.push(agent);
			seen.add(agent.name);
		}
		// 旧文件缺的内置默认项（seed 语义：文件存在后不再自动 seed，导入时合并）。
		for (const def of DEFAULT_TEAMS) {
			if (!seen.has(def.name)) merged.push(def);
		}
		for (const agent of merged) {
			if (typeof agent.avatar === "string") referencedAvatars.add(agent.avatar);
		}
		ctx.items.push({
			targetRel: path.join("state", "agents.json"),
			kind: "write",
			content: Buffer.from(JSON.stringify({ version: 1, agents: merged }, null, 2) + "\n", "utf-8"),
			origin: ".teams/teams.json",
		});
		bump(report.counts, "agents.migrated", merged.length);
	}

	// ---- delegations（§9.2）：终态可迁；running/waiting 标记不可恢复 ----
	const oldDelegationsRaw = asRecord(await readJsonFile(path.join(teamsDir, "delegations.json")));
	const oldDelegations = asRecord(oldDelegationsRaw.delegations);
	const newDelegations: Record<string, unknown> = {};
	if (Object.keys(oldDelegations).length > 0) {
		for (const [id, raw] of Object.entries(oldDelegations)) {
			const rec = asRecord(raw);
			if (rec.status === "running" || rec.status === "waiting_input") {
				// 跨进程的旧运行态无法续跑：标记 cancelled（不可恢复），留作历史。
				rec.status = "cancelled";
				rec.updatedAt = new Date().toISOString();
				bump(report.counts, "delegations.markedUnrecoverable");
			}
			rec.cwdSnapshot = rewriteCwd(ctx, rec.cwdSnapshot);
			newDelegations[id] = rec;
			bump(report.counts, "delegations.migrated");
		}
		ctx.items.push({
			targetRel: path.join("state", "delegations.json"),
			kind: "write",
			content: Buffer.from(JSON.stringify({ version: 1, delegations: newDelegations }, null, 2) + "\n", "utf-8"),
			origin: ".teams/delegations.json",
		});
	}

	// ---- interactions（§9.2）：孤儿不激活；pending/responding 统一 expired ----
	const oldInteractionsRaw = asRecord(await readJsonFile(path.join(teamsDir, "interactions.json")));
	const oldInteractions = asRecord(oldInteractionsRaw.interactions);
	const newInteractions: Record<string, unknown> = {};
	// 仍活跃（pending/responding）的 interaction id：pending/responding 已全部
	// 置为 expired，故该集合恒为空——所有加密 continuation state 都按孤儿丢弃。
	const liveInteractionIds = new Set<string>();
	if (Object.keys(oldInteractions).length > 0) {
		for (const [id, raw] of Object.entries(oldInteractions)) {
			const rec = asRecord(raw);
			if (typeof rec.delegationId !== "string" || !(rec.delegationId in newDelegations)) {
				report.dropped.push({ item: `interactions.json[${id}]`, reason: `孤儿记录：delegation ${String(rec.delegationId)} 不存在` });
				bump(report.counts, "interactions.dropped");
				continue;
			}
			if (rec.status === "pending" || rec.status === "responding") {
				rec.status = "expired";
				rec.updatedAt = new Date().toISOString();
				bump(report.counts, "interactions.expired");
			}
			newInteractions[id] = rec;
			bump(report.counts, "interactions.migrated");
		}
		ctx.items.push({
			targetRel: path.join("state", "interactions.json"),
			kind: "write",
			content: Buffer.from(JSON.stringify({ version: 1, interactions: newInteractions }, null, 2) + "\n", "utf-8"),
			origin: ".teams/interactions.json",
		});
	}

	// ---- work-states（§9.2）：仅保留引用有效 Session 的记录 ----
	const oldWorkStatesRaw = asRecord(await readJsonFile(path.join(teamsDir, "work-states.json")));
	const oldStates = asRecord(oldWorkStatesRaw.states);
	const oldDecisions = asRecord(oldWorkStatesRaw.decisions);
	if (Object.keys(oldStates).length > 0 || Object.keys(oldDecisions).length > 0) {
		const newStates: Record<string, unknown> = {};
		for (const [sessionId, raw] of Object.entries(oldStates)) {
			if (!ctx.survivingSessionIds.has(sessionId)) {
				report.dropped.push({ item: `work-states.json states[${sessionId}]`, reason: "Session 未迁移" });
				bump(report.counts, "workStates.dropped");
				continue;
			}
			newStates[sessionId] = raw;
			bump(report.counts, "workStates.migrated");
		}
		const newDecisions: Record<string, unknown> = {};
		for (const [id, raw] of Object.entries(oldDecisions)) {
			const rec = asRecord(raw);
			if (typeof rec.sessionId !== "string" || !ctx.survivingSessionIds.has(rec.sessionId)) {
				report.dropped.push({ item: `work-states.json decisions[${id}]`, reason: "Session 未迁移" });
				bump(report.counts, "workStates.dropped");
				continue;
			}
			newDecisions[id] = rec;
			bump(report.counts, "workStates.migrated");
		}
		ctx.items.push({
			targetRel: path.join("state", "work-states.json"),
			kind: "write",
			content: Buffer.from(JSON.stringify({ version: 3, states: newStates, decisions: newDecisions }, null, 2) + "\n", "utf-8"),
			origin: ".teams/work-states.json",
		});
	}

	// ---- artifacts + blobs（§9.2）：重写 snapshotPath，重校验 SHA-256 ----
	const oldArtifactsRaw = asRecord(await readJsonFile(path.join(teamsDir, "artifacts.json")));
	const oldArtifacts = asRecord(oldArtifactsRaw.artifacts);
	if (Object.keys(oldArtifacts).length > 0) {
		const blobsCanonical = await canonicalizePending(paths.artifactBlobs);
		const snapshotsDir = path.join(teamsDir, "artifact-snapshots");
		const newArtifacts: Record<string, unknown> = {};
		for (const [id, raw] of Object.entries(oldArtifacts)) {
			const rec = asRecord(raw);
			const blobSource = path.join(snapshotsDir, id);
			const buf = await readFile(blobSource).catch(() => undefined);
			if (!buf) {
				report.dropped.push({ item: `artifacts.json[${id}]`, reason: "artifact-snapshots blob 缺失" });
				bump(report.counts, "artifacts.dropped");
				continue;
			}
			if (typeof rec.contentHash !== "string" || sha256Hex(buf) !== rec.contentHash) {
				report.dropped.push({ item: `artifacts.json[${id}]`, reason: "blob SHA-256 与 contentHash 不一致" });
				bump(report.counts, "artifacts.dropped");
				continue;
			}
			rec.snapshotPath = path.join(blobsCanonical, id);
			rec.cwdSnapshot = rewriteCwd(ctx, rec.cwdSnapshot);
			ctx.items.push({ targetRel: path.join("artifacts", "blobs", id), kind: "copy", source: blobSource, origin: `.teams/artifact-snapshots/${id}` });
			newArtifacts[id] = rec;
			bump(report.counts, "artifacts.migrated");
		}
		ctx.items.push({
			targetRel: path.join("state", "artifacts.json"),
			kind: "write",
			content: Buffer.from(JSON.stringify({ version: 1, artifacts: newArtifacts }, null, 2) + "\n", "utf-8"),
			origin: ".teams/artifacts.json",
		});
	}

	// ---- uploads（§9.2）：校验相对路径与 Session 归属 ----
	const uploadsDir = path.join(teamsDir, "uploads");
	if (existsSync(uploadsDir)) {
		for (const entry of await readdir(uploadsDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (!/^[A-Za-z0-9_-]+$/.test(entry.name)) {
				report.dropped.push({ item: `.teams/uploads/${entry.name}`, reason: "目录名非法" });
				bump(report.counts, "uploads.dropped");
				continue;
			}
			if (!ctx.survivingSessionIds.has(entry.name)) {
				report.dropped.push({ item: `.teams/uploads/${entry.name}`, reason: "Session 未迁移（孤儿上传）" });
				bump(report.counts, "uploads.dropped");
				continue;
			}
			const dir = path.join(uploadsDir, entry.name);
			for (const rel of await collectFiles(dir)) {
				ctx.items.push({
					targetRel: path.join("uploads", entry.name, rel),
					kind: "copy",
					source: path.join(dir, rel),
					mode: 0o600,
					origin: `.teams/uploads/${entry.name}/${rel}`,
				});
				bump(report.counts, "uploads.migrated");
			}
		}
	}

	// ---- avatars（§9.2）：magic bytes、大小与 Agent 引用校验 ----
	const avatarsDir = path.join(teamsDir, "avatars");
	if (existsSync(avatarsDir)) {
		for (const entry of await readdir(avatarsDir, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const ext = entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase();
			const sniff = AVATAR_SNIFFS[ext];
			const buf = await readFile(path.join(avatarsDir, entry.name)).catch(() => undefined);
			if (!buf || !sniff || !sniff(buf)) {
				report.dropped.push({ item: `.teams/avatars/${entry.name}`, reason: "magic bytes 校验失败（非 png/jpg/gif/webp）" });
				bump(report.counts, "avatars.dropped");
				continue;
			}
			if (buf.length > AVATAR_MAX_BYTES) {
				report.dropped.push({ item: `.teams/avatars/${entry.name}`, reason: "超过 2MB 上限" });
				bump(report.counts, "avatars.dropped");
				continue;
			}
			if (!referencedAvatars.has(entry.name)) {
				report.dropped.push({ item: `.teams/avatars/${entry.name}`, reason: "没有 Agent 引用该头像" });
				bump(report.counts, "avatars.dropped");
				continue;
			}
			ctx.items.push({
				targetRel: path.join("assets", "avatars", entry.name),
				kind: "copy",
				source: path.join(avatarsDir, entry.name),
				origin: `.teams/avatars/${entry.name}`,
			});
			bump(report.counts, "avatars.migrated");
		}
	}

	// ---- product settings（§9.2）：只保存显式用户值，未知字段记冲突 ----
	const productRaw = await readJsonFile(path.join(teamsDir, "product-settings.json"));
	if (productRaw !== undefined) {
		const rec = asRecord(productRaw);
		const settings: Record<string, unknown> = { developerMode: rec.developerMode === true };
		for (const key of Object.keys(rec)) {
			if (key !== "developerMode") {
				report.conflicts.push({ item: `product-settings.json 字段 ${key}`, reason: "未知字段未迁移（只保存显式用户值）" });
			}
		}
		ctx.items.push({
			targetRel: path.join("config", "product.json"),
			kind: "write",
			content: Buffer.from(JSON.stringify(settings, null, 2) + "\n", "utf-8"),
			origin: ".teams/product-settings.json",
		});
		bump(report.counts, "productSettings.migrated");
	}

	// ---- extensions（§9.2）：bundled 不迁；旧 origin:"local" → local-link ----
	const oldExtensionsRaw = asRecord(await readJsonFile(path.join(teamsDir, "extensions.json")));
	const oldExtensions = Array.isArray(oldExtensionsRaw.extensions) ? oldExtensionsRaw.extensions : [];
	if (oldExtensions.length > 0) {
		const migrated: unknown[] = [];
		for (const raw of oldExtensions) {
			const rec = asRecord(raw);
			if (rec.origin === "bundled") {
				report.dropped.push({ item: `extensions.json ${String(asRecord(rec.manifest).id ?? "?")}`, reason: "bundled 记录不迁，由启动预装按发行投影重建" });
				bump(report.counts, "extensions.bundledSkipped");
				continue;
			}
			if (rec.origin !== "local") {
				report.dropped.push({ item: `extensions.json[${migrated.length}]`, reason: `未知 origin：${String(rec.origin)}` });
				bump(report.counts, "extensions.dropped");
				continue;
			}
			const sourcePath = typeof rec.sourcePath === "string" ? rec.sourcePath : "";
			if (!sourcePath || !path.isAbsolute(sourcePath) || !existsSync(sourcePath) || !(await stat(sourcePath)).isDirectory()) {
				report.conflicts.push({ item: `extension ${String(asRecord(rec.manifest).id ?? sourcePath)}`, reason: "local 源目录不存在，未迁移为 local-link" });
				bump(report.counts, "extensions.dropped");
				continue;
			}
			try {
				const manifest = parseExtensionManifest(rec.manifest);
				migrated.push({
					manifest,
					origin: "local-link",
					sourcePath,
					digest: await computePackageDigest(sourcePath),
					installedAt: typeof rec.installedAt === "string" ? rec.installedAt : new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					version: manifest.version,
					...(typeof rec.versionPin === "string" ? { versionPin: rec.versionPin } : {}),
				});
				bump(report.counts, "extensions.migrated");
			} catch (err) {
				report.conflicts.push({ item: `extension ${sourcePath}`, reason: `manifest 校验失败：${err instanceof Error ? err.message : String(err)}` });
				bump(report.counts, "extensions.dropped");
			}
		}
		ctx.items.push({
			targetRel: path.join("extensions", "registry.json"),
			kind: "write",
			content: Buffer.from(JSON.stringify({ version: 1, extensions: migrated }, null, 2) + "\n", "utf-8"),
			origin: ".teams/extensions.json",
		});
	}

	// ---- secrets（§9.2 末两行）：密文与密钥成组移动并读回验证 ----
	if (opts.secretsFrom) {
		const groups = [
			{
				label: "credentials",
				oldJson: "credentials.json",
				oldKey: "secret.key",
				newJson: path.join("secrets", "credentials.json"),
				newKey: path.join("secrets", "credentials.key"),
				payloads: (json: Record<string, unknown>) => Object.values(asRecord(json.agents)).flatMap((per) => Object.values(asRecord(per))),
				filter: (_json: Record<string, unknown>) => undefined,
			},
			{
				label: "interactions",
				oldJson: "interaction-secrets.json",
				oldKey: "interaction.key",
				newJson: path.join("secrets", "interaction-secrets.json"),
				newKey: path.join("secrets", "interactions.key"),
				payloads: (json: Record<string, unknown>) => Object.values(asRecord(json.interactions)),
				// §9.2：与公开 Interaction Registry 对账——只有仍活跃的 interaction
				// 保留加密 continuation state（pending/responding 已全部 expired，
				// 正常结果为空集），孤儿密文丢弃。
				filter: (json: Record<string, unknown>) => {
					const entries = asRecord(json.interactions);
					const kept: Record<string, unknown> = {};
					for (const [id, payload] of Object.entries(entries)) {
						if (liveInteractionIds.has(id)) kept[id] = payload;
						else {
							report.dropped.push({ item: `interaction-secrets.json[${id}]`, reason: "对应 Interaction 已终态或不存在，密文不迁" });
							bump(report.counts, "secrets.orphanDropped");
						}
					}
					return { version: 1, interactions: kept };
				},
			},
		];
		for (const group of groups) {
			const jsonPath = path.join(opts.secretsFrom, group.oldJson);
			const keyPath = path.join(opts.secretsFrom, group.oldKey);
			const json = await readJsonFile(jsonPath);
			if (json === undefined) continue; // 该组无密文，跳过（密钥单独存在无意义）。
			if (!existsSync(keyPath)) {
				report.conflicts.push({ item: `secrets 组 ${group.label}`, reason: `密钥文件 ${group.oldKey} 不存在，该组跳过` });
				continue;
			}
			const key = await readFile(keyPath);
			try {
				for (const payload of group.payloads(asRecord(json))) {
					if (typeof payload === "string") decryptV1(key, payload);
				}
			} catch (err) {
				report.conflicts.push({ item: `secrets 组 ${group.label}`, reason: `读回验证失败（密文无法用 ${group.oldKey} 解密）：${err instanceof Error ? err.message : String(err)}` });
				continue;
			}
			const filtered = group.filter(asRecord(json)) ?? json;
			ctx.items.push({ targetRel: group.newKey, kind: "copy", source: keyPath, mode: 0o600, origin: group.oldKey });
			ctx.items.push({
				targetRel: group.newJson,
				kind: "write",
				content: Buffer.from(JSON.stringify(filtered, null, 2) + "\n", "utf-8"),
				mode: 0o600,
				origin: group.oldJson,
			});
			bump(report.counts, `secrets.${group.label}`);
		}
	}

	return ctx;
}

// ---- 冲突检测（dry-run 与 execute 共用）：同名同内容跳过，不同内容记冲突 ----

async function detectConflicts(ctx: BuildContext): Promise<Set<PlanItem>> {
	const publishable = new Set<PlanItem>();
	for (const item of [...ctx.items, ...ctx.archiveItems]) {
		const target = assertInsideHome(ctx.paths.home, item.targetRel);
		if (!existsSync(target)) {
			publishable.add(item);
			continue;
		}
		const existing = await readFile(target);
		const candidate = item.kind === "write" ? item.content! : await readFile(item.source!);
		if (existing.equals(candidate)) {
			bump(ctx.report.counts, "unchanged");
			continue; // 幂等：同内容不重复发布。
		}
		ctx.report.conflicts.push({ item: item.targetRel, reason: `目标已存在且内容不同（来源 ${item.origin}），未覆盖` });
	}
	return publishable;
}

// ---- execute：staging → 校验 → 同卷 rename 原子发布 ----

async function materializeStaging(ctx: BuildContext, stagingDir: string, items: Set<PlanItem>): Promise<Map<PlanItem, string>> {
	const staged = new Map<PlanItem, string>();
	for (const item of items) {
		const stagingPath = assertInsideHome(stagingDir, item.targetRel);
		await mkdir(path.dirname(stagingPath), { recursive: true });
		if (item.kind === "write") await writeFile(stagingPath, item.content!, { mode: item.mode });
		else await copyFile(item.source!, stagingPath);
		if (item.mode !== undefined) await chmod(stagingPath, item.mode).catch(() => undefined);
		staged.set(item, stagingPath);
	}
	return staged;
}

/** staging 候选树校验（§9.4.2）：JSON 可解析、secret 可解密、artifact digest、路径边界。 */
async function validateStaging(ctx: BuildContext, staged: Map<PlanItem, string>): Promise<void> {
	const secretsDirRel = path.join("secrets");
	for (const [item, stagingPath] of staged) {
		assertInsideHome(ctx.paths.home, item.targetRel);
		if (item.targetRel.endsWith(".json") && item.kind === "write") {
			JSON.parse(await readFile(stagingPath, "utf-8"));
		}
	}
	// artifact digest：staged blob 的 SHA-256 必须等于 staged artifacts.json 里的 contentHash。
	const artifactsItem = [...staged].find(([item]) => item.targetRel === path.join("state", "artifacts.json"));
	if (artifactsItem) {
		const artifacts = asRecord(asRecord(JSON.parse(await readFile(artifactsItem[1], "utf-8"))).artifacts);
		for (const [id, raw] of Object.entries(artifacts)) {
			const blobItem = [...staged].find(([item]) => item.targetRel === path.join("artifacts", "blobs", id));
			if (!blobItem) throw new Error(`artifact ${id} 的 blob 未进入候选树`);
			const expected = asRecord(raw).contentHash;
			const actual = sha256Hex(await readFile(blobItem[1]));
			if (actual !== expected) throw new Error(`artifact ${id} digest 校验失败：${actual} != ${String(expected)}`);
		}
	}
	// secret 组读回验证：staging 里的密钥 + 密文成组可解密。
	for (const group of [
		{ json: "credentials.json", key: "credentials.key", payloads: (j: Record<string, unknown>) => Object.values(asRecord(j.agents)).flatMap((per) => Object.values(asRecord(per))) },
		{ json: "interaction-secrets.json", key: "interactions.key", payloads: (j: Record<string, unknown>) => Object.values(asRecord(j.interactions)) },
	]) {
		const jsonItem = [...staged].find(([item]) => item.targetRel === path.join(secretsDirRel, group.json));
		const keyItem = [...staged].find(([item]) => item.targetRel === path.join(secretsDirRel, group.key));
		if (!jsonItem && !keyItem) continue;
		if (!jsonItem || !keyItem) throw new Error(`secrets 组不完整（${group.json}/${group.key} 只有其一进入候选树）`);
		const key = await readFile(keyItem[1]);
		const json = asRecord(JSON.parse(await readFile(jsonItem[1], "utf-8")));
		for (const payload of group.payloads(json)) {
			if (typeof payload === "string") decryptV1(key, payload);
		}
	}
}

async function executeImport(ctx: BuildContext, publishable: Set<PlanItem>): Promise<void> {
	const { paths, report } = ctx;
	await mkdir(paths.migrations, { recursive: true });
	const stagingDir = path.join(paths.migrations, `staging-${Date.now()}-${randomUUID().slice(0, 8)}`);
	const staged = await materializeStaging(ctx, stagingDir, publishable);
	await validateStaging(ctx, staged);
	// 同卷 rename 原子发布（staging 与目标同在 home 下）。
	for (const [item, stagingPath] of staged) {
		const target = assertInsideHome(paths.home, item.targetRel);
		await mkdir(path.dirname(target), { recursive: true });
		await rename(stagingPath, target);
		report.published.push(item.targetRel);
	}
	await rm(stagingDir, { recursive: true, force: true });
	// 目录骨架（unscoped cwd 等即使本次无内容也要存在）。
	await mkdir(paths.unscopedWorkspace, { recursive: true });
	report.finishedAt = new Date().toISOString();
	// 迁移报告（同名直接重写：它是本次运行的日志，不是用户事实）。
	const reportPath = path.join(paths.migrations, "user-home-v1.json");
	const tmp = `${reportPath}.${randomUUID().slice(0, 8)}.tmp`;
	await writeFile(tmp, JSON.stringify(report, null, 2) + "\n", "utf-8");
	await rename(tmp, reportPath);
}

// ---- 输出 ----

export interface ImportResult {
	report: ImportReport;
	/** 全部候选映射（含归档项）：来源 → 相对目标路径。 */
	mappings: { origin: string; target: string }[];
}

function printReport(result: ImportResult): void {
	const { report } = result;
	const log = (msg: string) => console.log(msg);
	const err = (msg: string) => console.error(msg);
	log(report.dryRun ? "DRY-RUN：未写入任何内容（加 --execute 执行导入）" : "导入完成");
	log(`来源：${report.from}`);
	log(`目标 Home：${report.home}`);
	if (report.secretsFrom) log(`Secrets 来源：${report.secretsFrom}`);
	log(`\n目标映射（${result.mappings.length} 个文件）：`);
	for (const m of result.mappings) {
		log(`  ${m.origin} → ${m.target}`);
	}
	log("\n数量：");
	for (const [key, count] of Object.entries(report.counts).sort(([a], [b]) => a.localeCompare(b))) {
		log(`  ${key}: ${count}`);
	}
	if (report.conflicts.length > 0) {
		err(`\n冲突（${report.conflicts.length}，未覆盖现有数据）：`);
		for (const c of report.conflicts) err(`  ✗ ${c.item}：${c.reason}`);
	}
	if (report.archived.length > 0) {
		log(`\n归档（${report.archived.length} → migrations/legacy-unscoped-sessions/）：`);
		for (const a of report.archived) log(`  - ${a.item}：${a.reason}`);
	}
	if (report.dropped.length > 0) {
		log(`\n丢弃/跳过（${report.dropped.length}）：`);
		for (const d of report.dropped) log(`  - ${d.item}：${d.reason}`);
	}
	if (!report.dryRun) log(`\n已发布 ${report.published.length} 个文件；报告写入 migrations/user-home-v1.json`);
}

// ---- CLI 入口 ----

const USAGE = `puddingteams data import-legacy — 一次性导入旧开发数据（迁移方案 §9）

用法：
  puddingteams data import-legacy --from <repo>/apps/server [--home <PUDDINGTEAMS_HOME>] [--secrets-from <dir>] [--execute|--dry-run]

选项：
  --from          旧 apps/server 目录（必须含 .teams 或 .sessions）
  --home          目标用户数据目录；缺省 PUDDINGTEAMS_HOME 或 ~/.puddingteams
  --secrets-from  旧 secrets 备份目录（含 credentials.json/secret.key/
                  interaction-secrets.json/interaction.key）；缺省不迁移 secrets
  --dry-run       只输出映射/冲突/归档清单，零写入（默认）
  --execute       真正执行：staging 校验 → 原子发布 → 写 migrations/user-home-v1.json

退出码：0 成功；2 有冲突（同名不同内容未覆盖）；1 参数/运行错误。
`;

export async function importLegacyData(opts: ImportOptions): Promise<ImportResult> {
	const from = path.resolve(opts.from);
	if (!existsSync(from) || !(await stat(from)).isDirectory()) {
		throw new Error(`--from 目录不存在：${from}`);
	}
	if (!existsSync(path.join(from, ".teams")) && !existsSync(path.join(from, ".sessions"))) {
		throw new Error(`--from 必须是含 .teams 或 .sessions 的旧 apps/server 目录：${from}`);
	}
	const paths = resolvePuddingTeamsPaths(opts.home ? { PUDDINGTEAMS_HOME: opts.home } : process.env);
	// §9.1 前置条件：Home 不被另一个 Backend 持有 Lease（只读检查，不获取）。
	const leaseRaw = await readFile(path.join(paths.runtime, "backend.lease"), "utf-8").catch(() => "");
	if (leaseRaw) {
		let pid: number | undefined;
		try {
			pid = (JSON.parse(leaseRaw) as { pid?: number }).pid;
		} catch {
			pid = undefined; // 内容损坏视为 stale
		}
		if (typeof pid === "number") {
			let alive = false;
			try {
				process.kill(pid, 0);
				alive = true;
			} catch (err) {
				alive = (err as NodeJS.ErrnoException).code === "EPERM";
			}
			if (alive) throw new Error(`另一个 PuddingTeams 后端正在运行（pid ${pid}），先停止再导入`);
		}
	}
	const ctx = await buildPlan({ ...opts, from }, paths);
	const publishable = await detectConflicts(ctx);
	if (opts.execute) await executeImport(ctx, publishable);
	const mappings = [...ctx.items, ...ctx.archiveItems].map((item) => ({ origin: item.origin, target: item.targetRel }));
	return { report: ctx.report, mappings };
}

export async function runDataImportCli(argv: string[]): Promise<number> {
	const [cmd, ...rest] = argv;
	if (cmd !== "import-legacy") {
		console.error(USAGE);
		return 1;
	}
	let from: string | undefined;
	let home: string | undefined;
	let secretsFrom: string | undefined;
	let execute = false;
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i]!;
		switch (arg) {
			case "--from":
				from = rest[++i];
				break;
			case "--home":
				home = rest[++i];
				break;
			case "--secrets-from":
				secretsFrom = rest[++i];
				break;
			case "--execute":
				execute = true;
				break;
			case "--dry-run":
				execute = false;
				break;
			default:
				console.error(`✗ 未知参数：${arg}\n${USAGE}`);
				return 1;
		}
	}
	if (!from) {
		console.error(`✗ 缺少 --from <repo>/apps/server\n${USAGE}`);
		return 1;
	}
	if (home && !path.isAbsolute(home)) {
		console.error(`✗ --home 必须是绝对路径：${home}`);
		return 1;
	}
	try {
		const result = await importLegacyData({ from, ...(home ? { home } : {}), ...(secretsFrom ? { secretsFrom: path.resolve(secretsFrom) } : {}), execute });
		printReport(result);
		return result.report.conflicts.length > 0 ? 2 : 0;
	} catch (err) {
		console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}
