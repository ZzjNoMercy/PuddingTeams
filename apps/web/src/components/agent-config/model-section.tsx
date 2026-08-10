"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listExtensionCatalog, listModels } from "@/lib/api";
import type { AgentConfig, PiManagerSettings } from "@/lib/types";
import { ConfigSchemaForm } from "@/components/agents/form-parts";
import type { ConfigDraft } from "@/components/agent-config/draft";

/**
 * 模型与运行分区：pinned manager 渲染 PiManagerSettings 字段；pi worker 用
 * 该 Connector 的 configSchema（目录里拿，拿不回退到内置 pi schema）渲染
 * model/thinkingLevel/sessionDir。改动对新建/重开 Session 生效。
 */

const THINKING_LEVELS: Array<NonNullable<PiManagerSettings["thinkingLevel"]>> = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** 与 server pi-extension.ts 的 configSchema 同构的回退（目录不可用时兜底）。 */
const PI_FALLBACK_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		model: { type: "string", format: "model", description: "worker 使用的模型；留空用 pi 默认模型" },
		thinkingLevel: {
			type: "string",
			enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
			description: "thinking 级别（留空用 pi 默认）",
		},
		sessionDir: { type: "string", description: "会话存储目录（可选，默认派生到 pi 配置目录下）" },
	},
};

function ToggleRow({
	label,
	hint,
	checked,
	onChange,
}: {
	label: string;
	hint?: string;
	checked: boolean;
	onChange: (v: boolean) => void;
}) {
	return (
		<label className="flex items-start gap-2 text-sm">
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
				className="mt-0.5 size-4 accent-foreground"
			/>
			<span className="flex flex-col">
				<span>{label}</span>
				{hint ? <span className="text-xs text-muted-foreground/70">{hint}</span> : null}
			</span>
		</label>
	);
}

function ManagerFields({
	draft,
	onChange,
}: {
	draft: ConfigDraft;
	onChange: (patch: Partial<ConfigDraft>) => void;
}) {
	const [modelOptions, setModelOptions] = useState<string[]>([]);
	useEffect(() => {
		listModels()
			.then((models) => setModelOptions(models.map((m) => m.id)))
			.catch(() => undefined);
	}, []);
	const thinkingLevel = draft.manager.thinkingLevel ?? "default";
	return (
		<div className="flex flex-col gap-3 rounded-md bg-muted/60 p-3">
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">默认模型（provider/modelId）</span>
				<Input
					value={draft.manager.model ?? ""}
					onChange={(e) => onChange({ manager: { ...draft.manager, model: e.target.value } })}
					placeholder="如 anthropic/claude-sonnet-4-5；留空用运行时默认"
					className="font-mono text-xs"
					list="agent-config-model-options"
				/>
				<datalist id="agent-config-model-options">
					{modelOptions.map((id) => (
						<option key={id} value={id} />
					))}
				</datalist>
			</label>
			<ToggleRow
				label="启用内置工具"
				hint="关闭后不注册 read/bash/edit 等内置工具"
				checked={draft.manager.builtinTools ?? true}
				onChange={(v) => onChange({ manager: { ...draft.manager, builtinTools: v } })}
			/>
			<ToggleRow
				label="不加载 pi-native Extensions"
				checked={draft.manager.noExtensions ?? false}
				onChange={(v) => onChange({ manager: { ...draft.manager, noExtensions: v } })}
			/>
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">thinking level（运行时即改）</span>
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
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="default">默认（不设置）</SelectItem>
						{THINKING_LEVELS.map((level) => (
							<SelectItem key={level} value={level}>
								{level}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</label>
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
	useEffect(() => {
		if (agent.pinned) return;
		listExtensionCatalog("connector")
			.then((entries) => {
				const entry = entries.find(
					(item) =>
						item.manifest.kind === "connector" &&
						item.manifest.connector.id === agent.connector?.connectorId,
				);
				setSchema(
					entry && entry.manifest.kind === "connector"
						? (entry.manifest.connector.configSchema ?? PI_FALLBACK_SCHEMA)
						: PI_FALLBACK_SCHEMA,
				);
			})
			.catch((err: unknown) => {
				setSchema(PI_FALLBACK_SCHEMA);
				toast.error(err instanceof Error ? err.message : String(err));
			});
	}, [agent.pinned, agent.connector?.connectorId]);

	return (
		<div className="flex flex-col gap-3">
			<p className="text-xs text-muted-foreground">
				模型与运行参数对新建或重开的 Session 生效；进行中的 Session 保持旧配置。
			</p>
			{agent.pinned ? (
				<ManagerFields draft={draft} onChange={onChange} />
			) : schema === null ? (
				<p className="text-xs text-muted-foreground">加载配置 schema…</p>
			) : (
				<div className="rounded-md bg-muted/60 p-3">
					<ConfigSchemaForm
						schema={schema}
						value={draft.connectorConfig}
						onChange={(next) => onChange({ connectorConfig: next })}
					/>
				</div>
			)}
		</div>
	);
}
