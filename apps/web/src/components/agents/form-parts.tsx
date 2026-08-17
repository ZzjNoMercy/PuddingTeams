"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlusIcon, LoaderIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
	deleteAgentAvatar,
	deleteAgentSecret,
	getAgentSecrets,
	listModels,
	setAgentSecrets,
	uploadAgentAvatar,
} from "@/lib/api";
import { agentAvatarChanged } from "@/lib/avatars";
import { ManagerAvatar, WorkerAvatar } from "@/components/chat/worker-avatar";
import type { AgentConfig, AffectedSessions, ModelSummary, SecretSchemaItem } from "@/lib/types";

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
	enum?: unknown[];
	default?: unknown;
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

/** format: "model" 的模型下拉：数据源 /api/models（含自定义 provider 的模型）。 */
function ModelSelectField({
	label,
	mark,
	current,
	description,
	onSelect,
}: {
	label: string;
	mark: React.ReactNode;
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
	const value = typeof current === "string" && current ? current : UNSET;
	const known = models?.some((m) => m.id === value) ?? false;
	return (
		<label className="flex flex-col gap-1 text-sm">
			<span className="text-muted-foreground">
				{label}
				{mark}
			</span>
			<Select value={value} onValueChange={(v) => onSelect(v === UNSET ? undefined : v)}>
				<SelectTrigger className="w-full">
					<SelectValue placeholder={models === null ? "加载模型中…" : "请选择模型"} />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value={UNSET}>不设置（用默认模型）</SelectItem>
					{value !== UNSET && !known ? <SelectItem value={value}>{value}（当前值，目录中没有）</SelectItem> : null}
					{(models ?? []).map((m) => (
						<SelectItem key={m.id} value={m.id}>
							{m.name} · {m.provider}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{description ? <span className="text-xs text-muted-foreground/70">{description}</span> : null}
		</label>
	);
}

/** 根据 configSchema 渲染配置表单（受控）。 */
export function ConfigSchemaForm({
	schema,
	value,
	onChange,
}: {
	schema: Record<string, unknown> | undefined;
	value: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
}) {
	const props = simpleProperties(schema);
	if (!props) {
		// 无 schema 或含数组/嵌套对象等复杂结构：回退 JSON 文本。
		return <JsonConfigEditor value={value} onChange={onChange} />;
	}
	const required = Array.isArray(schema?.required) ? (schema.required as unknown[]).filter((v) => typeof v === "string") : [];
	return (
		<div className="flex flex-col gap-2">
			{Object.entries(props).map(([key, prop]) => {
				const label = prop.title ?? key;
				const current = value[key];
				const mark = required.includes(key) ? <span className="text-destructive"> *</span> : null;
				if (prop.format === "model" && (prop.type === "string" || prop.type === undefined)) {
					return (
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
				}
				if (prop.type === "boolean") {
					return (
						<label key={key} className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={Boolean(current ?? prop.default ?? false)}
								onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
								className="size-4 accent-foreground"
							/>
							<span className="text-muted-foreground">{label}</span>
							{mark}
						</label>
					);
				}
				if (Array.isArray(prop.enum)) {
					const enumValue = typeof current === "string" && current ? current : UNSET;
					return (
						<label key={key} className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">
								{label}
								{mark}
							</span>
							<Select
								value={enumValue}
								onValueChange={(v) => {
									const updated = { ...value };
									if (v === UNSET) delete updated[key];
									else updated[key] = v;
									onChange(updated);
								}}
							>
								<SelectTrigger className="w-full">
									<SelectValue placeholder="请选择" />
								</SelectTrigger>
								<SelectContent>
									{required.includes(key) ? null : <SelectItem value={UNSET}>不设置（默认）</SelectItem>}
									{(prop.enum as string[]).map((option) => (
										<SelectItem key={option} value={option}>
											{option}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							{prop.description ? <span className="text-xs text-muted-foreground/70">{prop.description}</span> : null}
						</label>
					);
				}
				if (prop.type === "number" || prop.type === "integer") {
					return (
						<label key={key} className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">
								{label}
								{mark}
							</span>
							<Input
								type="number"
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
					<label key={key} className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">
							{label}
							{mark}
						</span>
						<Input
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
		<div className="flex flex-col gap-2">
			<span className="text-sm text-muted-foreground">密钥（加密存储，只存引用）</span>
			{schema.map((item) => {
				const configured = configuredKeys.includes(item.key);
				return (
					<label key={item.key} className="flex flex-col gap-1 text-sm">
						<span className="flex items-center gap-2 text-muted-foreground">
							{item.label}
							<code className="font-mono text-xs">{item.key}</code>
							{item.required ? <span className="text-destructive">*</span> : null}
							{configured ? <span className="text-xs text-muted-foreground/70">已配置</span> : null}
						</span>
						<Input
							type="password"
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

	const handleFile = async (file: File) => {
		setBusy(true);
		try {
			const updated = await uploadAgentAvatar(agent.name, file);
			agentAvatarChanged(agent.name, true);
			onUpdated(updated);
			toast.success(`「${agent.name}」头像已更新`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
			if (inputRef.current) inputRef.current.value = "";
		}
	};

	const handleRemove = async () => {
		setBusy(true);
		try {
			await deleteAgentAvatar(agent.name);
			// 删除上传后由展示组件决定使用 Connector 或产品默认头像。
			agentAvatarChanged(agent.name, false);
			onUpdated({ ...agent, avatar: undefined });
			toast.success(`「${agent.name}」头像已删除，回落默认头像`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
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
					png / jpg / webp / gif，最大 2MB；未上传时使用{agent.pinned ? " PuddingTeams 默认头像" : agent.hasDefaultAvatar ? " Connector 默认头像" : "程序化默认头像"}。
				</p>
			</div>
		</div>
	);
}

/** legacy env-token 密钥编辑（加密存 ~/.puddingteams，派活时注入 env）。 */
export function SecretsEditor({ agent }: { agent: AgentConfig }) {
	const [configured, setConfigured] = useState<string[]>([]);
	const [loading, setLoading] = useState(true);
	const [keyName, setKeyName] = useState("");
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		let cancelled = false;
		getAgentSecrets(agent.name)
			.then((keys) => {
				if (!cancelled) setConfigured(keys);
			})
			.catch((err: unknown) => {
				if (!cancelled) toast.error(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [agent.name]);

	const handleSave = async () => {
		const key = keyName.trim();
		if (!key || !value) return;
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
			setBusy(false);
		}
	};

	const handleRemove = async (key: string) => {
		setBusy(true);
		try {
			await deleteAgentSecret(agent.name, key);
			setConfigured((prev) => prev.filter((k) => k !== key));
			toast.success(`「${key}」已清除`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
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
						<p className="text-xs text-muted-foreground/60">尚未配置。例如 PuddingClaw 需要 PUDDINGCLAW_TOKEN。</p>
					)}
					<div className="flex flex-col gap-1.5">
						<Input
							value={keyName}
							onChange={(e) => setKeyName(e.target.value)}
							placeholder="变量名，如 PUDDINGCLAW_TOKEN"
							className="font-mono text-xs"
						/>
						<div className="flex items-center gap-1.5">
							<Input
								type="password"
								value={value}
								onChange={(e) => setValue(e.target.value)}
								placeholder="令牌值"
								className="flex-1 font-mono text-xs"
								onKeyDown={(e) => {
									if (e.key === "Enter") void handleSave();
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
