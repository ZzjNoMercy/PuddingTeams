import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import semver from "semver";
import {
	ExtensionCatalog,
	parseExtensionManifest,
	readManifestFromDir,
	type CapabilityExtensionModule,
	type ExtensionKind,
	type PuddingTeamsExtensionManifest,
} from "./extensions.js";
import { DriverRegistry, type DriverFactory } from "./driver-registry.js";
import { createDeclarativeDriverFactory } from "./declarative-driver.js";
import { PUDDINGTEAMS_HOST_VERSION } from "./host-version.js";
import type { AgentDriver } from "./types.js";

/**
 * Phase 5：Extension 持久化目录与安装（方案 §9.3/§10，决策 16；
 * 用户数据目录迁移方案 §8 来源三态）。
 *
 * - origin 三态（互不静默覆盖，同 id 冲突必须显式卸载其一）：
 *   - `bundled`：随发行物的第一方包（开发态 = 仓库 extensions/*）。记录以
 *     manifest id+版本为事实，sourcePath 每次启动由发行投影重新解析自愈；
 *   - `user`：用户安装，内容复制到 `<extensionsDir>/packages/<id>/<version>/`，
 *     记录 digest/版本/来源/安装时间；更新先 staging 校验再原子切换记录，
 *     失败保留旧版本；
 *   - `local-link`：开发者模式专属，只登记规范化绝对路径 + 最近 digest
 *     （启动/重载校验漂移），不复制源码；关闭开发者模式立即停用，不静默
 *     回退到同名 bundled/user 包。
 * - builtin（puddingclaw/pi）代码内嵌，不落盘。
 * - 卸载不做静默回退：有启用 Agent 或 active/waiting Run 的保护判断在
 *   路由层（409），这里只负责移除模块与记录；对应 Agent 保留绑定，
 *   调用时进入 connector_missing。
 */

/** 已安装 Extension 的物理来源（文档 §8）。 */
export type ExtensionOrigin = "bundled" | "user" | "local-link";

/** 冲突提示用的来源文案。 */
const ORIGIN_LABELS: Record<ExtensionOrigin, string> = {
	bundled: "随发行物预置（bundled）",
	user: "用户安装（user）",
	"local-link": "开发者本地链接（local-link）",
};

/** 复制/ digest 时跳过的目录名（依赖与 VCS 不属于包内容事实）。 */
const PACKAGE_COPY_EXCLUDES = new Set(["node_modules", ".git"]);

/** 递归复制包目录（跳过 node_modules/.git）。 */
async function copyPackageDir(src: string, dest: string): Promise<void> {
	await mkdir(dest, { recursive: true });
	for (const entry of await readdir(src, { withFileTypes: true })) {
		if (PACKAGE_COPY_EXCLUDES.has(entry.name)) continue;
		const from = path.join(src, entry.name);
		const to = path.join(dest, entry.name);
		if (entry.isDirectory()) await copyPackageDir(from, to);
		else if (entry.isFile()) await writeFile(to, await readFile(from));
	}
}

/**
 * 包内容 digest：递归收集文件（跳过 node_modules/.git），对每个文件算
 * sha256，再对「相对路径 + 文件 hash」排序清单算总 sha256。
 */
async function computePackageDigest(dir: string): Promise<string> {
	const files: string[] = [];
	async function walk(current: string, prefix: string): Promise<void> {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			if (PACKAGE_COPY_EXCLUDES.has(entry.name)) continue;
			const abs = path.join(current, entry.name);
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await walk(abs, rel);
			else if (entry.isFile()) files.push(rel);
		}
	}
	await walk(dir, "");
	files.sort();
	const manifestHash = createHash("sha256");
	for (const rel of files) {
		const fileHash = createHash("sha256").update(await readFile(path.join(dir, rel))).digest("hex");
		manifestHash.update(rel).update("\0").update(fileHash).update("\n");
	}
	return `sha256:${manifestHash.digest("hex")}`;
}

/** 已安装 Extension 的持久化记录（builtin 不落盘）。 */
export interface InstalledExtensionRecord {
	manifest: PuddingTeamsExtensionManifest & { entry?: string };
	origin: ExtensionOrigin;
	/** bundled=发行投影解析路径；user=packages/<id>/<version>/；local-link=规范化绝对路径。 */
	sourcePath: string;
	/** user/local-link 必记的包内容 digest（local-link 用于漂移检测）。 */
	digest?: string;
	installedAt: string;
	updatedAt: string;
	version: string;
	versionPin?: string;
}

interface ExtensionsFile {
	version: number;
	extensions: InstalledExtensionRecord[];
}

/** 目录 API 的条目投影：manifest + 安装状态 + 版本。 */
export interface CatalogEntry {
	manifest: PuddingTeamsExtensionManifest;
	installed: boolean;
	origin: "builtin" | ExtensionOrigin;
	version: string;
	versionPin?: string;
	/** 模块/driver 已注册进运行时（重启后重载失败为 false）。 */
	loaded: boolean;
	loadError?: string;
	/** local-link 源目录内容与登记的 digest 不一致（漂移提示，不阻断加载）。 */
	drifted?: boolean;
}

/** builtin Extension 的运行时挂载（代码提供，不经安装流程）。 */
export interface BuiltinExtensionHooks {
	driver?: AgentDriver;
	driverFactory?: DriverFactory;
	capabilityModule?: CapabilityExtensionModule;
}

interface LoadedModule {
	createDriver?: DriverFactory;
	driver?: AgentDriver;
	extension?: CapabilityExtensionModule;
	default?: CapabilityExtensionModule | { createDriver?: DriverFactory; driver?: AgentDriver };
}

/** 头像资源扩展名 → MIME（校验白名单与 extensions.ts 一致）。 */
function avatarMime(assetPath: string): string {
	const ext = assetPath.slice(assetPath.lastIndexOf(".")).toLowerCase();
	switch (ext) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		default:
			return "image/svg+xml";
	}
}

export class ExtensionRegistry {
	private readonly builtins = new Map<string, { manifest: PuddingTeamsExtensionManifest; hooks: BuiltinExtensionHooks; assetsDir?: string }>();
	private readonly installed = new Map<string, InstalledExtensionRecord>();
	private readonly loadErrors = new Map<string, string>();
	private readonly file: string;
	private queue: Promise<unknown> = Promise.resolve();
	private developerMode = false;
	private readonly activeLocal = new Set<string>();
	/** local-link 源目录 digest 与登记值不一致的 extension id。 */
	private readonly driftedLinks = new Set<string>();
	/** Runtime contribution key -> owning package manifest id. */
	private readonly contributionOwners = new Map<string, string>();
	private readonly moduleActivationCounts = new Map<string, number>();
	/** 最近一次成功激活的运行时对象；更新失败时不依赖已被覆盖的源目录即可恢复。 */
	private readonly activeHooks = new Map<string, BuiltinExtensionHooks | null>();
	/** user 包的落地根目录：`<extensionsDir>/packages/<id>/<version>/`。 */
	private readonly packagesDir: string;

	constructor(
		extensionsDir: string,
		private readonly catalog: ExtensionCatalog,
		private readonly drivers: DriverRegistry,
		private readonly hostVersion = PUDDINGTEAMS_HOST_VERSION,
	) {
		this.file = path.join(extensionsDir, "registry.json");
		this.packagesDir = path.join(extensionsDir, "packages");
	}

	/**
	 * 落盘目录 + 重新注册上次安装的 Extension（重启恢复）。发行入口传入
	 * 当前 bundledIds 后，会先移除已经退出发行物的旧 bundled 记录；用户安装
	 * 和 local-link 不受影响。
	 */
	async init(opts: { developerMode?: boolean; bundledIds?: readonly string[] } = {}): Promise<void> {
		this.developerMode = opts.developerMode === true;
		let records = await this.readFile();
		if (opts.bundledIds) {
			const currentBundled = new Set(opts.bundledIds);
			const filtered = records.filter(
				(record) => record.origin !== "bundled" || currentBundled.has(record.manifest.id),
			);
			if (filtered.length !== records.length) await this.writeFile(filtered);
			records = filtered;
		}
		for (const record of records) {
			this.installed.set(record.manifest.id, record);
			if (record.origin === "local-link") {
				await this.checkLinkDrift(record);
				if (!this.developerMode) {
					this.loadErrors.set(record.manifest.id, "开发者模式未开启，本地代码 Extension 未加载");
					continue;
				}
			}
			// bundled 的 sourcePath 是发行投影事实：路径失效时激活失败只记
			// loadError，由启动预装流程（installOrUpdateFromDir）重新解析自愈。
			await this.activate(record).catch((err: unknown) => {
				this.loadErrors.set(record.manifest.id, err instanceof Error ? err.message : String(err));
			});
			if (record.origin === "local-link" && !this.loadErrors.has(record.manifest.id)) this.activeLocal.add(record.manifest.id);
		}
	}

	/** 开发者模式是未隔离本地代码的唯一闸门；关闭后立即卸载其运行时注册。 */
	async setDeveloperMode(enabled: boolean): Promise<void> {
		await this.serialize(async () => {
			if (enabled === this.developerMode) return;
			this.developerMode = enabled;
			for (const record of this.installed.values()) {
				if (record.origin !== "local-link") continue;
				if (!enabled) {
					if (this.activeLocal.has(record.manifest.id)) this.deactivate(record.manifest);
					this.activeLocal.delete(record.manifest.id);
					this.loadErrors.set(record.manifest.id, "开发者模式未开启，本地代码 Extension 未加载");
					continue;
				}
				await this.checkLinkDrift(record);
				try {
					await this.activate(record);
					this.activeLocal.add(record.manifest.id);
				} catch (err) {
					this.loadErrors.set(record.manifest.id, err instanceof Error ? err.message : String(err));
				}
			}
		});
	}

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async readFile(): Promise<InstalledExtensionRecord[]> {
		try {
			const raw = await readFile(this.file, "utf-8");
			const parsed = JSON.parse(raw) as Partial<ExtensionsFile>;
			if (!Array.isArray(parsed.extensions)) throw new Error("registry.json 缺少 extensions 数组");
			return parsed.extensions.map((value, index) => {
				if (!value || typeof value !== "object") throw new Error(`registry.json[${index}] 不是对象`);
				const record = value as Partial<InstalledExtensionRecord>;
				if (record.origin !== "bundled" && record.origin !== "user" && record.origin !== "local-link") {
					throw new Error(`registry.json[${index}] origin 非法（支持 bundled/user/local-link）；清理旧版 registry.json`);
				}
				if (typeof record.sourcePath !== "string" || !path.isAbsolute(record.sourcePath)) {
					throw new Error(`registry.json[${index}] sourcePath 必须是绝对路径`);
				}
				if ((record.origin === "user" || record.origin === "local-link") && typeof record.digest !== "string") {
					throw new Error(`registry.json[${index}] ${record.origin} 记录缺少 digest`);
				}
				if (record.origin === "user" && !record.sourcePath.startsWith(this.packagesDir + path.sep)) {
					throw new Error(`registry.json[${index}] user 包必须位于 packages 目录内`);
				}
				const manifest = parseExtensionManifest(record.manifest);
				if (record.version !== manifest.version) throw new Error(`extension「${manifest.id}」版本记录不一致`);
				if (typeof record.installedAt !== "string" || typeof record.updatedAt !== "string") {
					throw new Error(`extension「${manifest.id}」时间记录非法`);
				}
				return { ...record, manifest } as InstalledExtensionRecord;
			});
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return [];
		}
	}

	private async writeFile(records: InstalledExtensionRecord[]): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
		await writeFile(tmp, JSON.stringify({ version: 1, extensions: records }, null, 2) + "\n", "utf-8");
		await rename(tmp, this.file);
	}

	// ---- 目录 ----

	list(kind?: ExtensionKind): CatalogEntry[] {
		const entries: CatalogEntry[] = [];
		for (const { manifest } of this.builtins.values()) {
			if (kind && manifest.kind !== kind) continue;
			entries.push({
				manifest,
				installed: true,
				origin: "builtin",
				version: manifest.version,
				loaded: !this.loadErrors.has(manifest.id),
				...(this.loadErrors.has(manifest.id) ? { loadError: this.loadErrors.get(manifest.id) } : {}),
			});
		}
		for (const record of this.installed.values()) {
			if (kind && record.manifest.kind !== kind) continue;
			entries.push({
				manifest: record.manifest,
				installed: true,
				origin: record.origin,
				version: record.version,
				...(record.versionPin ? { versionPin: record.versionPin } : {}),
				loaded: !this.loadErrors.has(record.manifest.id),
				...(this.loadErrors.has(record.manifest.id) ? { loadError: this.loadErrors.get(record.manifest.id) } : {}),
				...(this.driftedLinks.has(record.manifest.id) ? { drifted: true } : {}),
			});
		}
		return entries.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
	}

	get(id: string): CatalogEntry | undefined {
		return this.list().find((e) => e.manifest.id === id);
	}

	manifestOf(id: string): PuddingTeamsExtensionManifest | undefined {
		return this.builtins.get(id)?.manifest ?? this.installed.get(id)?.manifest;
	}

	/** 动态 probe / Session 资源装配读取已激活的 Capability 模块。 */
	capabilityModuleOf(id: string): CapabilityExtensionModule | undefined {
		return this.catalog.get(id);
	}

	// ---- builtin 注册 ----

	/** 注册代码提供的 builtin Extension（PuddingClaw Connector）。 */
	registerBuiltin(manifest: PuddingTeamsExtensionManifest, hooks: BuiltinExtensionHooks = {}, opts: { assetsDir?: string } = {}): void {
		this.builtins.set(manifest.id, { manifest, hooks, ...(opts.assetsDir ? { assetsDir: opts.assetsDir } : {}) });
		try {
			this.assertEngineCompatible(manifest);
			this.activateHooks(manifest, hooks);
		} catch (err) {
			this.loadErrors.set(manifest.id, err instanceof Error ? err.message : String(err));
		}
	}

	// ---- Connector 默认头像（manifest.connector.avatar 包内资源） ----

	/** 该 connector 是否声明了默认头像（同步，仅查 manifest，供列表装饰用）。 */
	hasConnectorAvatar(connectorId: string): boolean {
		return this.connectorAvatarSource(connectorId) !== undefined;
	}

	/** 读取 connector 默认头像资源；未声明或文件缺失返回 null。 */
	async readConnectorAvatar(connectorId: string): Promise<{ buf: Buffer; mime: string } | null> {
		const source = this.connectorAvatarSource(connectorId);
		if (!source) return null;
		try {
			const buf = await readFile(path.join(source.baseDir, source.assetPath));
			return { buf, mime: avatarMime(source.assetPath) };
		} catch {
			return null;
		}
	}

	private connectorAvatarSource(connectorId: string): { baseDir: string; assetPath: string } | undefined {
		for (const { manifest, assetsDir } of this.builtins.values()) {
			if (manifest.kind === "connector" && manifest.connector.id === connectorId && manifest.connector.avatar && assetsDir) {
				return { baseDir: assetsDir, assetPath: manifest.connector.avatar };
			}
		}
		for (const record of this.installed.values()) {
			if (record.manifest.kind === "connector" && record.manifest.connector.id === connectorId && record.manifest.connector.avatar) {
				return { baseDir: record.sourcePath, assetPath: record.manifest.connector.avatar };
			}
		}
		return undefined;
	}

	// ---- 安装 / 更新 / 卸载 ----

	/**
	 * 第一方预置包（仓库内 extensions/connectors/*，§9.5 双宿主包）：
	 * 未安装则安装；已安装则从发行投影（当前解析出的包路径）重读 manifest
	 * 与模块，并把 sourcePath 自愈更新为最新解析结果——bundled 记录以
	 * manifest id+版本为事实，旧绝对路径失效不阻断启动。
	 * 与 user/local-link 同 id 冲突时拒绝，不静默覆盖。
	 */
	async installOrUpdateFromDir(dirPath: string): Promise<CatalogEntry> {
		return this.serialize(async () => {
			const { manifest, record } = await this.loadFromDir(dirPath, { origin: "bundled" });
			const existing = this.installed.get(manifest.id);
			if (!existing) {
				if (this.builtins.has(manifest.id)) {
					throw new Error(`extension「${manifest.id}」是 builtin，不能用路径预置覆盖`);
				}
				await this.activate(record);
				this.installed.set(manifest.id, record);
				await this.writeFile([...this.installed.values()]);
			} else {
				if (existing.origin !== "bundled") {
					throw new Error(
						`extension「${manifest.id}」已以${ORIGIN_LABELS[existing.origin]}来源安装；来源三态互不覆盖，请先显式卸载`,
					);
				}
				await this.replaceInstalled(existing, record);
			}
			return this.get(manifest.id)!;
		});
	}

	/**
	 * 开发者本地链接安装（local-link，文档 §8.3）：只登记规范化绝对路径 +
	 * 最近 digest，不复制源码；仅在开发者模式可用。
	 */
	async install(dirPath: string, opts: { versionPin?: string } = {}): Promise<CatalogEntry> {
		return this.serialize(async () => {
			if (!this.developerMode) throw new Error("本地 Extension 安装仅在开发者模式下可用");
			const { manifest, record } = await this.loadFromDir(dirPath, { ...opts, origin: "local-link" });
			if (this.builtins.has(manifest.id)) {
				throw new Error(`extension「${manifest.id}」是 builtin，不能用本地链接覆盖`);
			}
			const existing = this.installed.get(manifest.id);
			if (existing) {
				if (existing.origin !== "local-link") {
					throw new Error(
						`extension「${manifest.id}」已以${ORIGIN_LABELS[existing.origin]}来源安装；来源三态互不覆盖，请先显式卸载`,
					);
				}
				throw new Error(`extension「${manifest.id}」已安装；升级请用 update`);
			}
			await this.activate(record);
			this.activeLocal.add(manifest.id);
			this.installed.set(manifest.id, record);
			await this.writeFile([...this.installed.values()]);
			return this.get(manifest.id)!;
		});
	}

	/**
	 * 用户安装（user，文档 §8.2）：staging 复制到 packages/<id>/<version>/ →
	 * 校验 manifest/engines/permissions → 记录 digest 并原子切换 registry。
	 * 任一步失败清理 staging/目标目录，不留半成品。
	 */
	async installUserPackage(sourceDir: string, opts: { versionPin?: string } = {}): Promise<CatalogEntry> {
		return this.serialize(async () => {
			const dir = path.resolve(sourceDir);
			// manifest 读取与校验与 CLI validate 共用 readManifestFromDir（extensions.ts）。
			const manifest = await readManifestFromDir(dir);
			this.assertEngineCompatible(manifest);
			if (opts.versionPin && manifest.version !== opts.versionPin) {
				throw new Error(`已固定版本 ${opts.versionPin}，目录中的版本 ${manifest.version} 不匹配`);
			}
			if (this.builtins.has(manifest.id)) {
				throw new Error(`extension「${manifest.id}」是 builtin，不能安装同 id 用户包`);
			}
			const existing = this.installed.get(manifest.id);
			if (existing) {
				if (existing.origin !== "user") {
					throw new Error(
						`extension「${manifest.id}」已以${ORIGIN_LABELS[existing.origin]}来源安装；来源三态互不覆盖，请先显式卸载`,
					);
				}
				throw new Error(`extension「${manifest.id}」已安装；升级请用 update`);
			}
			const staged = await this.stageUserPackage(dir, manifest.id, manifest.version);
			const now = new Date().toISOString();
			const record: InstalledExtensionRecord = {
				manifest,
				origin: "user",
				sourcePath: staged.finalDir,
				digest: staged.digest,
				installedAt: now,
				updatedAt: now,
				version: manifest.version,
				...(opts.versionPin ? { versionPin: opts.versionPin } : {}),
			};
			try {
				await this.activate(record);
				this.installed.set(manifest.id, record);
				await this.writeFile([...this.installed.values()]);
			} catch (err) {
				this.installed.delete(manifest.id);
				this.deactivate(manifest);
				this.loadErrors.delete(manifest.id);
				await rm(staged.finalDir, { recursive: true, force: true }).catch(() => undefined);
				throw err;
			}
			return this.get(manifest.id)!;
		});
	}

	/**
	 * 更新已安装 Extension：local-link 从原路径（或新路径）重读；user 必须给
	 * 新来源目录，走 staging 复制 + 原子切换，失败保留旧版本目录与记录；
	 * bundled 随发行物升级，不能用外部路径更新。
	 * 固定版本（versionPin）时新版本必须等于 pin，否则拒绝（不静默换版）。
	 */
	async update(id: string, opts: { path?: string; versionPin?: string } = {}): Promise<CatalogEntry> {
		return this.serialize(async () => {
			const existing = this.installed.get(id);
			if (!existing) throw new Error(`extension not installed: ${id}`);
			if (existing.origin === "bundled") {
				throw new Error(`bundled extension「${id}」随发行物升级，不能用路径更新`);
			}
			const pin = opts.versionPin ?? existing.versionPin;
			if (existing.origin === "user") {
				if (!opts.path) throw new Error(`user extension「${id}」更新必须提供来源目录 path`);
				await this.updateUserPackage(existing, opts.path, pin);
				return this.get(id)!;
			}
			if (!this.developerMode) {
				throw new Error("本地 Extension 更新仅在开发者模式下可用");
			}
			const dir = opts.path ?? existing.sourcePath;
			const { manifest, record } = await this.loadFromDir(dir, { versionPin: pin, origin: "local-link" });
			if (manifest.id !== id) throw new Error(`目录中的 manifest id「${manifest.id}」与「${id}」不一致`);
			if (pin && manifest.version !== pin) {
				throw new Error(`extension「${id}」已固定版本 ${pin}，目录中的版本 ${manifest.version} 不匹配`);
			}
			await this.replaceInstalled(existing, record);
			return this.get(id)!;
		});
	}

	/**
	 * 卸载：移除模块注册与持久化记录；user 包同时删除 packages/<id>/ 目录。
	 * 启用 Agent / active Run 的保护判断在路由层完成（§9.3.8）；
	 * builtin/bundled 不可卸载。
	 */
	async uninstall(id: string): Promise<void> {
		await this.serialize(async () => {
			if (this.builtins.has(id)) throw new Error(`builtin extension「${id}」不可卸载`);
			const record = this.installed.get(id);
			if (!record) throw new Error(`extension not installed: ${id}`);
			if (record.origin === "bundled") throw new Error(`bundled extension「${id}」随发行物预置，不可卸载`);
			if (record.origin === "local-link" && !this.developerMode) {
				throw new Error("本地 Extension 卸载仅在开发者模式下可用");
			}
			this.deactivate(record.manifest);
			this.activeHooks.delete(id);
			this.activeLocal.delete(id);
			this.driftedLinks.delete(id);
			this.installed.delete(id);
			this.loadErrors.delete(id);
			await this.writeFile([...this.installed.values()]);
			if (record.origin === "user") {
				await rm(path.join(this.packagesDir, id), { recursive: true, force: true }).catch(() => undefined);
			}
		});
	}

	// ---- 内部：读目录 / 激活 / 卸载模块 ----

	private async loadFromDir(
		dirPath: string,
		opts: { versionPin?: string; origin: ExtensionOrigin },
	): Promise<{ manifest: PuddingTeamsExtensionManifest & { entry?: string }; record: InstalledExtensionRecord }> {
		const dir = path.resolve(dirPath);
		// manifest 读取与校验与 CLI validate 共用 readManifestFromDir（extensions.ts）。
		const manifest = await readManifestFromDir(dir);
		this.assertEngineCompatible(manifest);
		if (opts.versionPin && manifest.version !== opts.versionPin) {
			throw new Error(`已固定版本 ${opts.versionPin}，目录中的版本 ${manifest.version} 不匹配`);
		}
		const now = new Date().toISOString();
		return {
			manifest,
			record: {
				manifest,
				origin: opts.origin,
				sourcePath: dir,
				// bundled 以 manifest id+版本为事实，不记 digest。
				...(opts.origin === "local-link" ? { digest: await computePackageDigest(dir) } : {}),
				installedAt: now,
				updatedAt: now,
				version: manifest.version,
				...(opts.versionPin ? { versionPin: opts.versionPin } : {}),
			},
		};
	}

	/** staging 复制 → digest → 原子落位 packages/<id>/<version>/；失败清理 staging。 */
	private async stageUserPackage(sourceDir: string, id: string, version: string): Promise<{ finalDir: string; digest: string }> {
		const finalDir = path.join(this.packagesDir, id, version);
		const stagingDir = path.join(this.packagesDir, `.staging-${randomUUID().slice(0, 8)}`);
		try {
			await copyPackageDir(sourceDir, stagingDir);
			const digest = await computePackageDigest(stagingDir);
			await rm(finalDir, { recursive: true, force: true });
			await mkdir(path.dirname(finalDir), { recursive: true });
			await rename(stagingDir, finalDir);
			return { finalDir, digest };
		} catch (err) {
			await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
			throw err;
		}
	}

	/**
	 * user 包更新：staging 校验后原子切换 registry 记录。目标版本目录与当前
	 * 激活版本相同（同版本重装）时先把旧目录改名备份，切换失败恢复；不同
	 * 版本则旧版本目录原样保留。
	 */
	private async updateUserPackage(
		existing: InstalledExtensionRecord,
		sourceDir: string,
		pin: string | undefined,
	): Promise<void> {
		const dir = path.resolve(sourceDir);
		const manifest = await readManifestFromDir(dir);
		this.assertEngineCompatible(manifest);
		const id = existing.manifest.id;
		if (manifest.id !== id) throw new Error(`目录中的 manifest id「${manifest.id}」与「${id}」不一致`);
		if (pin && manifest.version !== pin) {
			throw new Error(`extension「${id}」已固定版本 ${pin}，目录中的版本 ${manifest.version} 不匹配`);
		}
		const staged = await this.stageUserPackageForUpdate(dir, existing, manifest.version);
		const record: InstalledExtensionRecord = {
			manifest,
			origin: "user",
			sourcePath: staged.finalDir,
			digest: staged.digest,
			installedAt: existing.installedAt,
			updatedAt: new Date().toISOString(),
			version: manifest.version,
			...(pin ? { versionPin: pin } : {}),
		};
		try {
			await this.replaceInstalled(existing, record);
		} catch (err) {
			// 记录仍指向旧 sourcePath：清掉新目录并恢复备份（如有）。
			await rm(staged.finalDir, { recursive: true, force: true }).catch(() => undefined);
			if (staged.backupDir) {
				await rename(staged.backupDir, staged.finalDir).catch(() => undefined);
			}
			throw err;
		}
		if (staged.backupDir) await rm(staged.backupDir, { recursive: true, force: true }).catch(() => undefined);
	}

	private async stageUserPackageForUpdate(
		sourceDir: string,
		existing: InstalledExtensionRecord,
		version: string,
	): Promise<{ finalDir: string; digest: string; backupDir?: string }> {
		const finalDir = path.join(this.packagesDir, existing.manifest.id, version);
		const stagingDir = path.join(this.packagesDir, `.staging-${randomUUID().slice(0, 8)}`);
		let backupDir: string | undefined;
		try {
			await copyPackageDir(sourceDir, stagingDir);
			const digest = await computePackageDigest(stagingDir);
			if (finalDir === existing.sourcePath) {
				backupDir = `${finalDir}.backup-${randomUUID().slice(0, 8)}`;
				await rename(finalDir, backupDir);
			} else {
				await rm(finalDir, { recursive: true, force: true });
			}
			await mkdir(path.dirname(finalDir), { recursive: true });
			await rename(stagingDir, finalDir);
			return backupDir ? { finalDir, digest, backupDir } : { finalDir, digest };
		} catch (err) {
			await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
			if (backupDir) await rename(backupDir, finalDir).catch(() => undefined);
			throw err;
		}
	}

	/** local-link 漂移检测：源目录 digest 与登记值不一致时标记（提示用，不阻断）。 */
	private async checkLinkDrift(record: InstalledExtensionRecord): Promise<void> {
		if (record.origin !== "local-link" || !record.digest) return;
		try {
			const digest = await computePackageDigest(record.sourcePath);
			if (digest === record.digest) this.driftedLinks.delete(record.manifest.id);
			else this.driftedLinks.add(record.manifest.id);
		} catch {
			this.driftedLinks.delete(record.manifest.id);
		}
	}

	private assertEngineCompatible(manifest: PuddingTeamsExtensionManifest): void {
		const range = manifest.engines.puddingteams;
		if (!semver.satisfies(this.hostVersion, range, { includePrerelease: true })) {
			throw new Error(
				`extension「${manifest.id}」要求 PuddingTeams ${range}，当前宿主版本为 ${this.hostVersion}`,
			);
		}
	}

	/** 先加载并验证新模块，但不触碰当前运行时注册；用于事务化更新。 */
	private async prepareActivation(record: InstalledExtensionRecord): Promise<BuiltinExtensionHooks | null> {
		const { manifest } = record;
		this.assertEngineCompatible(manifest);
		if (!manifest.entry) {
			if (manifest.kind === "capability") {
				throw new Error(`capability extension「${manifest.id}」缺少 entry 模块入口`);
			}
			// 无 entry 的声明式 Connector（§10.3 第 1 级）：核心 DeclarativeDriver
			// 按 manifest 声明执行 spawn/解码/归一，包内不需要任何代码。
			if (manifest.connector.declarative) {
				return {
					driverFactory: createDeclarativeDriverFactory(manifest.connector.id, manifest.connector.declarative!, {
						packageDir: record.sourcePath,
					}),
				};
			}
			// 既无 entry 又无 declarative 的 manifest-only 包：只登记目录，不注册 driver。
			return null;
		}
		const entryPath = path.join(record.sourcePath, manifest.entry);
		const moduleUrl = new URL(pathToFileURL(entryPath).href);
		const activationCount = this.moduleActivationCounts.get(manifest.id) ?? 0;
		if (activationCount > 0) moduleUrl.searchParams.set("puddingteams", `${record.updatedAt}-${activationCount}`);
		const mod = (await import(moduleUrl.href)) as LoadedModule;
		this.moduleActivationCounts.set(manifest.id, activationCount + 1);
		const inner = (mod.default ?? {}) as LoadedModule | CapabilityExtensionModule;
		const createDriver = mod.createDriver ?? (inner as LoadedModule).createDriver;
		const driver = mod.driver ?? (inner as LoadedModule).driver;
		const extension =
			mod.extension ?? ((inner as CapabilityExtensionModule).register ? (inner as CapabilityExtensionModule) : undefined);
		const hooks: BuiltinExtensionHooks = {
			...(createDriver ? { driverFactory: createDriver } : {}),
			...(driver ? { driver } : {}),
			...(extension ? { capabilityModule: extension } : {}),
		};
		this.validateHooks(manifest, hooks);
		return hooks;
	}

	/** 加载并注册模块（capability→ExtensionCatalog，connector→DriverRegistry）。 */
	private async activate(record: InstalledExtensionRecord): Promise<void> {
		const hooks = await this.prepareActivation(record);
		this.activatePrepared(record.manifest, hooks);
	}

	private activatePrepared(manifest: PuddingTeamsExtensionManifest, hooks: BuiltinExtensionHooks | null): void {
		if (hooks) this.activateHooks(manifest, hooks);
		this.activeHooks.set(manifest.id, hooks);
		this.loadErrors.delete(manifest.id);
	}

	private validateHooks(manifest: PuddingTeamsExtensionManifest, hooks: BuiltinExtensionHooks): void {
		if (manifest.kind === "capability") {
			const module = hooks.capabilityModule;
			if (!module) throw new Error(`capability extension「${manifest.id}」未导出 CapabilityExtensionModule`);
			if (module.manifest.id !== manifest.id) {
				throw new Error(`模块 manifest.id「${module.manifest.id}」与包 manifest 不一致`);
			}
			return;
		}
		if (!hooks.driverFactory && !hooks.driver) {
			throw new Error(`connector extension「${manifest.id}」未导出 createDriver/driver`);
		}
		if (manifest.connector.supportedTransports.length > 1 && !hooks.driverFactory) {
			throw new Error(`多 transport connector extension「${manifest.id}」必须导出 createDriver(config, transport)`);
		}
		if (hooks.driver && hooks.driver.id !== manifest.connector.id) {
			throw new Error(`Driver id「${hooks.driver.id}」与 connector id「${manifest.connector.id}」不一致`);
		}
	}

	private activateHooks(manifest: PuddingTeamsExtensionManifest, hooks: BuiltinExtensionHooks): void {
		this.validateHooks(manifest, hooks);
		if (manifest.kind === "capability") {
			const module = hooks.capabilityModule;
			if (!module) throw new Error(`capability extension「${manifest.id}」未导出 CapabilityExtensionModule`);
			if (module.manifest.id !== manifest.id) {
				throw new Error(`模块 manifest.id「${module.manifest.id}」与包 manifest 不一致`);
			}
			this.activateContribution(manifest, () => this.catalog.register(module));
			return;
		}
		// connector：优先工厂（同 Connector 多 Agent 实例），其次 Driver 单例。
		if (hooks.driverFactory) {
			this.activateContribution(manifest, () => this.drivers.registerFactory(manifest.connector.id, hooks.driverFactory!, manifest.id));
		} else if (hooks.driver) {
			if (hooks.driver.id !== manifest.connector.id) {
				throw new Error(`Driver id「${hooks.driver.id}」与 connector id「${manifest.connector.id}」不一致`);
			}
			this.activateContribution(manifest, () => this.drivers.register(hooks.driver!, manifest.id));
		} else {
			throw new Error(`connector extension「${manifest.id}」未导出 createDriver/driver`);
		}
	}

	/**
	 * 新模块先完成 import/导出校验，再替换运行时贡献；激活或持久化任一步失败，
	 * 都恢复旧 runtime hooks、旧 installed 记录和开发者模式激活状态。
	 */
	private async replaceInstalled(existing: InstalledExtensionRecord, candidate: InstalledExtensionRecord): Promise<void> {
		const id = existing.manifest.id;
		const candidateHooks = await this.prepareActivation(candidate);
		const hadOldHooks = this.activeHooks.has(id);
		const oldHooks = this.activeHooks.get(id) ?? null;
		const wasActiveLocal = this.activeLocal.has(id);
		const replacement = { ...candidate, installedAt: existing.installedAt };

		this.deactivate(existing.manifest);
		try {
			this.activatePrepared(candidate.manifest, candidateHooks);
			this.installed.set(id, replacement);
			if (existing.origin === "local-link") this.activeLocal.add(id);
			this.driftedLinks.delete(id);
			await this.writeFile([...this.installed.values()]);
		} catch (err) {
			this.deactivate(candidate.manifest);
			this.installed.set(id, existing);
			if (wasActiveLocal) this.activeLocal.add(id);
			else this.activeLocal.delete(id);
			try {
				if (hadOldHooks) this.activatePrepared(existing.manifest, oldHooks);
				else this.loadErrors.set(id, "旧版本原本未激活；更新失败后保持未激活状态");
			} catch (rollbackError) {
				this.loadErrors.set(id, rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
				throw new AggregateError([err, rollbackError], `extension「${id}」更新失败，且旧版本恢复失败`);
			}
			throw err;
		}
	}

	private contributionKey(manifest: PuddingTeamsExtensionManifest): string {
		return manifest.kind === "capability"
			? `capability:${manifest.id}`
			: `connector:${manifest.connector.id}`;
	}

	private activateContribution(manifest: PuddingTeamsExtensionManifest, register: () => void): void {
		const key = this.contributionKey(manifest);
		const owner = this.contributionOwners.get(key);
		if (owner) throw new Error(`运行时贡献「${key}」已由 extension「${owner}」占用`);
		register();
		this.contributionOwners.set(key, manifest.id);
	}

	private deactivate(manifest: PuddingTeamsExtensionManifest): void {
		const key = this.contributionKey(manifest);
		if (this.contributionOwners.get(key) !== manifest.id) return;
		if (manifest.kind === "capability") this.catalog.unregister(manifest.id);
		else this.drivers.unregister(manifest.connector.id);
		this.contributionOwners.delete(key);
	}
}
