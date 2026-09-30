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
	engines: { puddingteams: ">=1 <2" },
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
					// title 是 UI 标签：缺省会退化成 schema key（model/thinkingLevel/
					// sessionDir），把内部字段名直接暴露给用户。
					title: "模型",
					// format: "model" —— 前端渲染为可用模型下拉（数据源 /api/models），
					// 不是自由文本；任何 connector 都可用这个注解（pi 不特殊化）。
					format: "model",
					// description 渲染在字段标题下面（不是控件下面）：它解释"这个字段
					// 是干什么的"，控件下面留给随当前值变化的动态说明。
					description: "智能体使用的模型，留空使用全局默认",
				},
				thinkingLevel: {
					type: "string",
					title: "思考强度",
					// 与 teams.ts 校验枚举、pi-ai EXTENDED_THINKING_LEVELS 逐项一致。
					// 曾少列 "max"，导致 worker 表单选不到该档（Kimi K3 / GLM / DeepSeek
					// 都支持），而 manager 表单用的是另一份 7 档常量，两边选项不一致。
					// 某模型实际可选的档位由 /api/models 的 thinkingLevels 决定，
					// 本 enum 只是未选定模型时的回退全集。
					enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
					"x-puddingteams-thinking-levels-from": "model",
					description: "留空使用全局默认，档位随所选模型变化",
				},
				sessionDir: {
					type: "string",
					title: "会话存储目录",
					// 运维向字段：仍可由 API / teams.json 写入、运行时照常读取，但配置页
					// 不生成表单——普通用户没有改会话存储位置的场景。
					"x-puddingteams-hidden": true,
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
export function piExtensionHooks(defaults: { sessionDir?: string; fffStateRoot?: string } = {}): BuiltinExtensionHooks {
	return {
		driverFactory: (config) =>
			new LocalPiDriver({
				executionProfile: config.executionProfile === "wiki_curator" ? "wiki_curator" : undefined,
				knowledgeFor: typeof config.knowledgeFor === "function" ? config.knowledgeFor as LocalPiDriverOptions["knowledgeFor"] : undefined,
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
				codeSearchFor:
					typeof config.codeSearchFor === "function"
						? (config.codeSearchFor as LocalPiDriverOptions["codeSearchFor"])
						: undefined,
				fffStateRoot: str(config.fffStateRoot) ?? defaults.fffStateRoot,
				capabilityRuntimeFor:
					typeof config.capabilityRuntimeFor === "function"
						? (config.capabilityRuntimeFor as LocalPiDriverOptions["capabilityRuntimeFor"])
						: undefined,
				managedExtensionFactoriesFor:
					typeof config.managedExtensionFactoriesFor === "function"
						? (config.managedExtensionFactoriesFor as LocalPiDriverOptions["managedExtensionFactoriesFor"])
						: undefined,
				managedExtensionsFingerprintFor: typeof config.managedExtensionsFingerprintFor === "function"
					? config.managedExtensionsFingerprintFor as LocalPiDriverOptions["managedExtensionsFingerprintFor"] : undefined,
				webResearchToolsFor: typeof config.webResearchToolsFor === "function"
					? config.webResearchToolsFor as LocalPiDriverOptions["webResearchToolsFor"] : undefined,
				// Agent 未显式配置时用平台默认（PUDDINGTEAMS_HOME/sessions/workers）。
				sessionDir: str(config.sessionDir) ?? defaults.sessionDir,
			}),
	};
}
