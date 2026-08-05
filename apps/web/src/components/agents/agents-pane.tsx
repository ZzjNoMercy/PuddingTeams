"use client";

import { useCallback, useEffect, useState } from "react";
import { BotIcon, LoaderIcon, PencilIcon, PlusIcon, RefreshCwIcon, TrashIcon, UserCheckIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createAgent, deleteAgent, listAgents, probeAgent, updateAgent } from "@/lib/api";
import type { AgentConfig, WorkerProbeResult } from "@/lib/types";

function parseArgs(text: string): string[] {
	return text
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function argsText(args: string[] | undefined): string {
	return (args ?? []).join(", ");
}

function AgentForm({
	initial,
	onSubmit,
	onCancel,
}: {
	initial: AgentConfig | null;
	onSubmit: (agent: AgentConfig) => Promise<void>;
	onCancel: () => void;
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
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex flex-col gap-3">
			{initial ? (
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">名称（不可修改）</span>
					<Input value={name} disabled />
				</label>
			) : (
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">名称（唯一标识，team_task 用）</span>
					<Input value={name} onChange={(e) => setName(e.target.value)} placeholder="如 puddingclaw" />
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
				<Badge variant={result.ok ? "outline" : "destructive"} className={result.ok ? "border-emerald-500/50 text-emerald-600" : ""}>
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
			toast.success(`「${pendingDelete.name}」已删除`);
			refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : String(err));
		}
		setPendingDelete(null);
	}, [pendingDelete, refresh]);

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
			<div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 pb-4">
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
					<div className="flex flex-col gap-2">
						{agents.map((agent) => (
							<div key={agent.name} className="rounded-lg border bg-card p-3">
								<div className="flex items-start justify-between gap-2">
									<div className="flex min-w-0 items-center gap-2">
										<BotIcon className="size-4 shrink-0 text-muted-foreground" />
										<span className="font-mono text-sm font-medium">{agent.name}</span>
										<Badge variant={agent.enabled ? "outline" : "secondary"}>
											{agent.enabled ? "已启用" : "已停用"}
										</Badge>
										{agent.capabilities?.length ? (
											<span className="hidden text-xs text-muted-foreground sm:inline">
												{agent.capabilities.join(" · ")}
											</span>
										) : null}
									</div>
									<div className="flex shrink-0 items-center gap-1">
										<Button type="button" size="sm" variant="outline" onClick={() => handleToggle(agent)}>
											<UserCheckIcon className="size-3.5" />
											{agent.enabled ? "停用" : "启用"}
										</Button>
										<Button type="button" size="sm" variant="outline" onClick={() => handleProbe(agent.name)} disabled={probing === agent.name}>
											{probing === agent.name ? (
												<LoaderIcon className="size-3.5 animate-spin" />
											) : (
												<RefreshCwIcon className="size-3.5" />
											)}
											探测
										</Button>
										<Button type="button" size="sm" variant="ghost" onClick={() => {
											setFormAgent(agent);
											setFormOpen(true);
										}}>
											<PencilIcon className="size-3.5" />
										</Button>
										<Button type="button" size="sm" variant="ghost" onClick={() => setPendingDelete(agent)}>
											<TrashIcon className="size-3.5" />
										</Button>
									</div>
								</div>
								<p className="mt-1 text-xs text-muted-foreground">{agent.description || "（无描述）"}</p>
								<div className="mt-1 text-xs text-muted-foreground/80">
									<code className="rounded bg-muted/60 px-1">
										{agent.invoke.command} {agent.invoke.runArgs.join(" ")}
									</code>
								</div>
								{probes[agent.name] ? (
									<div className="mt-2">
										<ProbeResult result={probes[agent.name]} />
									</div>
								) : null}
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
					<AgentForm
						initial={formAgent}
						onSubmit={handleSubmit}
						onCancel={() => setFormOpen(false)}
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
