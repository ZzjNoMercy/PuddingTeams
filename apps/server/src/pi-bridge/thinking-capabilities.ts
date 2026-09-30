/**
 * 思考强度能力表（§10.6 thinking binding 的平台侧补丁层）。
 *
 * pi SDK 判定思考强度分两层：第 1 层 `getSupportedThinkingLevels` 只读模型
 * 目录的 `reasoning` / `thinkingLevelMap`；第 2 层由各 api adapter 把档位翻译
 * 成线上字段，且多数方言受 `compat.supportsReasoningEffort` 门控。两层由不同
 * 数据源驱动，会出现「菜单给了 4 档、线上只有开/关两种行为」的缝隙。
 *
 * 本模块只做一件事：**声明上游目录与官方 API 文档不一致的模型，并经 pi 官方
 * 的 `models.json` `modelOverrides` 顶层覆盖层修正它**。不重实现 adapter、不
 * 自造 clamp 规则——档位到线上字段的映射仍全部由 SDK 负责，SDK 目录修好后
 * 删除本表即可恢复上游行为。
 *
 * 每条声明必须以 provider 官方 API 文档为依据，不得凭 SDK 目录反推。
 */

/** 一条能力声明：`provider/model` 精确匹配，不做通配。 */
export interface ThinkingCapabilityOverride {
	/**
	 * 打开 `compat.supportsReasoningEffort`，使 adapter 在开关之外透传
	 * `reasoning_effort`。仅当官方文档明确支持分档时才能为 true。
	 */
	supportsReasoningEffort?: boolean;
	/** 覆盖 `thinkingLevelMap`（浅合并到目录原值之上）。 */
	thinkingLevelMap?: Record<string, string | null>;
	/** 依据来源，评审时据此复核。 */
	source: string;
}

/** key 为 `${provider}/${modelId}`。 */
const THINKING_CAPABILITY_OVERRIDES: Record<string, ThinkingCapabilityOverride> = {
	// DeepSeek 官方 Chat Completions 明确支持 reasoning_effort=[none,low,high,max]，
	// 默认 high，minimal→low、medium/xhigh→high；GET /models 亦下发
	// effort.supported_levels=[low,high,max]。但 pi-ai 目录（0.84.4~0.87.1 实测
	// 均未变）把 compat.supportsReasoningEffort 留空，adapter 因此只发
	// thinking:{type:enabled}，把三档压成一种行为。
	"deepseek/deepseek-v4-flash": {
		supportsReasoningEffort: true,
		source: "https://api-docs.deepseek.com/api/create-chat-completion/",
	},
	"deepseek/deepseek-v4-pro": {
		supportsReasoningEffort: true,
		source: "https://api-docs.deepseek.com/api/create-chat-completion/",
	},
	"deepseek/deepseek-v4-flash-vision-exp": {
		supportsReasoningEffort: true,
		source: "https://api-docs.deepseek.com/guides/thinking_mode",
	},
	// 0.86.0 起目录把 V4.1 Flash 改名为 deepseek-flash（#9423），同一能力。
	"deepseek/deepseek-flash": {
		supportsReasoningEffort: true,
		source: "https://api-docs.deepseek.com/api/create-chat-completion/",
	},
};

/** 平台声明的全部覆盖（供测试与诊断读取）。 */
export function thinkingCapabilityOverrides(): Readonly<Record<string, ThinkingCapabilityOverride>> {
	return THINKING_CAPABILITY_OVERRIDES;
}

/** 某模型是否有平台侧能力声明。 */
export function thinkingCapabilityOverrideFor(provider: string, modelId: string): ThinkingCapabilityOverride | undefined {
	return THINKING_CAPABILITY_OVERRIDES[`${provider}/${modelId}`];
}

/** 把能力声明转成 models.json 的 modelOverrides 条目。 */
export function toModelOverride(entry: ThinkingCapabilityOverride): Record<string, unknown> {
	return {
		...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
		...(entry.supportsReasoningEffort === undefined ? {} : { compat: { supportsReasoningEffort: entry.supportsReasoningEffort } }),
	};
}

/** 全表转成 `applyThinkingCapabilityOverrides` 需要的形状。 */
export function toModelOverrideEntries(): Record<string, { supportsReasoningEffort?: boolean; thinkingLevelMap?: Record<string, string | null> }> {
	const out: Record<string, { supportsReasoningEffort?: boolean; thinkingLevelMap?: Record<string, string | null> }> = {};
	for (const [ref, entry] of Object.entries(THINKING_CAPABILITY_OVERRIDES)) {
		out[ref] = {
			...(entry.supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort: entry.supportsReasoningEffort }),
			...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
		};
	}
	return out;
}
