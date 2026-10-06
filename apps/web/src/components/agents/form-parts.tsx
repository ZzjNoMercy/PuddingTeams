"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, ImagePlusIcon, LoaderIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	deleteAgentAvatar,
	deleteAgentSecret,
	getAgentSecrets,
	listAgentConnectorConfigOptions,
	listModels,
	setAgentSecrets,
	uploadAgentAvatar,
} from "@/lib/api";
import { agentAvatarChanged } from "@/lib/avatars";
import { isIMEComposing } from "@/lib/ime";
import { useModelCatalog } from "@/lib/model-catalog";
import { ManagerAvatar, WorkerAvatar } from "@/components/chat/worker-avatar";
import { agentDisplayName, type AgentConfig, type AffectedSessions, type DriverConfigOption, type ModelSummary, type SecretSchemaItem } from "@/lib/types";

/**
 * 共享表单件（§10.1）：
 * - ConfigSchemaForm：根据 manifest 的 configSchema（JSON Schema 子集）生成
 *   普通配置表单；schema 缺失或含复杂结构时回退 JSON 文本编辑；
 * - SecretSchemaFields：secret schema 单独输入，明文只在保存时提交，
 *   Agent 配置里只存 secretRefs；
 * - AffectedNote：写操作响应的 activeNow/reloadPending 如实展示。
 */

interface JsonSchemaProp {
	type?: string;
	title?: string;
	description?: string;
	/** 扩展注解："model" = 渲染为可用模型下拉（数据源 /api/models）。 */
	format?: string;
	/** Extension annotation: options are discovered by the bound Driver. */
	"x-puddingteams-options"?: string;
	/** Only render this field for the selected Connector transport(s). */
	"x-puddingteams-transports"?: string[];
	/** 运维向字段：保留在配置契约里，但配置页不生成表单。 */
	"x-puddingteams-hidden"?: boolean;
	/** Optional display labels for string enum values; persisted values stay unchanged. */
	"x-puddingteams-enum-labels"?: Record<string, string>;
	/** Only render this field when another schema field resolves to the given value. */
	"x-puddingteams-visible-when"?: {
		field: string;
		equals: string | number | boolean;
	};
	/**
	 * 把该 enum 收敛为「指定 model 字段所选模型实际支持的档位」。
	 *
	 * Connector 的 configSchema 是静态声明，只能给出归一化档位全集；某模型真正
	 * 支持哪些档位来自它自己的 `thinkingLevelMap`（`/api/models` 的
	 * `thinkingLevels`，并经平台能力表修正）。不收敛的话，用户能在只支持开/关的
	 * 模型上选到 `minimal`/`medium`，被 SDK 静默 clamp，看起来像设了其实没生效。
	 */
	"x-puddingteams-thinking-levels-from"?: string;
	enum?: unknown[];
	default?: unknown;
}

function isSchemaPropertyVisible(
	prop: JsonSchemaProp,
	props: Record<string, JsonSchemaProp>,
	value: Record<string, unknown>,
): boolean {
	// 运维向字段（如会话存储目录）：仍属于 connector 配置契约（API 可写、运行时
	// 可读、导入导出可带），但不在配置页生成表单。
	if (prop["x-puddingteams-hidden"]) return false;
	const condition = prop["x-puddingteams-visible-when"];
	if (!condition) return true;
	const controllingValue = value[condition.field] ?? props[condition.field]?.default;
	return controllingValue === condition.equals;
}

/** 提取可简单映射的 object properties；返回 null 表示需要 JSON 回退。 */
function simpleProperties(schema: Record<string, unknown> | undefined): Record<string, JsonSchemaProp> | null {
	if (!schema || typeof schema !== "object") return null;
	const props = schema.properties;
	if (!props || typeof props !== "object" || Array.isArray(props)) return null;
	const entries = Object.entries(props as Record<string, JsonSchemaProp>);
	if (entries.length === 0) return null;
	for (const [, prop] of entries) {
		if (!prop || typeof prop !== "object") return null;
		if (Array.isArray(prop.enum)) {
			if (!prop.enum.every((v) => typeof v === "string")) return null;
			continue;
		}
		if (!["string", "number", "integer", "boolean"].includes(prop.type ?? "")) return null;
	}
	return Object.fromEntries(entries);
}

/** JSON 文本回退编辑：只有解析为对象时才同步给父组件。 */
function JsonConfigEditor({
	value,
	onChange,
}: {
	value: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
}) {
	const [text, setText] = useState(() => JSON.stringify(value, null, 2));
	const [invalid, setInvalid] = useState(false);
	// 记录上次自己发出的值：父组件回写同一引用时不重置文本，避免打断输入；
	// 外部更新（切换 Agent/扩展）是新引用，正常同步。
	const lastEmitted = useRef(value);
	useEffect(() => {
		if (lastEmitted.current !== value) {
			lastEmitted.current = value;
			setText(JSON.stringify(value, null, 2));
			setInvalid(false);
		}
	}, [value]);
	return (
		<div className="flex flex-col gap-1">
			<Textarea
				autoComplete="off"
				autoCapitalize="none"
				autoCorrect="off"
				spellCheck={false}
				value={text}
				rows={4}
				className="font-mono text-xs"
				placeholder="{}"
				onChange={(e) => {
					const next = e.target.value;
					setText(next);
					try {
						const parsed: unknown = JSON.parse(next || "{}");
						if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
							setInvalid(false);
							lastEmitted.current = parsed as Record<string, unknown>;
							onChange(parsed as Record<string, unknown>);
						} else {
							setInvalid(true);
						}
					} catch {
						setInvalid(true);
					}
				}}
			/>
			{invalid ? <p className="text-xs text-destructive">不是合法的 JSON 对象，修改不会生效</p> : null}
		</div>
	);
}

/** 清除哨兵：非必填下拉选「不设置」时删除该 key（回落 connector 默认）。 */
const UNSET = "__unset__";

/**
 * format: "model" 的模型选择：数据源 /api/models（含自定义 provider 的模型）。
 * 目录有上百个模型，扁平下拉会撑满整个视口，所以按 provider 分组、二级菜单
 * 限高——与 composer 的模型选择器同一套交互与外观（.model-picker-*）。
 *
 * 导出给 Manager 的「模型与运行」分区复用：以前那里是 `<input list=datalist>`，
 * 而原生 datalist 会按输入框当前值给候选项排序、只露出排序窗口的前几项
 * （21 个模型里只看到 2 个 deepseek），外观也和 Worker 路径不一致。
 * 更关键的是自由输入本身就是死路：未知 id 在 `LocalPiDriver.resolveModel`
 * 会直接抛 `未知模型：xxx`，所以只提供目录里真实存在的选项，存档值已不在
 * 目录中时单列一条而不是让用户重新敲。
 */
export function ModelSelectField({
	label,
	mark,
	current,
	description,
	onSelect,
}: {
	label: string;
	/** schema 必填标记；非 schema 调用方（Manager 分区）没有 required 概念，可不传。 */
	mark?: React.ReactNode;
	current: unknown;
	description?: string;
	onSelect: (next: string | undefined) => void;
}) {
	const [models, setModels] = useState<ModelSummary[] | null>(null);
	useEffect(() => {
		let cancelled = false;
		listModels()
			.then((list) => {
				if (!cancelled) setModels(list);
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setModels([]);
					toast.error(err instanceof Error ? err.message : String(err));
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);
	const value = typeof current === "string" && current ? current : undefined;
	const known = models?.some((m) => m.id === value) ?? false;
	const selected = models?.find((m) => m.id === value);
	const byProvider = new Map<string, ModelSummary[]>();
	for (const model of models ?? []) {
		const group = byProvider.get(model.provider) ?? [];
		group.push(model);
		byProvider.set(model.provider, group);
	}
	return (
		<label className="agent-config-field">
			<span>
				{label}
				{mark}
			</span>
			{description ? <small>{description}</small> : null}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button type="button" variant="outline" className="agent-config-model-trigger">
						<span className="min-w-0 flex-1 truncate">
							{models === null
								? "加载模型中…"
								: selected
									? selected.name
									: value
										? `当前模型：${value}`
										: "不设置（用默认模型）"}
						</span>
						{selected ? <span className="agent-config-model-provider">{selected.provider}</span> : null}
						<ChevronDownIcon className="size-4 shrink-0 opacity-55" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent className="model-picker-menu" align="start" sideOffset={8}>
					<DropdownMenuItem className="model-picker-item" onSelect={() => onSelect(undefined)}>
						<span className="min-w-0 flex-1 truncate">不设置（用默认模型）</span>
						{value === undefined ? <CheckIcon className="model-picker-check size-4" /> : null}
					</DropdownMenuItem>
					{value !== undefined && !known ? (
						<DropdownMenuItem className="model-picker-item" onSelect={() => onSelect(value)}>
							<span className="min-w-0 flex-1 truncate">{value}</span>
							<span className="model-picker-note">当前值，目录中没有</span>
							<CheckIcon className="model-picker-check size-4" />
						</DropdownMenuItem>
					) : null}
					{[...byProvider.entries()].map(([provider, providerModels]) => (
						<DropdownMenuSub key={provider}>
							<DropdownMenuSubTrigger className="model-picker-provider-item">
								<span className="min-w-0 flex-1 truncate">{provider}</span>
								{providerModels.some((model) => model.id === value) ? <span className="model-picker-provider-active" aria-label="当前 Provider" /> : null}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="model-picker-submenu" sideOffset={8}>
								{providerModels.map((model) => (
									<DropdownMenuItem key={model.id} className="model-picker-item" onSelect={() => onSelect(model.id)}>
										<span className="min-w-0 flex-1 truncate">{model.name}</span>
										{model.id === value ? <CheckIcon className="model-picker-check size-4" /> : null}
									</DropdownMenuItem>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</label>
	);
}

function DriverOptionSelectField({
	agentName,
	field,
	label,
	mark,
	current,
	description,
	onSelect,
}: {
	agentName: string;
	field: string;
	label: string;
	mark: React.ReactNode;
	current: unknown;
	description?: string;
	onSelect: (next: string | undefined) => void;
}) {
	const [options, setOptions] = useState<DriverConfigOption[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let cancelled = false;
		listAgentConnectorConfigOptions(agentName, field)
			.then((list) => {
				if (!cancelled) {
					setOptions(list);
					setError(null);
				}
			})
			.catch((reason: unknown) => {
				if (!cancelled) {
					setOptions([]);
					setError(reason instanceof Error ? reason.message : String(reason));
				}
			});
		return () => {
			cancelled = true;
		};
	}, [agentName, field]);
	const value = typeof current === "string" && current ? current : UNSET;
	const known = options?.some((option) => option.value === value) ?? false;
	return (
		<label className="agent-config-field">
			<span>{label}{mark}</span>
			{error ? (
				<Input
					value={typeof current === "string" ? current : ""}
					onChange={(event) => onSelect(event.target.value || undefined)}
					placeholder="模型 ID"
				/>
			) : (
				<Select value={value} onValueChange={(next) => onSelect(next === UNSET ? undefined : next)}>
					<SelectTrigger className="w-full">
						<SelectValue placeholder={options === null ? "正在读取模型…" : "请选择模型"} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={UNSET}>不设置（使用 worker 默认模型）</SelectItem>
						{value !== UNSET && !known ? <SelectItem value={value}>{value}（当前值）</SelectItem> : null}
						{(options ?? []).map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}{option.isDefault ? " · 默认" : ""}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			)}
			{error ? <span className="text-xs text-amber-600">模型列表读取失败，可手动输入：{error}</span> : null}
			{description ? <small>{description}</small> : null}
		</label>
	);
}

/**
 * enum 字段（思考强度等）：选项按 x-puddingteams-thinking-levels-from 指向的模型
 * 收敛（与 composer / Manager 表单共用同一份 thinkingLevels map）。已存档位
 * 不再被新模型支持时仍必须可见可改，不能静默改写用户配置。
 */
function EnumSelectField({
	fieldKey,
	prop,
	value,
	props,
	required,
	catalogLevels,
	catalogGraded,
	onChange,
}: {
	fieldKey: string;
	prop: JsonSchemaProp;
	value: Record<string, unknown>;
	props: Record<string, JsonSchemaProp>;
	required: string[];
	catalogLevels: string[];
	catalogGraded: boolean;
	onChange: (next: Record<string, unknown>) => void;
}) {
	const current = value[fieldKey];
	const defaultValue = typeof prop.default === "string" ? prop.default : undefined;
	const enumValue = typeof current === "string" && current ? current : defaultValue ?? UNSET;
	const enumLabels = prop["x-puddingteams-enum-labels"] ?? {};
	const levelsFrom = prop["x-puddingteams-thinking-levels-from"];
	const modelRef = levelsFrom ? value[levelsFrom] : undefined;
	const declared = prop.enum as string[];
	const options = levelsFrom && typeof modelRef === "string" && modelRef.trim()
		? declared.filter((option) => catalogLevels.includes(option))
		: declared;
	const staleValue = typeof current === "string" && current && !options.includes(current) && declared.includes(current);
	return (
		<label className="agent-config-field">
			<span>
				{prop.title ?? fieldKey}
				{required.includes(fieldKey) ? <span className="text-destructive"> *</span> : null}
			</span>
			{/* 说明写在标题下面：解释"这个字段是干什么的"；控件下面只留随当前值
			    变化的动态提示（例如某个模型不支持分档）。 */}
			{prop.description ? <small>{prop.description}</small> : null}
			<Select
				value={enumValue}
				onValueChange={(v) => {
					const updated = { ...value };
					if (v === UNSET) delete updated[fieldKey];
					else updated[fieldKey] = v;
					for (const [dependentKey, dependentProp] of Object.entries(props)) {
						if (dependentProp["x-puddingteams-visible-when"]?.field === fieldKey
							&& !isSchemaPropertyVisible(dependentProp, props, updated)) {
							delete updated[dependentKey];
						}
					}
					onChange(updated);
				}}
			>
				<SelectTrigger className="w-full">
					<SelectValue placeholder="请选择" />
				</SelectTrigger>
				<SelectContent>
					{required.includes(fieldKey) || defaultValue ? null : <SelectItem value={UNSET}>不设置（默认）</SelectItem>}
					{staleValue ? <SelectItem value={current as string}>{current as string}（当前模型不支持）</SelectItem> : null}
					{options.map((option) => (
						<SelectItem key={option} value={option}>
							{enumLabels[option] ?? option}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{levelsFrom && typeof modelRef === "string" && modelRef.trim() && !catalogGraded ? (
				<small>该模型只支持思考开/关，各档在链路上无差别。</small>
			) : null}
		</label>
	);
}

/** 根据 configSchema 渲染配置表单（受控）。 */
export function ConfigSchemaForm({
	schema,
	value,
	onChange,
	agentName,
	transport,
}: {
	schema: Record<string, unknown> | undefined;
	value: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
	/** Existing Agent binding used for Driver-owned dynamic config options. */
	agentName?: string;
	/** Concrete transport selected by this Agent binding. */
	transport?: string;
}) {
	const props = simpleProperties(schema);
	// 思考强度档位与 composer / Manager 表单同源；只有声明了
	// x-puddingteams-thinking-levels-from 的字段会用到它。
	const catalog = useModelCatalog();
	if (!props) {
		// 无 schema 或含数组/嵌套对象等复杂结构：回退 JSON 文本。
		return <JsonConfigEditor value={value} onChange={onChange} />;
	}
	const required = Array.isArray(schema?.required) ? (schema.required as unknown[]).filter((v) => typeof v === "string") : [];
	// 收敛发生在每个字段自己的 render 内（按 x-puddingteams-thinking-levels-from
	// 指向的 model 字段取值），这里只把目录能力传下去。
	const catalogLevels = catalog.levelsFor(String(value.model ?? ""));
	const catalogGraded = catalog.gradedFor(String(value.model ?? ""));
	const isFieldVisible = (key: string, prop: JsonSchemaProp) => {
		const transportVisible = !Array.isArray(prop["x-puddingteams-transports"])
			|| !transport
			|| prop["x-puddingteams-transports"]!.includes(transport);
		return transportVisible && isSchemaPropertyVisible(prop, props, value);
	};
	// 与模型配对、要在模型右侧并排渲染的字段（当前是思考强度）。两侧都可见才配对，
	// 否则配对的一方单独消失会留下空洞。
	const pairedLevelKeys = new Set(
		Object.entries(props)
			.filter(([key, prop]) => {
				const from = prop["x-puddingteams-thinking-levels-from"];
				const modelProp = from ? props[from] : undefined;
				return Boolean(from && modelProp?.format === "model" && isFieldVisible(key, prop) && isFieldVisible(from, modelProp));
			})
			.map(([key]) => key),
	);
	return (
		<div className="agent-config-form agent-config-fields">
			{Object.entries(props)
				.filter(([key, prop]) => !pairedLevelKeys.has(key) && isFieldVisible(key, prop))
				.map(([key, prop]) => {
				const label = prop.title ?? key;
				const current = value[key];
				const mark = required.includes(key) ? <span className="text-destructive"> *</span> : null;
				if (prop["x-puddingteams-options"] === "driver" && agentName) {
					return (
						<DriverOptionSelectField
							key={key}
							agentName={agentName}
							field={key}
							label={label}
							mark={mark}
							current={current}
							description={prop.description}
							onSelect={(next) => {
								const updated = { ...value };
								if (next === undefined) delete updated[key];
								else updated[key] = next;
								onChange(updated);
							}}
						/>
					);
				}
				if (prop.format === "model" && (prop.type === "string" || prop.type === undefined)) {
					const levelEntry = Object.entries(props).find(([, candidate]) => candidate["x-puddingteams-thinking-levels-from"] === key);
					const pairLevel = levelEntry && pairedLevelKeys.has(levelEntry[0]) ? levelEntry : undefined;
					const modelField = (
						<ModelSelectField
							key={key}
							label={label}
							mark={mark}
							current={current}
							description={prop.description}
							onSelect={(next) => {
								const updated = { ...value };
								if (next === undefined) delete updated[key];
								else updated[key] = next;
								onChange(updated);
							}}
						/>
					);
					if (!pairLevel) return modelField;
					// 模型与思考强度是同一件事的两面（选模型 + 选它的档位），并排一行，
					// 沿用原型的 .form-columns；各占一整行会把这一节拉得过长。
					return (
						<div className="agent-config-columns" key={`${key}-pair`}>
							{modelField}
							<EnumSelectField
								fieldKey={pairLevel[0]}
								prop={pairLevel[1]}
								value={value}
								props={props}
								required={required}
								catalogLevels={catalogLevels}
								catalogGraded={catalogGraded}
								onChange={onChange}
							/>
						</div>
					);
				}
			if (prop.type === "boolean") {
				return (
					<label key={key} className="agent-config-toggle">
						<span>
							<strong>{label}</strong>
							{prop.description ? <small>{prop.description}</small> : null}
						</span>
						<input
							type="checkbox"
							role="switch"
							checked={Boolean(current ?? prop.default ?? false)}
							onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
						/>
						{mark}
					</label>
				);
			}
			if (Array.isArray(prop.enum)) {
				return (
					<EnumSelectField
						key={key}
						fieldKey={key}
						prop={prop}
						value={value}
						props={props}
						required={required}
						catalogLevels={catalogLevels}
						catalogGraded={catalogGraded}
						onChange={onChange}
					/>
				);
			}
				if (prop.type === "number" || prop.type === "integer") {
					return (
						<label key={key} className="agent-config-field">
							<span>
								{label}
								{mark}
							</span>
							<Input
								type="number"
								autoComplete="off"
								value={typeof current === "number" ? String(current) : ""}
								onChange={(e) => {
									const raw = e.target.value;
									onChange({ ...value, [key]: raw === "" ? undefined : Number(raw) });
								}}
							/>
						</label>
					);
				}
				return (
					<label key={key} className="agent-config-field">
						<span>
							{label}
							{mark}
						</span>
						<Input
							autoComplete="off"
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							value={typeof current === "string" ? current : ""}
							placeholder={prop.description}
							onChange={(e) => onChange({ ...value, [key]: e.target.value })}
						/>
					</label>
				);
			})}
		</div>
	);
}

/**
 * secret schema 单独输入区：已配置的 key 只显示「已配置」（值不会回传），
 * 新值以明文收集，保存时随写操作提交，服务端只存 secretRefs。
 */
export function SecretSchemaFields({
	schema,
	configuredKeys,
	values,
	onChange,
}: {
	schema: SecretSchemaItem[] | undefined;
	configuredKeys: string[];
	values: Record<string, string>;
	onChange: (next: Record<string, string>) => void;
}) {
	if (!schema || schema.length === 0) return null;
	return (
		<div className="flex flex-col gap-3">
			<span className="text-xs text-muted-foreground">密钥（加密存储，只存引用）</span>
			{schema.map((item) => {
				const configured = configuredKeys.includes(item.key);
				return (
					<label key={item.key} className="agent-config-field">
						<span className="flex flex-wrap items-center gap-2">
							{item.label}
							<code className="font-mono text-[10px] text-muted-foreground">{item.key}</code>
							{item.required ? <span className="text-destructive">*</span> : null}
							{configured ? <span className="text-[10px] text-muted-foreground/70">已配置</span> : null}
						</span>
						<Input
							type="password"
							autoComplete="new-password"
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							value={values[item.key] ?? ""}
							placeholder={configured ? "已配置，输入新值覆盖" : "输入密钥值"}
							className="font-mono text-xs"
							onChange={(e) => {
								const next = { ...values };
								if (e.target.value) next[item.key] = e.target.value;
								else delete next[item.key];
								onChange(next);
							}}
						/>
					</label>
				);
			})}
		</div>
	);
}

/** 写操作响应的受影响 Session 统计（§10.1 如实展示）。 */
export function AffectedNote({ affected }: { affected: AffectedSessions }) {
	if (affected.affectedSessions === 0) {
		return <p className="text-xs text-muted-foreground">没有正在使用旧配置的 manager 会话。</p>;
	}
	return (
		<p className="text-xs text-muted-foreground">
			已撤权：{affected.affectedSessions} 个 manager 会话受影响（{affected.activeNow} 个立即生效，
			{affected.reloadPending} 个将在当前回合结束后刷新）。
		</p>
	);
}

/** 头像编辑（§11）：预览 + 上传 + 删除；worker 与 pinned manager 共用。 */
export function AvatarEditor({
	agent,
	onUpdated,
}: {
	agent: AgentConfig;
	onUpdated: (agent: AgentConfig) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const mutationRef = useRef(false);

	const handleFile = async (file: File) => {
		if (mutationRef.current) return;
		mutationRef.current = true;
		setBusy(true);
		try {
			const updated = await uploadAgentAvatar(agent.name, file);
			agentAvatarChanged(agent.name, true);
			onUpdated(updated);
			toast.success(`「${agentDisplayName(agent)}」头像已更新`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			mutationRef.current = false;
			setBusy(false);
			if (inputRef.current) inputRef.current.value = "";
		}
	};

	const handleRemove = async () => {
		if (mutationRef.current) return;
		mutationRef.current = true;
		setBusy(true);
		try {
			const updated = await deleteAgentAvatar(agent.name);
			// 删除上传后由展示组件决定使用 Connector 或产品默认头像。
			agentAvatarChanged(agent.name, false);
			onUpdated(updated);
			toast.success(`「${agentDisplayName(agent)}」头像已删除，回落默认头像`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			mutationRef.current = false;
			setBusy(false);
		}
	};

	return (
		<div className="flex items-center gap-3">
			{agent.pinned ? <ManagerAvatar size={56} /> : <WorkerAvatar name={agent.name} size={56} />}
			<div className="flex flex-col gap-1.5">
				<div className="flex items-center gap-2">
					<input
						ref={inputRef}
						type="file"
						accept="image/png,image/jpeg,image/webp,image/gif"
						className="hidden"
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (file) void handleFile(file);
						}}
					/>
					<Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => inputRef.current?.click()}>
						{busy ? <LoaderIcon className="size-3.5 animate-spin" /> : <ImagePlusIcon className="size-3.5" />}
						上传头像
					</Button>
					{agent.avatar ? (
						<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void handleRemove()}>
							<XIcon className="size-3.5" />
							删除
						</Button>
					) : null}
				</div>
				<p className="text-xs text-muted-foreground">
					png / jpg / webp / gif，最大 2MB；未上传时使用{agent.pinned ? " PuddingTeams 默认头像" : agent.hasDefaultAvatar ? "内置默认头像" : "程序化默认头像"}。
				</p>
			</div>
		</div>
	);
}

/** legacy env-token 密钥编辑（加密存 ~/.puddingteams，派活时注入 env）。 */
export function SecretsEditor({ agent }: { agent: AgentConfig }) {
	const [configured, setConfigured] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loadRevision, setLoadRevision] = useState(0);
	const [keyName, setKeyName] = useState("");
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const mutationRef = useRef(false);
	const retryLoad = () => {
		setLoading(true);
		setLoadError(null);
		setLoadRevision((revision) => revision + 1);
	};

	useEffect(() => {
		let cancelled = false;
		getAgentSecrets(agent.name)
			.then((keys) => {
				if (!cancelled) {
					setConfigured(keys);
					setLoadError(null);
				}
			})
			.catch((err: unknown) => {
				if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [agent.name, loadRevision]);

	const handleSave = async () => {
		const key = keyName.trim();
		if (!key || !value || mutationRef.current) return;
		mutationRef.current = true;
		setBusy(true);
		try {
			const keys = await setAgentSecrets(agent.name, { [key]: value });
			setConfigured(keys);
			setKeyName("");
			setValue("");
			toast.success(`「${key}」已加密保存`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			mutationRef.current = false;
			setBusy(false);
		}
	};

	const handleRemove = async (key: string) => {
		if (mutationRef.current) return;
		mutationRef.current = true;
		setBusy(true);
		try {
			await deleteAgentSecret(agent.name, key);
			setConfigured((prev) => prev.filter((k) => k !== key));
			toast.success(`「${key}」已清除`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			mutationRef.current = false;
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<span className="text-sm text-muted-foreground">令牌 / 密钥（加密存储）</span>
			</div>
			<p className="text-xs text-muted-foreground/70">
				AES-256 加密保存到 <code className="font-mono">~/.puddingteams</code>，不写入 teams.json；派活时注入该
				worker 的环境变量。值不会回传前端，只能重设或清除。
			</p>
			{loading ? (
				<div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
					<LoaderIcon className="size-3.5 animate-spin" />
					加载中…
				</div>
			) : loadError ? (
				<div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
					<span>无法读取已配置密钥：{loadError}</span>
					<Button type="button" size="sm" variant="outline" onClick={retryLoad}>重试读取</Button>
				</div>
			) : (
				<>
					{configured.length > 0 ? (
						<div className="flex flex-col gap-1">
							{configured.map((key) => (
								<div key={key} className="flex items-center gap-2">
									<code className="min-w-0 flex-1 truncate font-mono text-xs">{key}</code>
									<span className="shrink-0 text-xs text-muted-foreground">已配置</span>
									<Button
										type="button"
										size="sm"
										variant="ghost"
										disabled={busy}
										onClick={() => void handleRemove(key)}
									>
										清除
									</Button>
								</div>
							))}
						</div>
					) : (
						<p className="text-xs text-muted-foreground/60">尚未配置。仅添加当前命令明确要求的环境变量。</p>
					)}
					<div className="flex flex-col gap-1.5">
						<Input
							autoComplete="off"
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							value={keyName}
							onChange={(e) => setKeyName(e.target.value)}
							placeholder="变量名，如 GITHUB_TOKEN"
							className="font-mono text-xs"
						/>
						<div className="flex items-center gap-1.5">
							<Input
								type="password"
								autoComplete="new-password"
								autoCapitalize="none"
								autoCorrect="off"
								spellCheck={false}
								value={value}
								onChange={(e) => setValue(e.target.value)}
								placeholder="令牌值"
								className="flex-1 font-mono text-xs"
								onKeyDown={(e) => {
									if (e.key !== "Enter" || e.repeat || isIMEComposing(e)) return;
									e.preventDefault();
									void handleSave();
								}}
							/>
							<Button type="button" size="sm" disabled={busy || !keyName.trim() || !value} onClick={() => void handleSave()}>
								{busy ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
								保存
							</Button>
						</div>
					</div>
				</>
			)}
		</div>
	);
}
