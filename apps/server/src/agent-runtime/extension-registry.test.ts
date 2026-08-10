import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
		engines: { puddingteams: ">=0.1 <1" },
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
		engines: { puddingteams: ">=0.1 <1" },
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
	assert.equal(drivers.create("conn-ext", {}), undefined);
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
	assert.equal(cap.origin, "local");
	assert.equal(cap.loaded, true);
	assert.ok(catalog.get("cap-ext"), "capability 模块必须注册进 ExtensionCatalog");

	const connDir = writeExtension(path.join(dir, "ext-conn"), connectorManifest(), CONNECTOR_ENTRY);
	await registry.install(connDir);
	const driver = drivers.create("conn-ext", {});
	assert.ok(driver, "connector 必须注册 Driver factory 进 DriverRegistry");

	// 重复安装同 id 拒绝。
	await assert.rejects(() => registry.install(capDir), /已安装/);

	// 目录按 kind 过滤。
	const caps = registry.list("capability");
	assert.equal(caps.length, 1);
	assert.equal(caps[0]!.manifest.id, "cap-ext");
	assert.equal(registry.list("connector").length, 1);
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
	assert.equal(installed.origin, "local");
	assert.ok(drivers.create("conn-ext", {}));

	await registry.setDeveloperMode(false);
	assert.equal(drivers.create("conn-ext", {}), undefined, "关闭后本地 Driver 必须从运行时撤下");
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

	assert.equal(drivers.create("conn-ext", {}), undefined);
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
	assert.ok(drivers.create("puddingclaw", {}, "puddingclaw"));
	assert.equal(drivers.create("puddingclaw", {}, "evil-package"), undefined);
});

test("P3-0: extensions.json 未知 origin fail-closed，不加载 pre-gate 本地代码", async () => {
	const dir = freshDir("pt-origin-fail-closed-");
	writeFileSync(
		path.join(dir, "extensions.json"),
		JSON.stringify({
			version: 1,
			extensions: [{ manifest: connectorManifest(), sourcePath: dir, installedAt: "x", updatedAt: "x", version: "1.0.0" }],
		}),
	);
	const registry = new ExtensionRegistry(dir, new ExtensionCatalog(), new DriverRegistry());
	await assert.rejects(() => registry.init(), /origin 非法/);
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
	assert.equal(drivers.create("conn-ext", {})?.id, "conn-ext");

	writeExtension(
		extDir,
		connectorManifest("1.1.0"),
		'throw new Error("candidate activation exploded");\n' + CONNECTOR_ENTRY,
	);
	await assert.rejects(() => registry.update("conn-ext", { versionPin: "1.1.0" }), /candidate activation exploded/);

	assert.equal(registry.get("conn-ext")?.version, "1.0.0");
	assert.equal(registry.get("conn-ext")?.loaded, true);
	assert.equal(registry.get("conn-ext")?.loadError, undefined);
	assert.equal(drivers.create("conn-ext", {})?.id, "conn-ext", "失败后必须继续使用旧 factory");
	const persisted = JSON.parse(readFileSync(path.join(dir, "extensions.json"), "utf-8")) as {
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
	assert.equal(drivers.create("conn-ext", {})?.id, "conn-ext", "旧 contribution 必须恢复");
	assert.equal(drivers.create("occupied-connector", {})?.id, "occupied-connector", "无关 contribution 不能受影响");
});

test("Phase5: 卸载移除模块与记录；重启后从 extensions.json 重载", async () => {
	const dir = freshDir("pt-p5-persist-");
	const catalog = new ExtensionCatalog();
	const drivers = new DriverRegistry();
	const registry = new ExtensionRegistry(dir, catalog, drivers);
	await registry.init({ developerMode: true });
	const capDir = writeExtension(path.join(dir, "ext-cap"), capabilityManifest(), CAPABILITY_ENTRY);
	await registry.install(capDir);
	assert.ok(catalog.get("cap-ext"));

	// 重启：新实例从 extensions.json 恢复注册。
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
	const driver: AgentDriver | undefined = drivers.create("puddingclaw", { command: "puddingclaw" });
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
