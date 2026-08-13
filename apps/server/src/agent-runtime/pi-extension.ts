import type { ConnectorExtensionManifest } from "./extensions.js";
import type { BuiltinExtensionHooks } from "./extension-registry.js";
import { LocalPiDriver, type LocalPiDriverOptions } from "./pi-driver.js";

/**
 * 第一方本地 pi Connector Extension（§9.1 Pi 调 Pi）：child pi 以进程内
 * SDK 会话作为 worker。以 builtin 身份进入 Extension 目录，代码随核心
 * 发布，不经过安装流程、不可卸载（与 PuddingClaw 一致；包形态/双宿主
 * 迁移是后续收尾工作，见 §9.5）。
 */
export const PI_EXTENSION_ID = "pi";
export const PI_CONNECTOR_ID = "pi";

export const piConnectorManifest: ConnectorExtensionManifest = {
	id: PI_EXTENSION_ID,
	publisher: "puddingteams",
	displayName: "pi Connector",
	version: "1.0.0",
	source: "builtin",
	kind: "connector",
	engines: { puddingteams: ">=0.1 <1" },
	// 进程内 SDK：不 spawn；会访问网络（LLM API）与 workspace（内置工具读写 cwd）。
	permissions: ["network", "workspace"],
	connector: {
		id: PI_CONNECTOR_ID,
		displayName: "pi",
		apiVersion: "1",
		defaultTransport: "sdk",
		supportedTransports: ["sdk"],
		// lobehub Pi 图标（pi-mono 官方 logo），builtin assetsDir 见 index.ts 装配。
		avatar: "pi.svg",
		configSchema: {
			type: "object",
			properties: {
				model: {
					type: "string",
					// format: "model" —— 前端渲染为可用模型下拉（数据源 /api/models），
					// 不是自由文本；任何 connector 都可用这个注解（pi 不特殊化）。
					format: "model",
					description: "worker 使用的模型；留空用 pi 默认模型",
				},
				thinkingLevel: {
					type: "string",
					enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
					description: "thinking 级别（留空用 pi 默认）",
				},
				sessionDir: {
					type: "string",
					description: "会话存储目录（可选，默认派生到 pi 配置目录下）",
				},
			},
		},
		// 认证复用 pi 全局 agentDir 的凭证（与 manager 相同），不收平台 secret。
	},
};

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Driver 工厂：同一 Connector 多 Agent 实例（§9.3.7），每实例一份 config。 */
export function piExtensionHooks(defaults: { sessionDir?: string } = {}): BuiltinExtensionHooks {
	return {
		driverFactory: (config) =>
			new LocalPiDriver({
				model: str(config.model),
				thinkingLevel: str(config.thinkingLevel),
				piResources:
					config.piResources && typeof config.piResources === "object" && !Array.isArray(config.piResources)
						? (config.piResources as import("../store/teams.js").PiResourceConfig)
						: undefined,
				// 信任门判定由平台（Invoker）注入；独立使用时不带，维持旧语义。
				workspaceAccessFor:
					typeof config.workspaceAccessFor === "function"
						? (config.workspaceAccessFor as LocalPiDriverOptions["workspaceAccessFor"])
						: undefined,
				// Agent 未显式配置时用平台默认（PUDDINGTEAMS_HOME/sessions/workers）。
				sessionDir: str(config.sessionDir) ?? defaults.sessionDir,
			}),
	};
}
