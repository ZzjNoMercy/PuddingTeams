import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** Workspace 信任门（迁移方案 §7）：可注入资源的三类来源。 */
export type WorkspaceResourceKind = "context" | "skills" | "prompts";
export const WORKSPACE_RESOURCE_KINDS: readonly WorkspaceResourceKind[] = ["context", "skills", "prompts"];
/** §7.1 policyVersion：信任策略结构变化时递增，初值 1。 */
export const WORKSPACE_TRUST_POLICY_VERSION = 1;

export type WorkspaceTrustState = "pending" | "trusted" | "denied";

/**
 * 信任决定只保存在用户 Home（workspaces.json），项目文件不能声明自己
 * 已受信。首期只信任规范化后的精确目录：realpath 与
 * canonicalPathAtDecision 不一致时自动退回 pending（§7.3）。
 */
export interface WorkspaceTrust {
	state: WorkspaceTrustState;
	decidedAt?: string;
	policyVersion: number;
	canonicalPathAtDecision?: string;
	/** 缺省 = 全三类都批准。 */
	approvedResources?: WorkspaceResourceKind[];
}

/** 三类资源的有效放行结果（§7.2 有效条件的计算产物）。 */
export interface WorkspaceResourceAccess {
	context: boolean;
	skills: boolean;
	prompts: boolean;
}

/** 可注入资源摘要（信任卡用）：只报类型与数量，不返回正文（§7.2）。 */
export interface WorkspaceResourceSummary {
	/** AGENTS.md / CLAUDE.md 命中数。 */
	contextFiles: number;
	/** .pi/skills 下的条目数。 */
	skills: number;
	/** .pi/prompts 下的 .md 模板数。 */
	prompts: number;
}

export interface WorkspaceRecord {
	id: string;
	name: string;
	/** 用户选择的服务端绝对路径。 */
	rootPath: string;
	/** realpath 后的稳定去重身份。 */
	canonicalPath: string;
	/** 选择目录所属的 Git 仓库根；允许 rootPath 保留为仓库子目录。 */
	gitRoot?: string;
	managed: boolean;
	trust: WorkspaceTrust;
	createdAt: string;
	lastOpenedAt: string;
}

export interface WorkspaceSummary extends WorkspaceRecord {
	available: boolean;
	resources: WorkspaceResourceSummary;
}

/** 扫描可注入资源的类型与数量（不读正文）。目录不可读时按 0 计。 */
export async function scanWorkspaceResources(rootPath: string): Promise<WorkspaceResourceSummary> {
	const hasFile = async (name: string): Promise<boolean> =>
		stat(path.join(rootPath, name)).then((info) => info.isFile(), () => false);
	const countEntries = async (dir: string, filter: (name: string, isDir: boolean) => boolean): Promise<number> =>
		readdir(dir, { withFileTypes: true }).then(
			(entries) => entries.filter((entry) => filter(entry.name, entry.isDirectory())).length,
			() => 0,
		);
	const [agents, claude, skills, prompts] = await Promise.all([
		hasFile("AGENTS.md"),
		hasFile("CLAUDE.md"),
		countEntries(path.join(rootPath, ".pi", "skills"), () => true),
		countEntries(path.join(rootPath, ".pi", "prompts"), (name, isDir) => !isDir && name.endsWith(".md")),
	]);
	return { contextFiles: (agents ? 1 : 0) + (claude ? 1 : 0), skills, prompts };
}

/** Whether a frozen path still resolves to the same readable directory identity. */
export async function isWorkspaceDirectoryAvailable(rootPath: string, canonicalPath: string): Promise<boolean> {
	const current = await realpath(rootPath).catch(() => undefined);
	if (!current || current !== canonicalPath) return false;
	const info = await stat(current).catch(() => undefined);
	if (!info?.isDirectory()) return false;
	return access(current, fsConstants.R_OK).then(
		() => true,
		() => false,
	);
}

interface WorkspacesFile {
	version: 1;
	workspaces: Record<string, WorkspaceRecord>;
}

/** 平台管理的项目身份。Window/Session/Delegation 只引用 workspaceId。 */
export class WorkspaceStore {
	private readonly file: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		stateDir: string,
		private readonly managedRoot: string,
	) {
		this.file = path.join(stateDir, "workspaces.json");
	}

	async init(): Promise<void> {
		await mkdir(this.managedRoot, { recursive: true });
	}

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	private async load(): Promise<WorkspacesFile> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf-8")) as Partial<WorkspacesFile>;
			const workspaces: Record<string, WorkspaceRecord> = {};
			for (const [id, record] of Object.entries(parsed.workspaces ?? {})) {
				workspaces[id] = { ...record, trust: WorkspaceStore.normalizeTrust(record) };
			}
			return { version: 1, workspaces };
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return { version: 1, workspaces: {} };
		}
	}

	/** 旧记录缺 trust 字段时按来源补默认：managed 直接 trusted，外部 pending。 */
	private static normalizeTrust(record: WorkspaceRecord): WorkspaceTrust {
		if (record.trust && typeof record.trust === "object") {
			return { ...record.trust, policyVersion: record.trust.policyVersion ?? WORKSPACE_TRUST_POLICY_VERSION };
		}
		return record.managed
			? {
					state: "trusted",
					decidedAt: record.createdAt,
					policyVersion: WORKSPACE_TRUST_POLICY_VERSION,
					canonicalPathAtDecision: record.canonicalPath,
				}
			: { state: "pending", policyVersion: WORKSPACE_TRUST_POLICY_VERSION };
	}

	private async write(data: WorkspacesFile): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
		await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
		await rename(tmp, this.file);
	}

	private static async validateDirectory(input: string): Promise<{ rootPath: string; canonicalPath: string }> {
		const rootPath = path.resolve(input.trim());
		if (!path.isAbsolute(input.trim())) throw new Error("项目路径必须是绝对路径");
		const info = await stat(rootPath).catch(() => undefined);
		if (!info?.isDirectory()) throw new Error("项目路径不存在或不是目录");
		await access(rootPath, fsConstants.R_OK);
		return { rootPath, canonicalPath: await realpath(rootPath) };
	}

	private static async findGitRoot(canonicalPath: string): Promise<string | undefined> {
		let current = canonicalPath;
		while (true) {
			const marker = await stat(path.join(current, ".git")).catch(() => undefined);
			if (marker) return current;
			const parent = path.dirname(current);
			if (parent === current) return undefined;
			current = parent;
		}
	}

	async createFromPath(input: { path: string; name?: string }): Promise<WorkspaceRecord> {
		const { rootPath, canonicalPath } = await WorkspaceStore.validateDirectory(input.path);
		return this.serialize(async () => {
			const data = await this.load();
			const existing = Object.values(data.workspaces).find((w) => w.canonicalPath === canonicalPath);
			if (existing) {
				existing.lastOpenedAt = new Date().toISOString();
				if (input.name?.trim()) existing.name = input.name.trim();
				await this.write(data);
				return existing;
			}
			const now = new Date().toISOString();
			const record: WorkspaceRecord = {
				id: randomUUID(),
				name: input.name?.trim() || path.basename(rootPath) || rootPath,
				rootPath,
				canonicalPath,
				gitRoot: await WorkspaceStore.findGitRoot(canonicalPath),
				managed: false,
				// 外部项目登记即 pending：批准前可注入资源不进扫描/预览/Prompt（§7.2）。
				trust: { state: "pending", policyVersion: WORKSPACE_TRUST_POLICY_VERSION },
				createdAt: now,
				lastOpenedAt: now,
			};
			data.workspaces[record.id] = record;
			await this.write(data);
			return record;
		});
	}

	async createManaged(name = "临时项目"): Promise<WorkspaceRecord> {
		const id = randomUUID();
		const rootPath = path.join(this.managedRoot, id);
		await mkdir(rootPath, { recursive: true });
		const canonicalPath = await realpath(rootPath);
		const now = new Date().toISOString();
		const record: WorkspaceRecord = {
			id,
			name: name.trim() || "临时项目",
			rootPath,
			canonicalPath,
			managed: true,
			// managed workspace 是平台自己创建并拥有目录，直接 trusted（§7.1）。
			trust: {
				state: "trusted",
				decidedAt: now,
				policyVersion: WORKSPACE_TRUST_POLICY_VERSION,
				canonicalPathAtDecision: canonicalPath,
			},
			createdAt: now,
			lastOpenedAt: now,
		};
		await this.serialize(async () => {
			const data = await this.load();
			data.workspaces[id] = record;
			await this.write(data);
		});
		return record;
	}

	/**
	 * §7.3 路径漂移：trusted/denied 记录的 realpath 与登记身份
	 * （canonicalPath）或信任时记录的 canonicalPathAtDecision 不一致时，
	 * 立即退回 pending 并持久化，不得自动沿用信任。路径暂时不可达不做
	 * 持久退回——require/available 已经挡住使用。
	 */
	private async applyTrustDrift(record: WorkspaceRecord): Promise<WorkspaceRecord> {
		if (record.trust.state === "pending") return record;
		const current = await realpath(record.rootPath).catch(() => undefined);
		if (!current) return record;
		const decided = record.trust.canonicalPathAtDecision;
		if (current === record.canonicalPath && (decided === undefined || current === decided)) return record;
		return this.serialize(async () => {
			const data = await this.load();
			const stored = data.workspaces[record.id];
			if (!stored || stored.trust.state === "pending") return stored ?? record;
			stored.trust = {
				state: "pending",
				policyVersion: stored.trust.policyVersion,
				...(stored.trust.approvedResources ? { approvedResources: stored.trust.approvedResources } : {}),
			};
			await this.write(data);
			return stored;
		});
	}

	async get(id: string): Promise<WorkspaceRecord | undefined> {
		const record = (await this.load()).workspaces[id];
		return record ? this.applyTrustDrift(record) : undefined;
	}

	async require(id: string): Promise<WorkspaceRecord> {
		const workspace = await this.get(id);
		if (!workspace) throw new Error(`workspace not found: ${id}`);
		const current = await realpath(workspace.rootPath).catch(() => undefined);
		if (!current || current !== workspace.canonicalPath) {
			throw new Error(`项目路径已失效或身份已变化：${workspace.rootPath}`);
		}
		const info = await stat(current);
		if (!info.isDirectory()) throw new Error(`项目路径不是目录：${workspace.rootPath}`);
		await access(current, fsConstants.R_OK);
		return workspace;
	}

	/**
	 * 信任决策（§7.2）：trusted/denied 记录决定时间与当时的规范化路径；
	 * pending（暂不决定）清除决定元数据但保留 approvedResources 草稿。
	 * trusted 前必须路径身份有效；approvedResources 缺省 = 全三类。
	 */
	async setTrust(
		id: string,
		input: { state: WorkspaceTrustState; approvedResources?: WorkspaceResourceKind[] },
	): Promise<WorkspaceRecord> {
		if (input.state !== "pending" && input.state !== "trusted" && input.state !== "denied") {
			throw new Error("trust.state 必须是 pending | trusted | denied");
		}
		let approved: WorkspaceResourceKind[] | undefined;
		if (input.approvedResources !== undefined) {
			if (!Array.isArray(input.approvedResources) || input.approvedResources.some((k) => !WORKSPACE_RESOURCE_KINDS.includes(k))) {
				throw new Error(`approvedResources 只能是 ${WORKSPACE_RESOURCE_KINDS.join(" | ")} 的子集`);
			}
			approved = [...new Set(input.approvedResources)];
		}
		if (input.state === "trusted") await this.require(id);
		return this.serialize(async () => {
			const data = await this.load();
			const record = data.workspaces[id];
			if (!record) throw new Error(`workspace not found: ${id}`);
			record.trust =
				input.state === "pending"
					? {
							state: "pending",
							policyVersion: WORKSPACE_TRUST_POLICY_VERSION,
							// 暂不决定保留既有 approvedResources 草稿，显式传入可改。
							...((approved ?? record.trust.approvedResources)
								? { approvedResources: approved ?? record.trust.approvedResources }
								: {}),
						}
					: {
							state: input.state,
							decidedAt: new Date().toISOString(),
							policyVersion: WORKSPACE_TRUST_POLICY_VERSION,
							canonicalPathAtDecision: record.canonicalPath,
							...(approved ? { approvedResources: approved } : {}),
						};
			await this.write(data);
			return record;
		});
	}

	/**
	 * 有效资源判定单点（§7.2）：显式 workspaceId && 路径身份仍匹配 &&
	 * trust=trusted && approvedResources 含 kind（缺省 = 全三类）。
	 * 任一不满足，该来源不进入候选集。
	 */
	async isWorkspaceResourceAllowed(id: string, kind: WorkspaceResourceKind): Promise<boolean> {
		const record = await this.get(id);
		if (!record || record.trust.state !== "trusted") return false;
		return (record.trust.approvedResources ?? [...WORKSPACE_RESOURCE_KINDS]).includes(kind);
	}

	/** 窗口 workspace 的三类资源放行结果；无 workspaceId（unscoped）= 全关（§6.3）。 */
	async resourceAccessFor(id?: string): Promise<WorkspaceResourceAccess> {
		if (!id) return { context: false, skills: false, prompts: false };
		return {
			context: await this.isWorkspaceResourceAllowed(id, "context"),
			skills: await this.isWorkspaceResourceAllowed(id, "skills"),
			prompts: await this.isWorkspaceResourceAllowed(id, "prompts"),
		};
	}

	async touch(id: string): Promise<WorkspaceRecord> {
		return this.serialize(async () => {
			const data = await this.load();
			const workspace = data.workspaces[id];
			if (!workspace) throw new Error(`workspace not found: ${id}`);
			workspace.lastOpenedAt = new Date().toISOString();
			await this.write(data);
			return workspace;
		});
	}

	async list(): Promise<WorkspaceSummary[]> {
		const data = await this.load();
		const summaries = await Promise.all(
			Object.values(data.workspaces).map(async (record) => {
				const workspace = await this.applyTrustDrift(record);
				const available = await isWorkspaceDirectoryAvailable(workspace.rootPath, workspace.canonicalPath);
				return {
					...workspace,
					available,
					resources: available
						? await scanWorkspaceResources(workspace.canonicalPath)
						: { contextFiles: 0, skills: 0, prompts: 0 },
				};
			}),
		);
		return summaries.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
	}

	/** 单个 workspace 的列表同款摘要（详情 API 用）。 */
	async summary(id: string): Promise<WorkspaceSummary | undefined> {
		const record = await this.get(id);
		if (!record) return undefined;
		const available = await isWorkspaceDirectoryAvailable(record.rootPath, record.canonicalPath);
		return {
			...record,
			available,
			resources: available
				? await scanWorkspaceResources(record.canonicalPath)
				: { contextFiles: 0, skills: 0, prompts: 0 },
		};
	}
}
