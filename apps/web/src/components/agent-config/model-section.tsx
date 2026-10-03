"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listExtensionCatalog } from "@/lib/api";
import type { AgentConfig, PiManagerSettings } from "@/lib/types";
import { THINKING_LEVELS, useModelCatalog } from "@/lib/model-catalog";
import { ConfigSchemaForm, ModelSelectField } from "@/components/agents/form-parts";
import type { ConfigDraft } from "@/components/agent-config/draft";
import { SESSION_EFFECT_NOTE } from "@/components/agent-config/session-effect";

/**
 * 模型与运行分区：pinned manager 渲染 PiManagerSettings 字段；pi worker 用
 * 该 Connector 的 configSchema 渲染；目录请求失败需重试，成功但无 schema
 * 时回退到内置 pi 的 model/thinkingLevel/sessionDir 字段。改动对新建或
 * 重开的 Session 生效。
 */

/** 与 server pi-extension.ts 的 configSchema 同构的回退（目录成功但未提供 schema）。 */
const PI_FALLBACK_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		model: { type: "string", title: "模型", format: "model", description: "智能体使用的模型，留空使用全局默认" },
		thinkingLevel: {
			type: "string",
			title: "思考强度",
			enum: THINKING_LEVELS,
			"x-puddingteams-thinking-levels-from": "model",
			description: "留空使用全局默认，档位随所选模型变化",
		},
		// 会话存储目录是运维向字段：与 server schema 同样标注，配置页不生成表单。
		sessionDir: { type: "string", title: "会话存储目录", "x-puddingteams-hidden": true, description: "会话存储目录（可选，默认 ~/.puddingteams/sessions/workers）" },
	},
};

function ToggleRow({
	label,
	hint,
	checked,
	onChange,
	note,
	disabled,
}: {
	label: string;
	hint?: string;
	checked: boolean;
	onChange: (v: boolean) => void;
	note?: string;
	disabled?: boolean;
}) {
	return (
		<>
			<label className="agent-config-toggle">
				<span>
					<strong>{label}</strong>
					{hint ? <small>{hint}</small> : null}
				</span>
				<input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
			</label>
			{note ? <p className="agent-config-toggle-note">{note}</p> : null}
		</>
	);
}

function ManagerFields({
	draft,
	onChange,
}: {
	draft: ConfigDraft;
	onChange: (patch: Partial<ConfigDraft>) => void;
}) {
	const catalog = useModelCatalog();
	const thinkingLevel = draft.manager.thinkingLevel ?? "default";
	// 档位跟随所选模型（与 composer 同一份 thinkingLevels map）；未选定模型时回退全集。
	const levels = catalog.levelsFor(draft.manager.model);
	const graded = catalog.gradedFor(draft.manager.model);
	const pendingLevel = thinkingLevel !== "default" && !levels.includes(thinkingLevel);
	return (
		<div>
			{/* 模型 */}
			<section className="agent-config-card">
				<div className="agent-config-card-head"><h2>模型</h2><p>选择此智能体使用的模型与思考强度。</p></div>
				<div className="agent-config-fields">
					<div className="agent-config-columns">
						<ModelSelectField
							label="模型"
							current={draft.manager.model ?? ""}
							description="智能体使用的模型，留空使用全局默认"
							onSelect={(next) => onChange({ manager: { ...draft.manager, model: next } })}
						/>
						<label className="agent-config-field">
							<span>思考强度</span>
							<small>留空使用全局默认，档位随所选模型变化</small>
							<Select
								value={thinkingLevel}
								onValueChange={(v) =>
									onChange({
										manager: {
											...draft.manager,
											thinkingLevel: v === "default" ? undefined : (v as PiManagerSettings["thinkingLevel"]),
										},
									})
								}
							>
								<SelectTrigger className="w-full">
									{/* 没有 placeholder 时，一旦当前值与任何选项都不匹配，Radix 会渲染成
									    空白框——用户看到的是空的选择框而不是"默认"。Worker 路径的
									    EnumSelectField 一直有 placeholder，这里补齐。 */}
									<SelectValue placeholder="默认（不设置）" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="default">默认（不设置）</SelectItem>
									{/* 已存档位不再被新模型支持时必须仍可见可改，不能静默改写用户配置。 */}
									{pendingLevel ? <SelectItem value={thinkingLevel}>{thinkingLevel}（当前模型不支持）</SelectItem> : null}
									{levels.map((level) => (
										<SelectItem key={level} value={level}>
											{level}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<small>
								{graded ? "档位取自所选模型的 pi 原生映射；各 provider 的实际强度语义以服务商文档为准。" : "该模型只支持思考开/关，各档在链路上无差别。"}
							</small>
						</label>
					</div>
				</div>
				<small className="agent-config-hint">{SESSION_EFFECT_NOTE}</small>
			</section>
			{/* 运行资源 */}
			<section className="agent-config-card">
				<div className="agent-config-card-head"><h2>运行资源</h2><p>代码搜索与内置工具的加载方式。</p></div>
				<div className="flex flex-col gap-1">
					<label className="agent-config-field">
						<span>代码搜索</span>
						<Select value={draft.manager.codeSearch ?? "off"} onValueChange={(value) => onChange({ manager: { ...draft.manager, codeSearch: value as PiManagerSettings["codeSearch"] } })}>
							<SelectTrigger className="w-full"><SelectValue placeholder="关闭（默认）" /></SelectTrigger>
							<SelectContent><SelectItem value="off">关闭（默认）</SelectItem><SelectItem value="builtin">Pi 内置 grep/find</SelectItem><SelectItem value="fff">FFF Workspace 索引</SelectItem></SelectContent>
						</Select>
						<small>仅 Solo Manager 生效；Direct/Group relay 始终关闭搜索。</small>
					</label>
					<ToggleRow
						label="启用内置工具"
						hint="关闭后不注册 read/bash/edit 等内置工具"
						checked={draft.manager.builtinTools ?? true}
						onChange={(v) => onChange({ manager: { ...draft.manager, builtinTools: v } })}
					/>
					<ToggleRow
						label="加载 Pi 原生插件"
						hint="关闭后只使用平台注入的提示词与能力"
						checked={!draft.manager.noExtensions}
						onChange={(v) => onChange({ manager: { ...draft.manager, noExtensions: !v } })}
					/>
				</div>
			</section>
		</div>
	);
}

export function ModelSection({
	agent,
	draft,
	onChange,
}: {
	agent: AgentConfig;
	draft: ConfigDraft;
	onChange: (patch: Partial<ConfigDraft>) => void;
}) {
	const [schema, setSchema] = useState<Record<string, unknown> | null>(null);
	const [schemaError, setSchemaError] = useState<string | null>(null);
	const [schemaAttempt, setSchemaAttempt] = useState(0);
	useEffect(() => {
		if (agent.pinned) return;
		let cancelled = false;
		listExtensionCatalog("connector")
			.then((entries) => {
				if (cancelled) return;
				const entry = entries.find(
					(item) =>
						item.manifest.kind === "connector" &&
						item.manifest.id === agent.connector?.extensionId &&
						item.manifest.connector.id === agent.connector?.connectorId,
				);
				setSchema(
					entry && entry.manifest.kind === "connector"
						? (entry.manifest.connector.configSchema ?? PI_FALLBACK_SCHEMA)
						: PI_FALLBACK_SCHEMA,
				);
				setSchemaError(null);
			})
			.catch((err: unknown) => {
				if (!cancelled) setSchemaError(err instanceof Error ? err.message : String(err));
			});
		return () => { cancelled = true; };
	}, [agent.pinned, agent.connector?.connectorId, agent.connector?.extensionId, schemaAttempt]);

	if (agent.pinned) return <ManagerFields draft={draft} onChange={onChange} />;

	return (
		<div>
			{/* 连接插件声明的运行参数：字段标签来自 schema title，不再暴露原始 key。
			    分区名沿用原型的「模型 / 运行资源」，生效时机作为分区级提示收在末尾。 */}
			<section className="agent-config-card">
				<div className="agent-config-card-head"><h2>模型</h2><p>选择此智能体使用的模型与思考强度。</p></div>
				{schemaError ? (
					<div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
						<span>无法确认连接插件运行参数：{schemaError}</span>
						<Button size="sm" variant="outline" onClick={() => { setSchema(null); setSchemaError(null); setSchemaAttempt((attempt) => attempt + 1); }}>重试读取</Button>
					</div>
				) : schema === null ? (
					<p className="text-xs text-muted-foreground">加载配置 schema…</p>
				) : (
					<ConfigSchemaForm
						schema={schema}
						value={draft.connectorConfig}
						onChange={(next) => onChange({ connectorConfig: next })}
					/>
				)}
				<small className="agent-config-hint">{SESSION_EFFECT_NOTE}</small>
			</section>
			<section className="agent-config-card">
				{/* 单字段分区不写副标题：只会把字段名再说一遍（原型 model 分区的
				    「运行资源」同样没有副标题）。副标题只留给"这一节在解决什么问题"。 */}
				<div className="agent-config-card-head"><h2>运行资源</h2></div>
				<label className="agent-config-field">
					<span>代码搜索</span>
					<Select value={draft.codeSearch} onValueChange={(value) => onChange({ codeSearch: value as ConfigDraft["codeSearch"] })}>
						<SelectTrigger className="w-full"><SelectValue placeholder="继承 Harness 默认" /></SelectTrigger>
						<SelectContent><SelectItem value="inherit">继承 Harness 默认</SelectItem><SelectItem value="builtin">Pi 内置 grep/find</SelectItem><SelectItem value="fff">FFF Workspace 索引</SelectItem></SelectContent>
					</Select>
					<small>FFF 只索引当前已信任 Workspace，并按 Workspace 独立保存状态。</small>
				</label>
			</section>
		</div>
	);
}
