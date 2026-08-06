"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlusIcon, LoaderIcon, PlusIcon, RefreshCwIcon, TrashIcon, UserCheckIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createAgent, deleteAgent, deleteAgentAvatar, deleteAgentSecret, getAgentSecrets, listAgents, probeAgent, setAgentSecrets, updateAgent, uploadAgentAvatar } from "@/lib/api";
import { agentAvatarChanged, agentRemoved, useAgentAvatar } from "@/lib/avatars";
import type { AgentConfig, WorkerProbeResult } from "@/lib/types";
import { WorkerAvatar } from "@/components/chat/worker-avatar";

function parseArgs(text: string): string[] {
	return text
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function argsText(args: string[] | undefined): string {
	return (args ?? []).join(", ");
}

/** Encrypted env-token store (~/.puddingteams). Values never leave the server. */
function SecretsEditor({ agent }: { agent: AgentConfig }) {
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

/** Avatar picker inside the edit drawer (§11): preview + upload + delete. */
function AvatarEditor({
	agent,
	onUpdated,
}: {
	agent: AgentConfig;
	onUpdated: (agent: AgentConfig) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const avatarUrl = useAgentAvatar(agent.name);

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
			<WorkerAvatar name={agent.name} size={56} />
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
					{avatarUrl ? (
						<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void handleRemove()}>
							<XIcon className="size-3.5" />
							删除
						</Button>
					) : null}
				</div>
				<p className="text-xs text-muted-foreground">png / jpg / webp / gif，最大 2MB；未上传时使用程序化默认头像。</p>
			</div>
		</div>
	);
}

function AgentForm({
	initial,
	onSubmit,
	onCancel,
	onAgentUpdated,
}: {
	initial: AgentConfig | null;
	onSubmit: (agent: AgentConfig) => Promise<void>;
	onCancel: () => void;
	onAgentUpdated: (agent: AgentConfig) => void;
}) {
	const [name, setName] = useState(initial?.name ?? "");
	const [description, setDescription] = useState(initial?.description ?? "");
	const [command, setCommand] = useState(initial?.invoke.command ?? "");
	const [runArgs, setRunArgs] = useState(argsText(initial?.invoke.runArgs));
	const [probeArgs, setProbeArgs] = useState(argsText(initial?.invoke.probeArgs));
	const [envText, setEnvText] = useState(initial?.env ? JSON.stringify(initial.env, null, 2) : "");
	const [enabled, setEnabled] = useState(initial?.enabled ?? true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = async () => {
		setError(null);
		if (!name.trim()) return setError("名称必填");
		if (!command.trim()) return setError("命令必填");
		let env: Record<string, string> | undefined;
		if (envText.trim()) {
			try {
				const parsed = JSON.parse(envText);
				if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("env 需要是对象");
				env = parsed as Record<string, string>;
			} catch {
				return setError("env 不是合法的 JSON 对象");
			}
		}
		setSaving(true);
		try {
			await onSubmit({
				name: name.trim(),
				description: description.trim(),
				invoke: {
					type: "command",
					command: command.trim(),
					runArgs: parseArgs(runArgs),
					probeArgs: probeArgs.trim() ? parseArgs(probeArgs) : undefined,
				},
				...(env ? { env } : {}),
				enabled,
				// 保存表单时保留头像字段，否则会把 teams.json 里的 avatar 覆盖掉。
				...(initial?.avatar ? { avatar: initial.avatar } : {}),
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex flex-col gap-3">
			{initial ? (
				<>
					<AvatarEditor agent={initial} onUpdated={onAgentUpdated} />
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">名称（不可修改）</span>
						<Input value={name} disabled />
					</label>
				</>
			) : (
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">名称（唯一标识，team_task 用）</span>
					<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 puddingclaw" />
					<span className="text-xs text-muted-foreground/70">保存后即可上传头像。</span>
				</label>
			)}
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">描述</span>
				<Textarea
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					placeholder="给 manager 看的 worker 能力描述"
					rows={2}
				/>
			</label>
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">命令（可执行文件或绝对路径）</span>
				<Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="puddingclaw" />
			</label>
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">run 参数（逗号或换行分隔）</span>
				<Input
					value={runArgs}
					onChange={(e) => setRunArgs(e.target.value)}
					placeholder='run, --input-json, -, --json'
				/>
			</label>
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">健康探测参数（可选，默认 doctor --json）</span>
				<Input
					value={probeArgs}
					onChange={(e) => setProbeArgs(e.target.value)}
					placeholder="doctor, --json"
				/>
			</label>
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">环境变量（JSON 对象，可选）</span>
				<Textarea
					value={envText}
					onChange={(e) => setEnvText(e.target.value)}
					placeholder='{"PUDDINGCLAW_URL": "http://127.0.0.1:8888"}'
					rows={2}
					className="font-mono text-xs"
				/>
			</label>
			{initial ? <SecretsEditor key={initial.name} agent={initial} /> : null}
			<label className="flex items-center gap-2 text-sm">
				<input
					type="checkbox"
					checked={enabled}
					onChange={(e) => setEnabled(e.target.checked)}
					className="size-4 accent-foreground"
				/>
				启用（勾选后 manager 才可派活给它）
			</label>
			{error ? <p className="text-xs text-destructive">{error}</p> : null}
			<DialogFooter>
				<Button type="button" variant="ghost" onClick={onCancel}>
					取消
				</Button>
				<Button type="button" onClick={handleSubmit} disabled={saving}>
					{saving ? "保存中…" : "保存"}
				</Button>
			</DialogFooter>
		</div>
	);
}

function ProbeResult({ result }: { result: WorkerProbeResult }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-2">
				<Badge variant={result.ok ? "secondary" : "destructive"}>
					{result.ok ? "健康" : "异常"}
				</Badge>
				<span className="text-xs text-muted-foreground">exit {result.exitCode}</span>
				<button type="button" className="text-xs text-muted-foreground underline" onClick={() => setOpen((o) => !o)}>
					{open ? "收起" : "详情"}
				</button>
			</div>
			{result.error ? <p className="text-xs text-destructive">{result.error}</p> : null}
			{open ? (
				<pre className="overflow-x-auto rounded-md bg-muted/60 p-2 text-xs">{JSON.stringify(result.raw, null, 2)}</pre>
			) : null}
		</div>
	);
}

/** Enabled / health status lights (§11): green = on, grey = off, red = probe failed. */
function StatusLights({ agent, probe }: { agent: AgentConfig; probe?: WorkerProbeResult }) {
	return (
		<span className="flex items-center gap-1.5">
			<span
				className={`size-2 rounded-full ${agent.enabled ? "bg-foreground" : "bg-muted-foreground/40"}`}
				title={agent.enabled ? "已启用" : "已停用"}
			/>
			{probe ? (
				<span
					className={`size-2 rounded-full ${probe.ok ? "bg-foreground" : "bg-destructive"}`}
					title={probe.ok ? "探测健康" : `探测异常：${probe.error ?? `exit ${probe.exitCode}`}`}
				/>
			) : null}
		</span>
	);
}

export function AgentsPane() {
	const [agents, setAgents] = useState<AgentConfig[]>([]);
	const [loading, setLoading] = useState(true);
	const [formAgent, setFormAgent] = useState<AgentConfig | null>(null);
	const [formOpen, setFormOpen] = useState(false);
	const [pendingDelete, setPendingDelete] = useState<AgentConfig | null>(null);
	const [probing, setProbing] = useState<string | null>(null);
	const [probes, setProbes] = useState<Record<string, WorkerProbeResult>>({});

	const refresh = useCallback(() => {
		listAgents()
			.then((a) => {
				setAgents(a);
				setLoading(false);
			})
			.catch((err: unknown) => {
				setLoading(false);
				toast.error(err instanceof Error ? err.message : String(err));
			});
	}, []);

	useEffect(() => refresh(), [refresh]);

	const handleProbe = useCallback(async (name: string) => {
		setProbing(name);
		try {
			const result = await probeAgent(name);
			setProbes((p) => ({ ...p, [name]: result }));
			if (!result.ok) toast.error(`「${name}」探测异常：${result.error ?? `exit ${result.exitCode}`}`);
			else toast.success(`「${name}」健康`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		} finally {
			setProbing(null);
		}
	}, []);

	const handleToggle = useCallback(
		async (agent: AgentConfig) => {
			try {
				const updated = await updateAgent(agent.name, { ...agent, enabled: !agent.enabled });
				setAgents((prev) => prev.map((a) => (a.name === updated.name ? updated : a)));
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
			}
		},
		[],
	);

	const handleSubmit = useCallback(
		async (agent: AgentConfig) => {
			try {
				if (formAgent) await updateAgent(formAgent.name, agent);
				else await createAgent(agent);
				toast.success(`「${agent.name}」已保存`);
				setFormOpen(false);
				setFormAgent(null);
				refresh();
			} catch (err) {
				toast.error(err instanceof Error ? err.message : String(err));
			}
		},
		[formAgent, refresh],
	);

	const handleDelete = useCallback(async () => {
		if (!pendingDelete) return;
		try {
			await deleteAgent(pendingDelete.name);
			agentRemoved(pendingDelete.name);
			toast.success(`「${pendingDelete.name}」已删除`);
			refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
		setPendingDelete(null);
	}, [pendingDelete, refresh]);

	const handleAgentUpdated = useCallback((updated: AgentConfig) => {
		setAgents((prev) => prev.map((a) => (a.name === updated.name ? updated : a)));
		setFormAgent((prev) => (prev && prev.name === updated.name ? updated : prev));
	}, []);

	return (
		<div className="flex h-full flex-col">
			<header className="flex items-center justify-between px-4 py-2">
				<span className="text-sm font-medium">智能体</span>
				<Button type="button" size="sm" onClick={() => {
					setFormAgent(null);
					setFormOpen(true);
				}}>
					<PlusIcon className="size-4" />
					添加
				</Button>
			</header>
			<div className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-4 pb-4">
				{loading ? (
					<div className="flex items-center justify-center gap-2 pt-20 text-sm text-muted-foreground">
						<LoaderIcon className="size-4 animate-spin" />
						加载中…
					</div>
				) : agents.length === 0 ? (
					<div className="pt-20 text-center text-sm text-muted-foreground">
						还没有 worker。点击「添加」注册一个，例如 PuddingClaw。
					</div>
				) : (
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
						{agents.map((agent) => (
							<div
								key={agent.name}
								role="button"
								tabIndex={0}
								onClick={() => {
									setFormAgent(agent);
									setFormOpen(true);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										setFormAgent(agent);
										setFormOpen(true);
									}
								}}
								className="flex cursor-pointer flex-col gap-2.5 rounded-lg bg-muted p-4 transition-colors hover:bg-accent"
							>
								<div className="flex items-start justify-between gap-2">
									<WorkerAvatar name={agent.name} size={56} />
									<StatusLights agent={agent} probe={probes[agent.name]} />
								</div>
								<div className="min-w-0">
									<div className="truncate font-mono text-sm font-medium">{agent.name}</div>
									<p className="mt-0.5 truncate text-xs text-muted-foreground" title={agent.description}>
										{agent.description || "（无描述）"}
									</p>
								</div>
								{agent.capabilities?.length ? (
									<p className="truncate font-mono text-xs text-muted-foreground/70">
										{agent.capabilities.slice(0, 3).join(" · ")}
										{agent.capabilities.length > 3 ? ` · +${agent.capabilities.length - 3}` : ""}
									</p>
								) : null}
								<div
									className="mt-auto flex items-center gap-1 pt-1"
									onClick={(e) => e.stopPropagation()}
									onKeyDown={(e) => e.stopPropagation()}
								>
									<Button
										type="button"
										size="sm"
										variant="outline"
										onClick={() => handleProbe(agent.name)}
										disabled={probing === agent.name}
									>
										{probing === agent.name ? (
											<LoaderIcon className="size-3.5 animate-spin" />
										) : (
											<RefreshCwIcon className="size-3.5" />
										)}
										探测
									</Button>
									<Button type="button" size="sm" variant="outline" onClick={() => handleToggle(agent)}>
										<UserCheckIcon className="size-3.5" />
										{agent.enabled ? "停用" : "启用"}
									</Button>
									<Button
										type="button"
										size="sm"
										variant="ghost"
										className="ml-auto"
										onClick={() => setPendingDelete(agent)}
									>
										<TrashIcon className="size-3.5" />
									</Button>
								</div>
							</div>
						))}
					</div>
				)}
			</div>

			<Dialog open={formOpen} onOpenChange={(open) => !open && setFormOpen(false)}>
				<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>{formAgent ? `编辑智能体「${formAgent.name}」` : "添加智能体"}</DialogTitle>
						<DialogDescription>注册一个 team worker（teams.json 条目）。</DialogDescription>
					</DialogHeader>
					{formAgent && probes[formAgent.name] ? (
						<div className="mb-1">
							<ProbeResult result={probes[formAgent.name]!} />
						</div>
					) : null}
					<AgentForm
						initial={formAgent}
						onSubmit={handleSubmit}
						onCancel={() => setFormOpen(false)}
						onAgentUpdated={handleAgentUpdated}
					/>
				</DialogContent>
			</Dialog>

			<Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>删除智能体</DialogTitle>
						<DialogDescription>
							确定删除「{pendingDelete?.name}」吗？该 worker 将从 teams.json 移除，无法恢复。
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setPendingDelete(null)}>
							取消
						</Button>
						<Button type="button" variant="destructive" onClick={handleDelete}>
							删除
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
