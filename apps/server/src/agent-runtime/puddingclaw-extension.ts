import type { ConnectorExtensionManifest } from "./extensions.js";
import type { BuiltinExtensionHooks } from "./extension-registry.js";
import { PuddingClawDriver } from "./puddingclaw-driver.js";

/**
 * 第一方 PuddingClaw Connector Extension（§10.4 决策：第一版唯一预装的
 * Connector）。以 builtin 身份进入 Extension 目录，代码随核心发布，
 * 不经过安装流程、不可卸载。
 */
export const PUDDINGCLAW_EXTENSION_ID = "puddingclaw";
export const PUDDINGCLAW_CONNECTOR_ID = "puddingclaw";

export const puddingClawConnectorManifest: ConnectorExtensionManifest = {
	id: PUDDINGCLAW_EXTENSION_ID,
	publisher: "puddingteams",
	displayName: "PuddingClaw Connector",
	version: "1.0.0",
	source: "builtin",
	kind: "connector",
	engines: { puddingteams: ">=0.1 <1" },
	permissions: ["spawn", "secrets"],
	connector: {
		id: PUDDINGCLAW_CONNECTOR_ID,
		displayName: "PuddingClaw",
		apiVersion: "1",
		defaultTransport: "spawn",
		supportedTransports: ["spawn"],
		configSchema: {
			type: "object",
			properties: {
				command: { type: "string", description: "PuddingClaw 可执行文件名或路径", default: "puddingclaw" },
			},
		},
		secretSchema: [{ key: "PUDDINGCLAW_TOKEN", label: "PuddingClaw Backend Token", required: true }],
		supportedUpstreamVersions: ">=0.9",
	},
};

/** Driver 工厂：用户只配 executable；命令映射是 Driver 代码的一部分（§10）。 */
export function puddingClawExtensionHooks(): BuiltinExtensionHooks {
	return {
		driverFactory: (config) =>
			new PuddingClawDriver({
				command: typeof config.command === "string" && config.command.trim() ? config.command : undefined,
			}),
	};
}
