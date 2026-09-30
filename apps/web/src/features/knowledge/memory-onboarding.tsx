"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BrainIcon, CheckCircle2Icon, FolderOpenIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { applyMemorySetup, deferMemorySetup, getMemorySetup, pickWorkspaceDirectory, planMemorySetup,
	type KnowledgePlan, type MemorySetupStatus } from "@/lib/api";

export const MEMORY_SETUP_EVENT = "puddingteams:memory-setup";
export const MEMORY_SETUP_COMPLETED_EVENT = "puddingteams:memory-setup-completed";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Mounted once in the root layout; setup state survives routes, windows and app restarts. */
export function MemoryOnboarding() {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [status, setStatus] = useState<MemorySetupStatus | null>(null);
	const [location, setLocation] = useState("");
	const [plan, setPlan] = useState<KnowledgePlan | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const lock = useRef(false);

	useEffect(() => {
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let request = 0;
		const load = async (manual = false, attempt = 0) => {
			const id = ++request;
			try {
				const next = await getMemorySetup();
				if (!active || id !== request || lock.current) return;
				setStatus(next);
				setError(null);
				if (manual || next.status === "pending") setOpen(true);
			} catch (cause) {
				if (!active || id !== request) return;
				if (!manual && attempt < 3) {
					timer = setTimeout(() => void load(false, attempt + 1), 1500 * (attempt + 1));
				} else {
					setError(`长期记忆设置暂时无法加载：${message(cause)}`);
					setOpen(true);
				}
			}
		};
		const show = () => { if (timer) clearTimeout(timer); void load(true); };
		window.addEventListener(MEMORY_SETUP_EVENT, show);
		void load();
		return () => { active = false; if (timer) clearTimeout(timer); window.removeEventListener(MEMORY_SETUP_EVENT, show); };
	}, []);

	async function run(action: () => Promise<void>) {
		if (lock.current) return;
		lock.current = true;
		setBusy(true);
		setError(null);
		try { await action(); } catch (cause) { setError(message(cause)); }
		finally { lock.current = false; setBusy(false); }
	}
	const close = () => {
		if (lock.current) return;
		if (!status || status.status === "configured") { setOpen(false); return; }
		void run(async () => { setStatus(await deferMemorySetup()); setPlan(null); setOpen(false); });
	};
	const configured = status?.status === "configured" ? status.binding : null;

	return <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
		<DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-[560px]" showCloseButton={!busy} onPointerDownOutside={(event) => event.preventDefault()}>
			<DialogHeader>
				<div className="mb-2 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary"><BrainIcon size={24} /></div>
				<DialogTitle>{configured ? "长期记忆已就绪" : plan ? "确认长期记忆的保存位置" : "给长期记忆一个家"}</DialogTitle>
				<DialogDescription>把偏好、决策和有用的经验保存在自己的文件夹里，随时查看和编辑。Agent 的修改会交给 Wiki 管理员，审核后才会发布。</DialogDescription>
			</DialogHeader>
			<DialogBody>
				{configured ? <div className="space-y-4">
					<p className="flex items-center gap-2 text-sm"><CheckCircle2Icon size={18} className="text-emerald-500" />已建立长期记忆知识库</p>
					<p className="break-all rounded-lg bg-muted p-3 text-sm">{configured.canonicalBindingRoot}</p>
					<p className="text-sm text-muted-foreground">长期记忆会默认挂载到会话，按需检索，修改仍需审核。可在会话的知识库选择器中取消；已经运行过的会话如提示上下文变化，请新建会话后使用。</p>
					<div className="flex justify-end gap-2"><Button variant="outline" onClick={close}>完成</Button><Button onClick={() => { setOpen(false); router.push(`/knowledge?vault=${encodeURIComponent(configured.id)}`); }}>查看知识库</Button></div>
				</div> : !status ? <div className="space-y-4">
					{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <p className="text-sm text-muted-foreground">正在加载…</p>}
					<div className="flex justify-end gap-2"><Button variant="outline" onClick={close}>稍后再试</Button><Button disabled={busy} onClick={() => void run(async () => setStatus(await getMemorySetup()))}>重试</Button></div>
				</div> : <form className="space-y-5" onSubmit={(event) => {
					event.preventDefault();
					void run(async () => {
						if (!plan) { setPlan(await planMemorySetup(location.trim())); return; }
						setStatus(await applyMemorySetup(plan.planId));
						setPlan(null);
						window.dispatchEvent(new Event(MEMORY_SETUP_COMPLETED_EVENT));
					});
				}}>
					{plan ? <div className="space-y-3 rounded-xl border border-border p-4">
						<p className="break-all text-sm font-medium">{plan.canonicalBindingRoot}</p>
						<p className="text-sm text-muted-foreground">将在这里创建长期记忆首页、资料结构和维护规则。</p>
						<ul className="space-y-1 text-xs text-muted-foreground">{plan.filesToCreate.map((file) => <li key={file.relativePath}>{file.relativePath}</li>)}</ul>
					</div> : <div className="space-y-2">
						<label htmlFor="memory-location" className="text-sm font-medium">存储文件夹</label>
						<div className="flex gap-2">
							<input id="memory-location" className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" value={location} onChange={(event) => setLocation(event.target.value)} placeholder="例如：~/Documents/Memory" disabled={busy} spellCheck={false} autoFocus required />
							<Button type="button" variant="outline" disabled={busy} onClick={() => void run(async () => {
								const picked = await pickWorkspaceDirectory(location.trim() || "");
								if (picked) setLocation(picked);
							})}><FolderOpenIcon size={16} />选择文件夹</Button>
						</div>
						<p className="text-xs text-muted-foreground">请选择空文件夹，或填写新文件夹路径。确认初始化后才会创建文件。</p>
					</div>}
					<div className="flex flex-wrap gap-2">{["事实", "偏好", "长期上下文", "决策", "关键经历", "可复用方法"].map((label) => <span key={label} className="rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">{label}</span>)}</div>
					{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
					<div className="flex flex-wrap items-center justify-between gap-2">
						<Button type="button" variant="ghost" disabled={busy} onClick={close}>稍后设置</Button>
						<div className="flex gap-2">{plan ? <Button type="button" variant="outline" disabled={busy} onClick={() => { setPlan(null); setError(null); }}>更换文件夹</Button> : null}
							<Button type="submit" disabled={busy || (!plan && !location.trim())}>{busy ? <Loader2Icon size={15} className="animate-spin" /> : null}{busy ? "正在处理…" : plan ? "初始化长期记忆" : "下一步"}</Button>
						</div>
					</div>
					<p className="text-xs text-muted-foreground">稍后也可从「知识库 → 长期记忆设置」继续。</p>
				</form>}
			</DialogBody>
		</DialogContent>
	</Dialog>;
}
