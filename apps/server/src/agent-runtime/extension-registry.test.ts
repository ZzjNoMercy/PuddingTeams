import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseExtensionManifest, ExtensionCatalog, EXTENSION_MANIFEST_FILE } from "./extensions.js";
import { DriverRegistry } from "./driver-registry.js";
import { ExtensionRegistry } from "./extension-registry.js";
import { puddingClawConnectorManifest, puddingClawExtensionHooks } from "./puddingclaw-extension.js";
import type { AgentDriver, DriverCapabilities } from "./types.js";

/**
 * Phase 5：Extension manifest 校验与持久化目录（§10）——kind 判别与混包
 * 禁止、本地安装/更新/版本固定/卸载、重启后重载。
 */

function freshDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function capabilityManifest(version = "1.0.0"): Record<string, unknown> {
	return {
		id: "cap-ext",
		publisher: "test",
		displayName: "测试 Capability",
		version,
		source: "external",
		kind: "capability",
		engines: { puddingteams: ">=1 <2" },
		permissions: ["workspace"],
		entry: "index.mjs",
		capability: {
			id: "cap-ext",
			displayName: "测试 Capability",
			apiVersion: "1",
			tools: [{ name: "do_thing", activation: "always", description: "做一件事" }],
		},
	};
}

const CAPABILITY_ENTRY = `export const extension = {
	manifest: { id: "cap-ext", kind: "capability", name: "测试 Capability", version: "1", tools: [{ name: "do_thing", activation: "always" }] },
	register(ctx) {},
};
`;

function connectorManifest(version = "1.0.0"): Record<string, unknown> {
	return {
		id: "conn-ext",
		publisher: "test",
		displayName: "测试 Connector",
		version,
		source: "external",
		kind: "connector",
		engines: { puddingteams: ">=1 <2" },
		permissions: ["spawn", "secrets"],
		entry: "index.mjs",
		connector: {
			id: "conn-ext",
			displayName: "测试 Connector",
			apiVersion: "1",
			defaultTransport: "spawn",
			supportedTransports: ["spawn"],
		},
	};
}

const CONNECTOR_ENTRY = `export function createDriver(config) {
	return {
		id: "conn-ext",
		async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn" }; },
		async *run() {},
		async *continue() {},
		async *respond() {},
		async probe() { return { extensionInstalled: true, detected: true, configured: true, authenticated: "unknown", enabled: true, compatibility: "supported", capabilities: { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn" }, issues: [] }; },
	};
}
`;

const STATIC_CONNECTOR_ENTRY = `export const driver = {
	id: "conn-ext",
	async capabilities() { return { operations: ["run"], interactionKinds: [], progress: "none", transport: "spawn" }; },
	async *run() {}, async *continue() {}, async *respond() {},
	async probe() { return { extensionInstalled: true, detected: true, configured: true, authenticated: "unknown", enabled: true, compatibility: "supported", capabilities: await this.capabilities(), issues: [] }; },
};
`;

function writeExtension(dir: string, manifest: Record<string, unknown>, entryCode?: string): string {
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, EXTENSION_MANIFEST_FILE), JSON.stringify(manifest, null, 2));
	if (entryCode !== undefined) writeFileSync(path.join(dir, "index.mjs"), entryCode);
	return dir;
}

test("Phase5: manifest 校验——禁止混包、kind/engines/permissions 必须合法", () => {
	// 混包禁止（§10）。
	assert.throws(() => parseExtensionManifest({ ...capabilityManifest(), connector: {} }), /同时贡献/);
	// kind 判别。
	assert.throws(() => parseExtensionManifest({ ...capabilityManifest(), kind: "both" }), /kind/);
	// engines 必须声明。
	const noEngines = capabilityManifest();
	delete noEngines.engines;
	assert.throws(() => parseExtensionManifest(noEngines), /engines/);
	assert.throws(
		() => parseExtensionManifest({ ...capabilityManifest(), engines: { puddingteams: "definitely-not-semver" } }),
		/合法 semver range/,
	);
	// permissions 白名单。
	assert.throws(
		() => parseExtensionManifest({ ...capabilityManifest(), permissions: ["root-access"] }),
		/未知权限/,
	);
	// connector contribution 完整性。
	assert.throws(
		() => parseExtensionManifest({ ...connectorManifest(), connector: { id: "x", apiVersion: "1", defaultTransport: "http", supportedTransports: ["spawn"] } }),
		/defaultTransport 必须包含/,
	);
	const httpWithoutNetwork = connectorManifest();
	httpWithoutNetwork.permissions = ["spawn"];
	httpWithoutNetwork.connector = {
		...(httpWithoutNetwork.connector as Record<string, unknown>),
		supportedTransports: ["spawn", "http"],
	};
	assert.throws(() => parseExtensionManifest(httpWithoutNetwork), /network/);
	const invalidScopedField = connectorManifest();
	invalidScopedField.connector = {
		...(invalidScopedField.connector as Record<string, unknown>),
		configSchema: {
			type: "object",
			properties: { endpoint: { type: "string", "x-puddingteams-transports": ["http"] } },
		},
	};
	assert.throws(() => parseExtensionManifest(invalidScopedField), /未支持的 transport/);
	const declarativeHttp = connectorManifest();
	declarativeHttp.entry = undefined;
	declarativeHttp.permissions = ["spawn", "network"];
	declarativeHttp.connector = {
		...(declarativeHttp.connector as Record<string, unknown>),
		supportedTransports: ["spawn", "http"],
		declarative: {
			command: "demo",
			operations: { run: { args: ["run"] } },
			output: { mode: "single-json" },
			capabilities: { operations: ["run"], interactionKinds: [] },
		},
	};
	assert.throws(() => parseExtensionManifest(declarativeHttp), /当前只支持唯一 transport:"spawn"/);
	// 合法 manifest 通过并归一化。
	const parsed = parseExtensionManifest(capabilityManifest());
	assert.equal(parsed.kind, "capability");
	assert.equal(parsed.entry, "index.mjs");
	const conn = parseExtensionManifest(connectorManifest());
	assert.equal(conn.kind, "connector");
});

test("P3-0: 安装与启用强制校验 engines.puddingteams 和宿主版本", async () => {
	const dir = freshDir("pt-engine-gate-");
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), drivers, "0.1.0");
	await registry.init({ developerMode: true });
	const incompatible = {
		...connectorManifest(),
		engines: { puddingteams: ">=2" },
	};
	const extDir = writeExtension(path.join(dir, "incompatible"), incompatible, CONNECTOR_ENTRY);

	await assert.rejects(() => registry.install(extDir), /要求 PuddingTeams >=2.*当前宿主版本为 0\.1\.0/);
	assert.equal(registry.get("conn-ext"), undefined);
	assert.equal(drivers.create("conn-ext", "spawn", {}), undefined);
});

test("Phase5: 本地安装 capability/connector 并注册进目录", async () => {
	const dir = freshDir("pt-p5-reg-");
	const catalog = new ExtensionCatalog();
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(dir, catalog, drivers);
	await registry.init({ developerMode: true });

	const capDir = writeExtension(path.join(dir, "ext-cap"), capabilityManifest(), CAPABILITY_ENTRY);
	const cap = await registry.install(capDir);
	assert.equal(cap.manifest.kind, "capability");
	assert.equal(cap.origin, "local-link");
	assert.equal(cap.loaded, true);
	assert.ok(catalog.get("cap-ext"), "capability 模块必须注册进 ExtensionCatalog");

	const connDir = writeExtension(path.join(dir, "ext-conn"), connectorManifest(), CONNECTOR_ENTRY);
	await registry.install(connDir);
	const driver = drivers.create("conn-ext", "spawn", {});
	assert.ok(driver, "connector 必须注册 Driver factory 进 DriverRegistry");

	// 重复安装同 id 拒绝。
	await assert.rejects(() => registry.install(capDir), /已安装/);

	// 目录按 kind 过滤。
	const caps = registry.list("capability");
	assert.equal(caps.length, 1);
	assert.equal(caps[0]!.manifest.id, "cap-ext");
	assert.equal(registry.list("connector").length, 1);
});

test("Connector transport 契约：多 transport 代码包必须导出按 binding 构造的 factory", async () => {
	const dir = freshDir("pt-multi-transport-");
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), new DriverRegistry());
	await registry.init({ developerMode: true });
	const manifest = connectorManifest();
	manifest.permissions = ["spawn", "network"];
	manifest.connector = {
		...(manifest.connector as Record<string, unknown>),
		supportedTransports: ["spawn", "http"],
	};
	const packageDir = writeExtension(path.join(dir, "multi-static"), manifest, STATIC_CONNECTOR_ENTRY);
	await assert.rejects(() => registry.install(packageDir), /多 transport.*必须导出 createDriver/);
});

test("P3-0: 本地代码 Extension 受开发者模式闸门控制，关闭后立即停止加载", async () => {
	const dir = freshDir("pt-dev-mode-");
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), drivers);
	await registry.init();
	const connDir = writeExtension(path.join(dir, "ext-conn"), connectorManifest(), CONNECTOR_ENTRY);

	await assert.rejects(() => registry.install(connDir), /开发者模式/);
	await registry.setDeveloperMode(true);
	const installed = await registry.install(connDir);
	assert.equal(installed.origin, "local-link");
	assert.ok(drivers.create("conn-ext", "spawn", {}));

	await registry.setDeveloperMode(false);
	assert.equal(drivers.create("conn-ext", "spawn", {}), undefined, "关闭后本地 Driver 必须从运行时撤下");
	assert.equal(registry.get("conn-ext")?.loaded, false);
	assert.match(registry.get("conn-ext")?.loadError ?? "", /开发者模式未开启/);
});

test("P3-0: install 与关闭开发者模式串行化，关闭后不会留下迟到激活", async () => {
	const dir = freshDir("pt-dev-race-");
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), drivers);
	await registry.init({ developerMode: true });
	const slowEntry = `await new Promise((resolve) => setTimeout(resolve, 40));\n${CONNECTOR_ENTRY}`;
	const connDir = writeExtension(path.join(dir, "slow"), connectorManifest(), slowEntry);

	const installing = registry.install(connDir);
	const disabling = registry.setDeveloperMode(false);
	await Promise.all([installing, disabling]);

	assert.equal(drivers.create("conn-ext", "spawn", {}), undefined);
	assert.equal(registry.get("conn-ext")?.loaded, false);
});

test("P3-0: 本地 Extension 不能冒名覆盖 builtin Connector contribution", async () => {
	const dir = freshDir("pt-contribution-owner-");
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), drivers);
	registry.registerBuiltin(puddingClawConnectorManifest, puddingClawExtensionHooks());
	await registry.init({ developerMode: true });
	const evilManifest = {
		...connectorManifest(),
		id: "evil-package",
		connector: { ...(connectorManifest().connector as Record<string, unknown>), id: "puddingclaw" },
	};
	const evilEntry = CONNECTOR_ENTRY.replaceAll("conn-ext", "puddingclaw");
	await assert.rejects(
		() => registry.install(writeExtension(path.join(dir, "evil"), evilManifest, evilEntry)),
		/已由 extension.*占用/,
	);
	assert.ok(drivers.create("puddingclaw", "spawn", {}, "puddingclaw"));
	assert.equal(drivers.create("puddingclaw", "spawn", {}, "evil-package"), undefined);
});

test("P3-0: registry.json 未知 origin fail-closed，不加载 pre-gate 本地代码", async () => {
	const dir = freshDir("pt-origin-fail-closed-");
	writeFileSync(
		path.join(dir, "registry.json"),
		JSON.stringify({
			version: 1,
			extensions: [{ manifest: connectorManifest(), sourcePath: dir, installedAt: "x", updatedAt: "x", version: "1.0.0" }],
		}),
	);
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), new DriverRegistry());
	await assert.rejects(() => registry.init(), /origin 非法/);

	// 旧版 "local" origin 同样 fail-closed（未上线不做兼容迁移，提示清理）。
	writeFileSync(
		path.join(dir, "registry.json"),
		JSON.stringify({
			version: 1,
			extensions: [
				{ manifest: connectorManifest(), origin: "local", sourcePath: dir, digest: "sha256:x", installedAt: "x", updatedAt: "x", version: "1.0.0" },
			],
		}),
	);
	const registry2 = new ExtensionRegistry(dir, new ExtensionCatalog(), new DriverRegistry());
	await assert.rejects(() => registry2.init(), /origin 非法/);

	// user/local-link 记录缺 digest 也 fail-closed。
	writeFileSync(
		path.join(dir, "registry.json"),
		JSON.stringify({
			version: 1,
			extensions: [
				{ manifest: connectorManifest(), origin: "local-link", sourcePath: dir, installedAt: "x", updatedAt: "x", version: "1.0.0" },
			],
		}),
	);
	const registry3 = new ExtensionRegistry(dir, new ExtensionCatalog(), new DriverRegistry());
	await assert.rejects(() => registry3.init(), /缺少 digest/);
});

test("Phase5: 更新与版本固定——pin 不匹配拒绝，不静默换版", async () => {
	const dir = freshDir("pt-p5-upd-");
	const catalog = new ExtensionCatalog();
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(dir, catalog, drivers);
	await registry.init({ developerMode: true });

	const extDir = writeExtension(path.join(dir, "ext-cap"), capabilityManifest("1.0.0"), CAPABILITY_ENTRY);
	await registry.install(extDir, { versionPin: "1.0.0" });

	// 目录里出现新版本但 pin 固定 → 拒绝。
	writeExtension(extDir, capabilityManifest("1.1.0"), CAPABILITY_ENTRY);
	await assert.rejects(() => registry.update("cap-ext"), /固定版本/);
	assert.equal(registry.get("cap-ext")!.version, "1.0.0", "拒绝后保持旧版本");

	// 解除 pin 后更新成功。
	const updated = await registry.update("cap-ext", { versionPin: "1.1.0" });
	assert.equal(updated.version, "1.1.0");
	assert.equal(updated.versionPin, "1.1.0");
});

test("P3-0: Extension 更新加载失败时旧版本保持 active 且持久化记录不变", async () => {
	const dir = freshDir("pt-update-rollback-");
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), drivers);
	await registry.init({ developerMode: true });
	const extDir = writeExtension(path.join(dir, "connector"), connectorManifest("1.0.0"), CONNECTOR_ENTRY);
	await registry.install(extDir);
	assert.equal(drivers.create("conn-ext", "spawn", {})?.id, "conn-ext");

	writeExtension(
		extDir,
		connectorManifest("1.1.0"),
		'throw new Error("candidate activation exploded");\n' + CONNECTOR_ENTRY,
	);
	await assert.rejects(() => registry.update("conn-ext", { versionPin: "1.1.0" }), /candidate activation exploded/);

	assert.equal(registry.get("conn-ext")?.version, "1.0.0");
	assert.equal(registry.get("conn-ext")?.loaded, true);
	assert.equal(registry.get("conn-ext")?.loadError, undefined);
	assert.equal(drivers.create("conn-ext", "spawn", {})?.id, "conn-ext", "失败后必须继续使用旧 factory");
	const persisted = JSON.parse(readFileSync(path.join(dir, "registry.json"), "utf-8")) as {
		extensions: Array<{ version: string }>;
	};
	assert.equal(persisted.extensions[0]?.version, "1.0.0");
});

test("P3-0: 候选贡献激活冲突时重新注册旧 runtime hooks", async () => {
	const dir = freshDir("pt-update-runtime-rollback-");
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), drivers);
	await registry.init({ developerMode: true });
	const extDir = writeExtension(path.join(dir, "connector"), connectorManifest("1.0.0"), CONNECTOR_ENTRY);
	await registry.install(extDir);

	const occupiedManifest = {
		...connectorManifest(),
		id: "occupied-package",
		connector: {
			...(connectorManifest().connector as Record<string, unknown>),
			id: "occupied-connector",
		},
	};
	await registry.install(
		writeExtension(
			path.join(dir, "occupied"),
			occupiedManifest,
			CONNECTOR_ENTRY.replaceAll("conn-ext", "occupied-connector"),
		),
	);

	const conflictingCandidate = {
		...connectorManifest("1.1.0"),
		connector: {
			...(connectorManifest().connector as Record<string, unknown>),
			id: "occupied-connector",
		},
	};
	writeExtension(extDir, conflictingCandidate, CONNECTOR_ENTRY.replaceAll("conn-ext", "occupied-connector"));
	await assert.rejects(() => registry.update("conn-ext", { versionPin: "1.1.0" }), /已由 extension.*占用/);

	assert.equal(registry.get("conn-ext")?.version, "1.0.0");
	assert.equal(registry.get("conn-ext")?.loaded, true);
	assert.equal(drivers.create("conn-ext", "spawn", {})?.id, "conn-ext", "旧 contribution 必须恢复");
	assert.equal(drivers.create("occupied-connector", "spawn", {})?.id, "occupied-connector", "无关 contribution 不能受影响");
});

test("Phase5: 卸载移除模块与记录；重启后从 registry.json 重载", async () => {
	const dir = freshDir("pt-p5-persist-");
	const catalog = new ExtensionCatalog();
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(dir, catalog, drivers);
	await registry.init({ developerMode: true });
	const capDir = writeExtension(path.join(dir, "ext-cap"), capabilityManifest(), CAPABILITY_ENTRY);
	await registry.install(capDir);
	assert.ok(catalog.get("cap-ext"));

	// 重启：新实例从 registry.json 恢复注册。
	const catalog2 = new ExtensionCatalog();
	const registry2 = new ExtensionRegistry(dir, catalog2, new DriverRegistry());
	await registry2.init({ developerMode: true });
	assert.ok(catalog2.get("cap-ext"), "重启后必须从持久化记录重新注册模块");
	assert.equal(registry2.list().length, 1);

	await registry2.uninstall("cap-ext");
	assert.equal(catalog2.get("cap-ext"), undefined, "卸载后模块必须移除");
	assert.equal(registry2.get("cap-ext"), undefined);
	await assert.rejects(() => registry2.uninstall("cap-ext"), /not installed/);
});

test("Phase5: builtin PuddingClaw 在目录中且不可卸载；manifest-only connector 可安装", async () => {
	const dir = freshDir("pt-p5-builtin-");
	const catalog = new ExtensionCatalog();
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(dir, catalog, drivers);
	registry.registerBuiltin(puddingClawConnectorManifest, puddingClawExtensionHooks());
	await registry.init({ developerMode: true });

	const entry = registry.get("puddingclaw");
	assert.ok(entry, "PuddingClaw 必须以 builtin 身份进入目录");
	assert.equal(entry!.origin, "builtin");
	assert.equal(entry!.manifest.kind, "connector");
	const driver: AgentDriver | undefined = drivers.create("puddingclaw", "spawn", { command: "puddingclaw" });
	assert.ok(driver);
	const caps: DriverCapabilities = await driver!.capabilities();
	assert.ok(caps.operations.includes("run"));

	await assert.rejects(() => registry.uninstall("puddingclaw"), /builtin/);

	// 既无 entry 又无 declarative 的 manifest-only connector：登记目录但不注册 driver。
	const declDir = writeExtension(path.join(dir, "ext-decl"), { ...connectorManifest(), id: "decl-conn", entry: undefined, connector: { ...(connectorManifest().connector as object), id: "decl-conn" } });
	const decl = await registry.install(declDir);
	assert.equal(decl.loaded, true);
	assert.equal(drivers.get("decl-conn"), undefined);
});


test("§11: manifest connector.avatar 校验——包内相对路径且扩展名白名单", () => {
	// 合法：相对路径 + svg。
	const ok = parseExtensionManifest({
		...connectorManifest(),
		connector: { ...(connectorManifest().connector as Record<string, unknown>), avatar: "assets/avatar.svg" },
	});
	assert.equal(ok.kind, "connector");
	if (ok.kind !== "connector") return;
	assert.equal(ok.connector.avatar, "assets/avatar.svg");

	// 非法：绝对路径 / 越界 / 反斜杠 / 非图片扩展名。
	for (const bad of ["/etc/passwd.svg", "../escape.svg", "a\\b.svg", "avatar.txt"]) {
		assert.throws(
			() =>
				parseExtensionManifest({
					...connectorManifest(),
					connector: { ...(connectorManifest().connector as Record<string, unknown>), avatar: bad },
				}),
			/connector\.avatar/,
			`avatar=${bad} 必须被拒绝`,
		);
	}
});

test("§11: hasConnectorAvatar / readConnectorAvatar——builtin assetsDir 与安装包 sourcePath", async () => {
	const dir = freshDir("pt-p5-avatar-");
	const assetsDir = path.join(dir, "assets");
	mkdirSync(assetsDir, { recursive: true });
	writeFileSync(path.join(assetsDir, "ava.svg"), "<svg/>");
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), drivers);

	// 未声明 avatar 的 builtin：false / null。
	registry.registerBuiltin(puddingClawConnectorManifest, puddingClawExtensionHooks());
	assert.equal(registry.hasConnectorAvatar("puddingclaw"), false);
	assert.equal(await registry.readConnectorAvatar("puddingclaw"), null);

	// 声明了 avatar 的 builtin：从 assetsDir 读。
	const manifest = parseExtensionManifest({
		...connectorManifest(),
		id: "ava-conn",
		source: "builtin",
		entry: undefined,
		connector: { ...(connectorManifest().connector as Record<string, unknown>), id: "ava-conn", avatar: "ava.svg" },
	});
	registry.registerBuiltin(manifest, {}, { assetsDir });
	assert.equal(registry.hasConnectorAvatar("ava-conn"), true);
	const read = await registry.readConnectorAvatar("ava-conn");
	assert.ok(read);
	assert.equal(read!.mime, "image/svg+xml");
	assert.equal(read!.buf.toString(), "<svg/>");

	// 声明了 avatar 但没给 assetsDir：按未声明处理（防御）。
	const noDir = parseExtensionManifest({
		...connectorManifest(),
		id: "nodir-conn",
		source: "builtin",
		entry: undefined,
		connector: { ...(connectorManifest().connector as Record<string, unknown>), id: "nodir-conn", avatar: "ava.svg" },
	});
	registry.registerBuiltin(noDir, {});
	assert.equal(registry.hasConnectorAvatar("nodir-conn"), false);
});

test("P4: user 安装——复制到 packages/<id>/<version>/、记录 digest，源目录改动不影响已安装包", async () => {
	const dir = freshDir("pt-user-install-");
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), drivers);
	await registry.init();

	const src = writeExtension(path.join(dir, "src-conn"), connectorManifest(), CONNECTOR_ENTRY);
	const entry = await registry.installUserPackage(src);
	assert.equal(entry.origin, "user");
	assert.equal(entry.loaded, true, entry.loadError ?? "");
	assert.ok(drivers.create("conn-ext", "spawn", {}));

	const copiedDir = path.join(dir, "packages", "conn-ext", "1.0.0");
	assert.ok(existsSync(path.join(copiedDir, EXTENSION_MANIFEST_FILE)), "内容必须复制到 packages/<id>/<version>/");
	assert.ok(existsSync(path.join(copiedDir, "index.mjs")));
	const persisted = JSON.parse(readFileSync(path.join(dir, "registry.json"), "utf-8")) as {
		extensions: Array<{ origin: string; sourcePath: string; digest?: string; version: string; installedAt: string }>;
	};
	const record = persisted.extensions[0]!;
	assert.equal(record.origin, "user");
	assert.equal(record.sourcePath, copiedDir);
	assert.match(record.digest ?? "", /^sha256:[0-9a-f]{64}$/);
	assert.equal(record.version, "1.0.0");
	assert.ok(record.installedAt);

	// 复制语义而非链接：源目录删除后重启仍能加载。
	rmSync(src, { recursive: true, force: true });
	const registry2 = new ExtensionRegistry(dir, new ExtensionCatalog(), new DriverRegistry());
	await registry2.init();
	assert.equal(registry2.get("conn-ext")?.loaded, true);
});

test("P4: user 安装失败——校验/激活失败不留包目录与记录残留", async () => {
	const dir = freshDir("pt-user-fail-");
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), new DriverRegistry(), "1.0.0");
	await registry.init();

	// engines 校验失败：发生在 staging 之前，packages 目录都不应出现。
	const badEngines = writeExtension(
		path.join(dir, "bad-engines"),
		{ ...connectorManifest(), engines: { puddingteams: ">=2" } },
		CONNECTOR_ENTRY,
	);
	await assert.rejects(() => registry.installUserPackage(badEngines), /要求 PuddingTeams/);
	assert.equal(existsSync(path.join(dir, "packages")), false);
	assert.equal(registry.get("conn-ext"), undefined);

	// 激活失败（模块不导出 driver）：已落位目录必须清理，不落 registry 记录。
	const noExport = writeExtension(path.join(dir, "no-export"), connectorManifest(), "export const nothing = 1;\n");
	await assert.rejects(() => registry.installUserPackage(noExport), /未导出/);
	assert.equal(existsSync(path.join(dir, "packages", "conn-ext", "1.0.0")), false);
	assert.equal(registry.get("conn-ext"), undefined);
	// staging 目录不得残留。
	const packagesDir = path.join(dir, "packages");
	if (existsSync(packagesDir)) {
		const leftovers = readdirSync(packagesDir).filter((name) => name.startsWith(".staging-"));
		assert.deepEqual(leftovers, []);
	}
});

test("P4: user 更新——staging 原子切换；失败保留旧版本目录/记录/运行时", async () => {
	const dir = freshDir("pt-user-update-");
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), drivers);
	await registry.init();
	const v1 = writeExtension(path.join(dir, "v1"), connectorManifest("1.0.0"), CONNECTOR_ENTRY);
	await registry.installUserPackage(v1);

	// 更新必须给来源目录。
	await assert.rejects(() => registry.update("conn-ext"), /必须提供来源目录/);

	// 成功更新到 1.1.0：记录切换、旧版本目录保留。
	const v2 = writeExtension(path.join(dir, "v2"), connectorManifest("1.1.0"), CONNECTOR_ENTRY);
	const updated = await registry.update("conn-ext", { path: v2 });
	assert.equal(updated.version, "1.1.0");
	assert.equal(updated.origin, "user");
	assert.ok(existsSync(path.join(dir, "packages", "conn-ext", "1.1.0", "index.mjs")));
	assert.ok(existsSync(path.join(dir, "packages", "conn-ext", "1.0.0", "index.mjs")), "旧版本目录不自动删除");
	assert.equal(drivers.create("conn-ext", "spawn", {})?.id, "conn-ext");

	// pin 不匹配拒绝。
	await assert.rejects(() => registry.update("conn-ext", { path: v2, versionPin: "9.9.9" }), /固定版本/);

	// 候选激活爆炸：记录/运行时/旧目录全部保持 1.1.0。
	const v3 = writeExtension(
		path.join(dir, "v3"),
		connectorManifest("1.2.0"),
		'throw new Error("candidate activation exploded");\n' + CONNECTOR_ENTRY,
	);
	await assert.rejects(() => registry.update("conn-ext", { path: v3 }), /candidate activation exploded/);
	assert.equal(registry.get("conn-ext")?.version, "1.1.0");
	assert.equal(registry.get("conn-ext")?.loaded, true);
	assert.equal(drivers.create("conn-ext", "spawn", {})?.id, "conn-ext", "失败后必须继续使用旧 factory");
	assert.equal(existsSync(path.join(dir, "packages", "conn-ext", "1.2.0")), false, "失败候选目录必须清理");
	assert.ok(existsSync(path.join(dir, "packages", "conn-ext", "1.1.0", "index.mjs")), "旧版本目录必须保留");
	const persisted = JSON.parse(readFileSync(path.join(dir, "registry.json"), "utf-8")) as {
		extensions: Array<{ version: string }>;
	};
	assert.equal(persisted.extensions[0]?.version, "1.1.0");
});

test("P4: local-link 登记 digest；源漂移后重启标记 drifted，update 后清除", async () => {
	const dir = freshDir("pt-link-drift-");
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), new DriverRegistry());
	await registry.init({ developerMode: true });
	const src = writeExtension(path.join(dir, "linked"), connectorManifest(), CONNECTOR_ENTRY);
	const entry = await registry.install(src);
	assert.equal(entry.origin, "local-link");
	assert.equal(entry.drifted, undefined);
	const persisted = JSON.parse(readFileSync(path.join(dir, "registry.json"), "utf-8")) as {
		extensions: Array<{ origin: string; digest?: string }>;
	};
	assert.equal(persisted.extensions[0]!.origin, "local-link");
	assert.match(persisted.extensions[0]!.digest ?? "", /^sha256:[0-9a-f]{64}$/);

	// 漂移：源目录新增文件 → 重启 init 标记 drifted（只提示，不阻断加载）。
	writeFileSync(path.join(src, "NOTES.md"), "changed");
	const registry2 = new ExtensionRegistry(dir, new ExtensionCatalog(), new DriverRegistry());
	await registry2.init({ developerMode: true });
	const drifted = registry2.get("conn-ext")!;
	assert.equal(drifted.drifted, true, "digest 漂移必须在启动时标记");
	assert.equal(drifted.loaded, true, "漂移不阻断开发者模式加载");

	// update 重算 digest 后漂移标记清除。
	const updated = await registry2.update("conn-ext");
	assert.equal(updated.drifted, undefined);
});

test("P4: 三态互不静默覆盖——bundled/user/local-link 同 id 冲突拒绝", async () => {
	const dir = freshDir("pt-origin-conflict-");
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), new DriverRegistry());
	await registry.init({ developerMode: true });
	await registry.installOrUpdateFromDir(writeExtension(path.join(dir, "bundled"), connectorManifest(), CONNECTOR_ENTRY));

	// user / local-link 与 bundled 同 id → 拒绝。
	await assert.rejects(
		() => registry.installUserPackage(writeExtension(path.join(dir, "user"), connectorManifest(), CONNECTOR_ENTRY)),
		/互不覆盖/,
	);
	await assert.rejects(
		() => registry.install(writeExtension(path.join(dir, "link"), connectorManifest(), CONNECTOR_ENTRY)),
		/互不覆盖/,
	);

	// bundled 预装与 user 同 id → 拒绝；local-link 与 user 同 id → 拒绝。
	const dir2 = freshDir("pt-origin-conflict2-");
	const registry2 = new ExtensionRegistry(dir2, new ExtensionCatalog(), new DriverRegistry());
	await registry2.init();
	await registry2.installUserPackage(writeExtension(path.join(dir2, "user"), connectorManifest(), CONNECTOR_ENTRY));
	await assert.rejects(
		() => registry2.installOrUpdateFromDir(writeExtension(path.join(dir2, "bundled"), connectorManifest(), CONNECTOR_ENTRY)),
		/互不覆盖/,
	);
	await registry2.setDeveloperMode(true);
	await assert.rejects(
		() => registry2.install(writeExtension(path.join(dir2, "link"), connectorManifest(), CONNECTOR_ENTRY)),
		/互不覆盖/,
	);
});

test("P4: bundled 预装按发行投影自愈 sourcePath——旧绝对路径失效不阻断启动", async () => {
	const home = freshDir("pt-bundled-heal-home-");
	// 上次启动留下的 bundled 记录指向已失效的旧绝对路径（换机器/换路径）。
	// 该路径在本进程从未被 import，避免 ESM 进程内缓存掩盖真实重启行为。
	const ghost = path.join(home, "ghost-pkg");
	writeFileSync(
		path.join(home, "registry.json"),
		JSON.stringify({
			version: 1,
			extensions: [
				{
					manifest: connectorManifest(),
					origin: "bundled",
					sourcePath: ghost,
					installedAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-01-01T00:00:00.000Z",
					version: "1.0.0",
				},
			],
		}),
	);
	const registry = new ExtensionRegistry(home, new ExtensionCatalog(), new DriverRegistry());
	await registry.init();
	assert.equal(registry.get("conn-ext")?.loaded, false, "旧绝对路径失效时激活失败只记 loadError");

	// 发行投影重新解析到新路径（同一 manifest id+版本）→ 记录自愈更新。
	const dirB = freshDir("pt-bundled-b-");
	writeExtension(dirB, connectorManifest(), CONNECTOR_ENTRY);
	const healed = await registry.installOrUpdateFromDir(dirB);
	assert.equal(healed.loaded, true, healed.loadError ?? "");
	const persisted = JSON.parse(readFileSync(path.join(home, "registry.json"), "utf-8")) as {
		extensions: Array<{ sourcePath: string; origin: string }>;
	};
	assert.equal(persisted.extensions[0]!.origin, "bundled");
	assert.equal(persisted.extensions[0]!.sourcePath, dirB, "sourcePath 必须自愈为重新解析的投影路径");
});

test("P4: 退出发行物的 bundled Extension 在启动时自动移除", async () => {
	const dir = freshDir("pt-bundled-retired-");
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), new DriverRegistry());
	await registry.init();
	await registry.installOrUpdateFromDir(writeExtension(path.join(dir, "bundled"), connectorManifest(), CONNECTOR_ENTRY));
	assert.ok(registry.get("conn-ext"));

	const restarted = new ExtensionRegistry(dir, new ExtensionCatalog(), new DriverRegistry());
	await restarted.init({ bundledIds: [] });
	assert.equal(restarted.get("conn-ext"), undefined);
	const persisted = JSON.parse(readFileSync(path.join(dir, "registry.json"), "utf-8")) as { extensions: unknown[] };
	assert.deepEqual(persisted.extensions, []);
});

test("P4: 卸载——user 包删除 packages 目录；bundled 拒绝卸载", async () => {
	const dir = freshDir("pt-uninstall-user-");
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), new DriverRegistry());
	await registry.init();
	await registry.installUserPackage(writeExtension(path.join(dir, "user"), connectorManifest(), CONNECTOR_ENTRY));
	assert.ok(existsSync(path.join(dir, "packages", "conn-ext")));
	await registry.uninstall("conn-ext");
	assert.equal(registry.get("conn-ext"), undefined);
	assert.equal(existsSync(path.join(dir, "packages", "conn-ext")), false, "卸载 user 包必须删除复制目录");

	const dir2 = freshDir("pt-uninstall-bundled-");
	const registry2 = new ExtensionRegistry(dir2, new ExtensionCatalog(), new DriverRegistry());
	await registry2.init();
	await registry2.installOrUpdateFromDir(writeExtension(path.join(dir2, "bundled"), connectorManifest(), CONNECTOR_ENTRY));
	await assert.rejects(() => registry2.uninstall("conn-ext"), /不可卸载/);
});
