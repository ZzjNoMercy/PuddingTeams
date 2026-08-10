import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
 * Phase 5：Extension 持久化目录与安装（方案 §9.3/§10，决策 16）。
 *
 * - 目录项 = 平台内置（builtin，代码提供，第一版唯一预装：PuddingClaw
 *   Connector；用户 Capability 预装零个）+ 本地安装的 Extension
 *   （持久化在 `<teamsDir>/extensions.json`）；
 * - 安装来源本地路径：读 `pudding-extension.json`、校验 kind/engines/
 *   permissions，capability 模块进程内注册进 ExtensionCatalog，connector
 *   注册进 DriverRegistry（隔离 Extension Host 是 Phase 6，本期进程内）；
 * - 卸载不做静默回退：有启用 Agent 或 active/waiting Run 的保护判断在
 *   路由层（409），这里只负责移除模块与记录；对应 Agent 保留绑定，
 *   调用时进入 connector_missing。
 */

/** 已安装 Extension 的持久化记录（builtin 不落盘）。 */
export interface InstalledExtensionRecord {
	manifest: PuddingTeamsExtensionManifest & { entry?: string };
	/** bundled=随发行物审核的第一方包；local=开发者模式本地路径。 */
	origin: "bundled" | "local";
	sourcePath: string;
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
	origin: "builtin" | "bundled" | "local";
	version: string;
	versionPin?: string;
	/** 模块/driver 已注册进运行时（重启后重载失败为 false）。 */
	loaded: boolean;
	loadError?: string;
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
	/** Runtime contribution key -> owning package manifest id. */
	private readonly contributionOwners = new Map<string, string>();
	private readonly moduleActivationCounts = new Map<string, number>();
	/** 最近一次成功激活的运行时对象；更新失败时不依赖已被覆盖的源目录即可恢复。 */
	private readonly activeHooks = new Map<string, BuiltinExtensionHooks | null>();

	constructor(
		teamsDir: string,
		private readonly catalog: ExtensionCatalog,
		private readonly drivers: DriverRegistry,
		private readonly hostVersion = PUDDINGTEAMS_HOST_VERSION,
	) {
		this.file = path.join(teamsDir, "extensions.json");
	}

	/** 落盘目录 + 重新注册上次安装的本地 Extension（重启恢复）。 */
	async init(opts: { developerMode?: boolean } = {}): Promise<void> {
		this.developerMode = opts.developerMode === true;
		for (const record of await this.readFile()) {
			this.installed.set(record.manifest.id, record);
			if (record.origin === "local" && !this.developerMode) {
				this.loadErrors.set(record.manifest.id, "开发者模式未开启，本地代码 Extension 未加载");
				continue;
			}
			await this.activate(record).catch((err: unknown) => {
				this.loadErrors.set(record.manifest.id, err instanceof Error ? err.message : String(err));
			});
			if (record.origin === "local" && !this.loadErrors.has(record.manifest.id)) this.activeLocal.add(record.manifest.id);
		}
	}

	/** 开发者模式是未隔离本地代码的唯一闸门；关闭后立即卸载其运行时注册。 */
	async setDeveloperMode(enabled: boolean): Promise<void> {
		await this.serialize(async () => {
			if (enabled === this.developerMode) return;
			this.developerMode = enabled;
			for (const record of this.installed.values()) {
				if (record.origin !== "local") continue;
				if (!enabled) {
					if (this.activeLocal.has(record.manifest.id)) this.deactivate(record.manifest);
					this.activeLocal.delete(record.manifest.id);
					this.loadErrors.set(record.manifest.id, "开发者模式未开启，本地代码 Extension 未加载");
					continue;
				}
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
			if (!Array.isArray(parsed.extensions)) throw new Error("extensions.json 缺少 extensions 数组");
			return parsed.extensions.map((value, index) => {
				if (!value || typeof value !== "object") throw new Error(`extensions.json[${index}] 不是对象`);
				const record = value as Partial<InstalledExtensionRecord>;
				if (record.origin !== "bundled" && record.origin !== "local") {
					throw new Error(`extensions.json[${index}] origin 非法；清理 pre-developer-mode 数据`);
				}
				if (typeof record.sourcePath !== "string" || !path.isAbsolute(record.sourcePath)) {
					throw new Error(`extensions.json[${index}] sourcePath 必须是绝对路径`);
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
	 * 未安装则安装；已安装则从同一路径重读 manifest 与模块（更新到最新代码）。
	 * 每次启动调用，保证仓库代码改动即时生效；builtin 同 id 拒绝覆盖。
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
			} else {
				await this.replaceInstalled(existing, record);
			}
			if (!existing) await this.writeFile([...this.installed.values()]);
			return this.get(manifest.id)!;
		});
	}

	/** 从本地目录安装：读 manifest、校验、加载模块、持久化记录。 */
	async install(dirPath: string, opts: { versionPin?: string } = {}): Promise<CatalogEntry> {
		return this.serialize(async () => {
			if (!this.developerMode) throw new Error("本地 Extension 安装仅在开发者模式下可用");
			const { manifest, record } = await this.loadFromDir(dirPath, { ...opts, origin: "local" });
			if (this.builtins.has(manifest.id) || this.installed.has(manifest.id)) {
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
	 * 更新已安装 Extension：从原路径（或新路径）重读 manifest 与模块。
	 * 固定版本（versionPin）时新版本必须等于 pin，否则拒绝（不静默换版）。
	 */
	async update(id: string, opts: { path?: string; versionPin?: string } = {}): Promise<CatalogEntry> {
		return this.serialize(async () => {
			const existing = this.installed.get(id);
			if (!existing) throw new Error(`extension not installed: ${id}`);
			if (existing.origin === "local" && !this.developerMode) {
				throw new Error("本地 Extension 更新仅在开发者模式下可用");
			}
			const dir = opts.path ?? existing.sourcePath;
			const pin = opts.versionPin ?? existing.versionPin;
			const { manifest, record } = await this.loadFromDir(dir, { versionPin: pin, origin: existing.origin });
			if (manifest.id !== id) throw new Error(`目录中的 manifest id「${manifest.id}」与「${id}」不一致`);
			if (pin && manifest.version !== pin) {
				throw new Error(`extension「${id}」已固定版本 ${pin}，目录中的版本 ${manifest.version} 不匹配`);
			}
			await this.replaceInstalled(existing, record);
			return this.get(id)!;
		});
	}

	/**
	 * 卸载：移除模块注册与持久化记录。启用 Agent / active Run 的保护判断
	 * 在路由层完成（§9.3.8）；builtin 不可卸载。
	 */
	async uninstall(id: string): Promise<void> {
		await this.serialize(async () => {
			if (this.builtins.has(id)) throw new Error(`builtin extension「${id}」不可卸载`);
			const record = this.installed.get(id);
			if (!record) throw new Error(`extension not installed: ${id}`);
			if (record.origin === "local" && !this.developerMode) {
				throw new Error("本地 Extension 卸载仅在开发者模式下可用");
			}
			this.deactivate(record.manifest);
			this.activeHooks.delete(id);
			this.activeLocal.delete(id);
			this.installed.delete(id);
			this.loadErrors.delete(id);
			await this.writeFile([...this.installed.values()]);
		});
	}

	// ---- 内部：读目录 / 激活 / 卸载模块 ----

	private async loadFromDir(
		dirPath: string,
		opts: { versionPin?: string; origin?: "bundled" | "local" },
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
				origin: opts.origin ?? "local",
				sourcePath: dir,
				installedAt: now,
				updatedAt: now,
				version: manifest.version,
				...(opts.versionPin ? { versionPin: opts.versionPin } : {}),
			},
		};
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
					driverFactory: (config) =>
						createDeclarativeDriverFactory(manifest.connector.id, manifest.connector.declarative!, {
							packageDir: record.sourcePath,
						})(config),
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
			if (existing.origin === "local") this.activeLocal.add(id);
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
