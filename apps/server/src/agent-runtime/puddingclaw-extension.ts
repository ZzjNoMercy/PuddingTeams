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
	version: "1.1.0",
	source: "builtin",
	kind: "connector",
	engines: { puddingteams: ">=0.1 <1" },
	permissions: ["spawn", "network"],
	connector: {
		id: PUDDINGCLAW_CONNECTOR_ID,
		displayName: "PuddingClaw",
		apiVersion: "1",
		defaultTransport: "spawn",
		supportedTransports: ["spawn", "http"],
		configSchema: {
			type: "object",
			properties: {
				command: {
					type: "string",
					title: "CLI 命令",
					description: "spawn 模式使用的 PuddingClaw 可执行文件名或路径",
					default: "puddingclaw",
					"x-puddingteams-transports": ["spawn"],
				},
				endpoint: {
					type: "string",
					title: "HTTP Endpoint",
					description: "HTTP 模式直连的 PuddingClaw Backend 地址（无需填写 /api/headless）",
					default: "http://127.0.0.1:8888",
					"x-puddingteams-transports": ["http"],
				},
			},
		},
		supportedUpstreamVersions: ">=0.1.2",
		// 内置默认头像（布丁狗），builtin assetsDir 见 index.ts 装配。
		avatar: "puddingclaw.png",
	},
};

/** Driver 工厂：用户只配 executable；命令映射是 Driver 代码的一部分（§10）。 */
export function puddingClawExtensionHooks(): BuiltinExtensionHooks {
	return {
		driverFactory: (config, transport) => {
			if (transport !== "spawn" && transport !== "http") {
				throw new Error(`PuddingClaw Connector 不支持 transport:${transport}`);
			}
			return new PuddingClawDriver({
				transport,
				command: typeof config.command === "string" && config.command.trim() ? config.command : undefined,
				endpoint: typeof config.endpoint === "string" && config.endpoint.trim() ? config.endpoint : undefined,
			});
		},
	};
}
