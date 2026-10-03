"use client";

import { useEffect, useState } from "react";
import { CheckCircle2Icon, ExternalLinkIcon, LoaderIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { extensionAuthorization } from "@/lib/api";
import { getDesktopBridge } from "@/lib/desktop";
import type { ExtensionAuthorizationSession, ExtensionConnectionStatus } from "@/lib/types";

export function ConnectionAuthorizationDialog({ connection, actionId, onClose, onCompleted, authorizationBase, scopeDescription }: {
	connection: ExtensionConnectionStatus;
	actionId: string;
	onClose: () => void;
	onCompleted: () => void;
	authorizationBase?: string;
	scopeDescription?: string;
}) {
	const [attempt, setAttempt] = useState(0);
	const [session, setSession] = useState<ExtensionAuthorizationSession | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!attempt) return;
		let active = true;
		let sessionId: string | undefined;
		let timer: ReturnType<typeof setTimeout>;
		const cancel = () => {
			if (sessionId) void extensionAuthorization(connection, { sessionId, cancel: true }, authorizationBase).catch(() => undefined);
		};
		const check = async () => {
			if (!active || !sessionId) return;
			try {
				const next = await extensionAuthorization(connection, { sessionId }, authorizationBase);
				if (!active || !next) return;
				setSession(next);
				if (next.state === "completed") {
					onCompleted();
					toast.success("用户授权成功");
				} else if (next.state === "pending") timer = setTimeout(() => void check(), 1500);
			} catch (err) {
				if (active) setError(err instanceof Error ? err.message : "授权状态检查失败，请重试");
			}
		};
		void extensionAuthorization(connection, { actionId }, authorizationBase).then(next => {
			sessionId = next?.id;
			if (!active) { cancel(); return; }
			setSession(next);
			setBusy(false);
			// 先呈现授权入口，再启动服务端等待；请求本身不阻塞页面。
			timer = setTimeout(() => void check(), 500);
		}).catch(err => {
			if (active) {
				setError(err instanceof Error ? err.message : "无法发起授权");
				setBusy(false);
			}
		});
		return () => { active = false; clearTimeout(timer); cancel(); };
	}, [attempt, connection, actionId, onCompleted, authorizationBase]);

	const start = () => {
		setSession(null);
		setError(null);
		setBusy(true);
		setAttempt(current => current + 1);
	};
	const pending = session?.state === "pending";
	const completed = session?.state === "completed";
	return (
		<Dialog open onOpenChange={open => { if (!open) onClose(); }}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{connection.name} · 用户授权</DialogTitle>
					<DialogDescription>{authorizationBase ? "授权完成后自动确认，并返回日历选择。" : "授权结果保存到共享加密凭证，平台与 Agent CLI 同时生效。"}</DialogDescription>
				</DialogHeader>
				{!attempt ? (
					<div className="space-y-2 rounded-xl border border-border bg-muted/40 p-4 text-sm">
						<p>{scopeDescription ?? "使用平台默认飞书应用，恢复已有用户授权范围。"}</p>
						<p className="text-xs text-muted-foreground">{scopeDescription ? "使用共享用户凭证，仅补充当前来源所需权限，保留既有授权。" : "首次仅申请基础身份与自动续期权限，业务权限按需补充。已有本机授权可先在「设置 → 飞书默认应用」导入，无需重复授权。"}</p>
					</div>
				) : null}
				{busy ? <div role="status" className="flex items-center gap-2 rounded-xl bg-primary/5 p-4 text-sm"><LoaderIcon className="size-4 animate-spin text-primary" />正在获取授权入口…</div> : null}
				{pending && !error && session.verificationUrl ? (
					<div className="space-y-4">
						<a href={session.verificationUrl} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm font-medium text-primary" onClick={event => {
							const desktop = getDesktopBridge();
							if (desktop) { event.preventDefault(); void desktop.openExternal(session.verificationUrl!).catch(() => toast.error("无法打开授权页面，请扫描二维码")); }
						}}>打开授权页面<ExternalLinkIcon className="size-3.5" /></a>
						{session.qrCodeDataUrl ? <div className="mx-auto w-fit rounded-xl border border-border bg-white p-3" style={{ colorScheme: "light" }}>
							{/* 后端本地生成的本次授权二维码，不经过 CLI 或外部图片服务。 */}
							{/* eslint-disable-next-line @next/next/no-img-element */}
							<img src={session.qrCodeDataUrl} alt="扫描二维码完成用户授权" width={224} height={224} />
						</div> : null}
						<div role="status" className="text-center text-xs text-muted-foreground"><span className="inline-flex items-center gap-2"><LoaderIcon className="size-3 animate-spin" />扫码或打开链接授权，完成后自动确认</span><p className="mt-1">链接将在 {new Date(session.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 失效</p></div>
					</div>
				) : null}
				{completed ? <div role="status" className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-4 text-sm text-emerald-700 dark:text-emerald-300"><CheckCircle2Icon className="size-5" />用户授权成功</div> : null}
				{error || (session && !pending && !completed) ? <p role="alert" className="rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">{error ?? session?.message}</p> : null}
				<DialogFooter>
					<Button variant="ghost" onClick={onClose}>{completed ? "完成" : "关闭"}</Button>
					{!completed && (!pending || error) ? <Button disabled={busy} onClick={start}>{attempt ? "重新发起" : "开始授权"}</Button> : null}
				</DialogFooter>
				{pending && !error ? <p className="text-xs text-muted-foreground">关闭弹窗会停止等待，不会撤销已授予的权限。</p> : null}
			</DialogContent>
		</Dialog>
	);
}
