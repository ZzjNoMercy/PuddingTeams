"use client";

import { useEffect, useState } from "react";
import { CableIcon, ChevronDownIcon, LoaderIcon, ShieldCheckIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { getFeishuSettings, importFeishuConnection, saveFeishuSettings, type FeishuSettingsSnapshot } from "@/lib/api";
import { cn } from "@/lib/utils";
import { groupScopes, scopeAction, scopeRisk, scopeTotal, type ScopeRisk } from "./feishu-scopes";

const RISK_STYLE: Record<ScopeRisk, string> = {
	danger: "border-destructive/35 text-destructive",
	write: "border-amber-500/40 text-amber-700 dark:text-amber-400",
	read: "border-border/60 text-muted-foreground",
};

/** 授权 scope 按业务域折叠：默认收起，只看域与风险摘要，展开才看具体权限。 */
function ScopeDisclosure({ scope, accountName }: { scope: string; accountName?: string }) {
	const groups = groupScopes(scope);
	const total = scopeTotal(groups);
	const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set<string>());
	const allOpen = groups.length > 0 && groups.every(group => opened.has(group.domain));
	const setGroupOpen = (domain: string, next: boolean) => setOpened(current => {
		const draft = new Set(current);
		if (next) draft.add(domain);
		else draft.delete(domain);
		return draft;
	});
	return <section className="settings-card space-y-3">
		<div className="flex items-baseline justify-between gap-3">
			<h3 className="text-sm font-medium">共享用户授权{accountName ? ` · ${accountName}` : ""}</h3>
			<button type="button" className="shrink-0 text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpened(allOpen ? new Set<string>() : new Set(groups.map(group => group.domain)))}>{allOpen ? "全部收起" : "全部展开"}</button>
		</div>
		<p className="text-xs text-muted-foreground">共 {total} 项权限，归入 {groups.length} 个业务域。红字为删除/管理类，橙字为写入类。</p>
		<div className="flex flex-col gap-1.5">
			{groups.map(group => <Collapsible key={group.domain} open={opened.has(group.domain)} onOpenChange={next => setGroupOpen(group.domain, next)}>
				<CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg border border-border/60 px-2.5 py-2 text-left text-xs hover:bg-muted/40">
					<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
					<span className="font-medium">{group.label}</span>
					<span className="text-muted-foreground">{group.scopes.length} 项</span>
					<span className="ml-auto flex shrink-0 gap-1.5">
						{group.danger > 0 ? <span className="rounded border border-destructive/35 px-1 text-destructive">{group.danger} 项删除/管理</span> : null}
						{group.write > 0 ? <span className="rounded border border-amber-500/40 px-1 text-amber-700 dark:text-amber-400">{group.write} 项写入</span> : null}
					</span>
				</CollapsibleTrigger>
				<CollapsibleContent className="flex flex-wrap gap-1 px-2.5 pt-2 pb-1">
					{group.scopes.map(item => <span key={item} className={cn("rounded border px-1.5 py-0.5 font-mono text-[11px]", RISK_STYLE[scopeRisk(item)])}>{scopeAction(item, group.domain)}</span>)}
				</CollapsibleContent>
			</Collapsible>)}
		</div>
	</section>;
}

export function FeishuSettings() {
	const [snapshot, setSnapshot] = useState<FeishuSettingsSnapshot | null>(null);
	const [appId, setAppId] = useState("");
	const [secret, setSecret] = useState("");
	const [confirmReplace, setConfirmReplace] = useState(false);
	const [busy, setBusy] = useState<"load" | "save" | "import" | null>("load");
	const [error, setError] = useState<string | null>(null);
	const apply = (value: FeishuSettingsSnapshot) => { setSnapshot(value); setAppId(value.appId); setSecret(""); setConfirmReplace(false); };
	useEffect(() => {
		let active = true;
		void getFeishuSettings().then(value => { if (active) apply(value); }).catch(e => { if (active) setError(e instanceof Error ? e.message : "配置读取失败"); }).finally(() => { if (active) setBusy(null); });
		return () => { active = false; };
	}, []);
	const changingApp = Boolean(snapshot?.configured && snapshot.appId !== appId.trim());
	const run = async (kind: "save" | "import") => {
		setBusy(kind); setError(null);
		try {
			const next = kind === "import" ? await importFeishuConnection() : await saveFeishuSettings({ appId: appId.trim(), ...(secret ? { appSecret: secret } : {}), confirmReplace });
			apply(next); toast.success(kind === "import" ? "已有连接已导入，平台与 CLI 共用凭证" : "飞书默认应用已保存");
		} catch (e) { setError(e instanceof Error ? e.message : "飞书配置失败"); }
		finally { setBusy(null); }
	};
	return <div className="settings-content-column [&>section+section]:mt-4">
		<div className="settings-section-heading"><h2>飞书默认应用</h2><p>平台与 Agent CLI 共用一套加密凭证，绑定插件不重复授权。</p></div>
		<section className="settings-card space-y-4">
			<div className="flex items-center gap-2 text-sm font-medium"><CableIcon className="size-4 text-primary" />{snapshot?.configured ? "默认应用已配置" : "配置应用或导入已有连接"}</div>
			{busy === "load" ? <p role="status" className="text-sm text-muted-foreground">正在读取配置…</p> : null}
			<form className="space-y-4" onSubmit={event => { event.preventDefault(); void run("save"); }}>
				<label className="block space-y-2 text-sm"><span>应用 ID</span><Input value={appId} onChange={e => { setAppId(e.target.value); setConfirmReplace(false); }} placeholder="cli_…" autoComplete="off" disabled={Boolean(busy)} /></label>
				<label className="block space-y-2 text-sm"><span>应用密钥</span><Input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={snapshot?.secretConfigured ? "已加密保存；留空保留当前密钥" : "填写飞书应用的 App Secret"} autoComplete="new-password" disabled={Boolean(busy)} /></label>
				<p className="flex items-start gap-2 text-xs text-muted-foreground"><ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />密钥和刷新令牌仅加密保存在后端，不回传浏览器。用户授权在「扩展 → 连接状态」完成；CLI 也可发起，结果共用。</p>
				{changingApp ? <label className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm"><input className="mt-1" type="checkbox" checked={confirmReplace} onChange={e => setConfirmReplace(e.target.checked)} />确认切换应用并清除原应用的共享用户凭证，新应用需单独授权。</label> : null}
				<Button type="submit" disabled={Boolean(busy) || !appId.trim() || (!snapshot?.configured && !secret) || (changingApp && !confirmReplace)}>{busy === "save" ? <LoaderIcon className="size-4 animate-spin" /> : null}保存并验证应用</Button>
			</form>
		</section>
		{!snapshot?.configured ? <section className="settings-card space-y-3"><h3 className="text-sm font-medium">复用本机已有连接</h3><p className="text-sm text-muted-foreground">读取本机官方 CLI 当前应用和已有加密授权，导入共享凭证库，不发起新授权、不修改系统钥匙串。macOS 可能请求钥匙串访问许可。</p><Button variant="outline" disabled={Boolean(busy)} onClick={() => void run("import")}>{busy === "import" ? <LoaderIcon className="size-4 animate-spin" /> : null}导入本机已有连接</Button></section> : null}
		{snapshot?.scope ? <ScopeDisclosure scope={snapshot.scope} accountName={snapshot.accountName} /> : null}
		{error ? <p role="alert" className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}
	</div>;
}
