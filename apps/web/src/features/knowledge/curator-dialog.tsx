"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRightIcon, CheckIcon, FileTextIcon, ImageIcon, LayersIcon, LoaderIcon, PaperclipIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { createWikiCuratorJob, listAgents, type MessageAttachmentInput, type WikiCuratorJob } from "@/lib/api";
import { curatorJobHref } from "@/lib/curator-job-presentation";
import { WIKI_REVIEW_CHANGED } from "@/lib/wiki-review-queue";
import styles from "./task-center.module.css";

export interface WikiCuratorDialogProps {
	bindingId: string; bindingName: string; open: boolean; onOpenChange: (open: boolean) => void;
}

/** A fresh intake is independent of existing jobs. Radix owns focus, Escape and scroll locking. */
export function WikiCuratorDialog(props: WikiCuratorDialogProps) {
	const submitting = useRef(false);
	const changeOpen = (open: boolean) => {if (!submitting.current) props.onOpenChange(open);};
	return <Dialog open={props.open} onOpenChange={changeOpen}>{props.open ? <IntakeForm key={props.bindingId} {...props} onOpenChange={changeOpen} onBusyChange={busy => {submitting.current = busy;}} /> : null}</Dialog>;
}

function IntakeForm({ bindingId, bindingName, onOpenChange, onBusyChange }: WikiCuratorDialogProps & {onBusyChange: (busy: boolean) => void}) {
	const [material, setMaterial] = useState(""), [request, setRequest] = useState("");
	const [uploads, setUploads] = useState<File[]>([]), [error, setError] = useState<string | null>(null);
	const [agentId, setAgentId] = useState<string | null>(null), [configError, setConfigError] = useState<string | null>(null);
	const [loadingAgents, setLoadingAgents] = useState(true), [reload, setReload] = useState(0), [busy, setBusy] = useState(false);
	const [receipt, setReceipt] = useState<WikiCuratorJob | null>(null);
	const fileInput = useRef<HTMLInputElement>(null), materialInput = useRef<HTMLTextAreaElement>(null);
	const operation = useRef<{ key: string; id: string } | null>(null), lock = useRef(false), alive = useRef(true);
	useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
	useEffect(() => {
		let active = true;
		void listAgents().then(items => {
			if (!active) return;
			const workers = items.filter(a => a.enabled !== false && a.builtinId === "wiki" && a.connector?.connectorId === "pi" && a.connector.transport === "sdk");
			setAgentId((workers.find(a => a.name === "wiki") ?? workers[0])?.name ?? ""); setConfigError(null); setLoadingAgents(false);
		}).catch(cause => { if (active) { setConfigError(cause instanceof Error ? cause.message : "管理员暂不可用，请重试。"); setLoadingAgents(false); } });
		return () => { active = false; };
	}, [reload]);
	const addFiles = (files: FileList | null) => {
		const incoming = Array.from(files ?? []);
		if (incoming.some(f => !(/\.(txt|md|markdown)$/i.test(f.name) || ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(f.type)))) { setError("请添加文字文件或图片，暂不支持其他格式。"); return; }
		const next = [...uploads];
		for (const file of incoming) if (!next.some(f => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified)) next.push(file);
		if (next.length > 5 || next.some(f => f.size > 8 * 1024 * 1024) || next.reduce((n,f) => n + f.size,0) > 20 * 1024 * 1024) { setError("一次最多 5 个附件，单个不超过 8 MB，合计不超过 20 MB。"); return; }
		setUploads(next); setError(null);
	};
	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (lock.current || !agentId || (!material.trim() && !uploads.length)) return;
		lock.current = true; onBusyChange(true); setBusy(true); setError(null);
		const key = JSON.stringify([bindingId,agentId,material,request,uploads.map(f => [f.name,f.size,f.lastModified])]);
		if (operation.current?.key !== key) operation.current = {key,id:crypto.randomUUID()};
		try {
			const attachments = await Promise.all(uploads.map(file => new Promise<MessageAttachmentInput>((resolve,reject) => {
				const reader = new FileReader(); reader.onerror = () => reject(new Error(`读取附件失败：${file.name}`));
				reader.onload = () => { const value = String(reader.result); resolve({filename:file.name,mediaType:/\.(md|markdown)$/i.test(file.name) ? "text/markdown" : /\.txt$/i.test(file.name) ? "text/plain" : file.type,data:value.slice(value.indexOf(",")+1)}); }; reader.readAsDataURL(file);
			})));
			if (!alive.current) return;
			const result = await createWikiCuratorJob({operationId:operation.current.id,bindingId,agentId,material,task:request.trim() || "整理提供的资料，遵循知识库已有结构，保留事实来源与不确定性。",...(attachments.length ? {uploads:attachments} : {})});
			window.dispatchEvent(new Event(WIKI_REVIEW_CHANGED));
			if (alive.current) setReceipt(result.job);
		} catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "提交未成功，资料已保留，请重试。"); }
		finally { onBusyChange(false); lock.current = false; if (alive.current) setBusy(false); }
	};
	if (receipt) return <DialogContent className={styles.receiptDialog}>
		<DialogHeader className={styles.receiptHeader}><span className={styles.receiptCheck}><CheckIcon size={25} /></span><DialogTitle>资料已收到</DialogTitle><DialogDescription>已提交到{bindingName}。你可以先离开，<br />整理完成后再来审核修改。</DialogDescription></DialogHeader>
		<footer className={styles.dialogFooter}><Button variant="outline" onClick={() => onOpenChange(false)}>返回知识库</Button><Button asChild><Link href={curatorJobHref(receipt.id,bindingId)} onClick={() => onOpenChange(false)}>查看任务<ArrowRightIcon size={15} /></Link></Button></footer>
	</DialogContent>;
	return <DialogContent className={styles.intakeDialog} showCloseButton={!busy} onEscapeKeyDown={event => {if (busy) event.preventDefault();}} onInteractOutside={event => {if (busy) event.preventDefault();}} onOpenAutoFocus={event => {event.preventDefault(); materialInput.current?.focus();}}>
		<DialogHeader className={styles.intakeHeader}><DialogTitle>添加资料</DialogTitle><DialogDescription>交给 Wiki 管理员整理，完成后由你确认。</DialogDescription></DialogHeader>
		<form className={styles.intakeForm} onSubmit={event => void submit(event)}>
			<div className={styles.intakeBody}>
				<div className={styles.destination}><span>整理到</span><strong><LayersIcon size={15} />{bindingName}</strong></div>
				<label className={styles.fieldLabel} htmlFor="wiki-material">资料内容</label>
				<div className={styles.materialEditor}><textarea id="wiki-material" ref={materialInput} value={material} maxLength={100_000} disabled={busy} onChange={e => setMaterial(e.target.value)} placeholder="粘贴要保存的资料，或写下想记住的事情…" /><div className={styles.materialTools}><input ref={fileInput} type="file" hidden accept=".txt,.md,.markdown,image/png,image/jpeg,image/gif,image/webp" multiple onChange={e => {addFiles(e.target.files); e.target.value = "";}} /><button type="button" disabled={busy} onClick={() => fileInput.current?.click()}><PaperclipIcon size={16} />添加附件</button><span>文字文件、图片</span></div></div>
				{uploads.length ? <ul className={styles.attachments} aria-label="已添加的附件">{uploads.map((f,i) => <li key={`${f.name}:${i}`}><span className={styles.attachmentIcon}>{f.type.startsWith("image/") ? <ImageIcon size={18} /> : <FileTextIcon size={18} />}</span><span><strong>{f.name}</strong><small>{f.size < 1024*1024 ? `${Math.max(1,Math.round(f.size/1024))} KB` : `${(f.size/1024/1024).toFixed(1)} MB`}</small></span><button type="button" disabled={busy} aria-label={`移除附件 ${f.name}`} onClick={() => {setUploads(items => items.filter((_,at) => at !== i));setError(null);}}><XIcon size={15} /></button></li>)}</ul> : null}
				<label className={`${styles.fieldLabel} ${styles.requestLabel}`} htmlFor="wiki-request">整理要求<span>选填</span></label><textarea className={styles.requestEditor} id="wiki-request" rows={2} maxLength={20_000} value={request} disabled={busy} onChange={e => setRequest(e.target.value)} placeholder="有特别的整理方式，可以在这里说明。" />
				{loadingAgents ? <p className={styles.hint}>正在连接管理员…</p> : configError ? <p role="alert" className={styles.error}>{configError} <button type="button" onClick={() => {setLoadingAgents(true);setReload(n => n+1);}}>重试</button></p> : !agentId ? <p className={styles.hint}>知识库管理员尚未启用。<Link href="/agents">前往设置</Link></p> : null}
				{error ? <p role="alert" className={styles.error}>{error}</p> : null}
			</div><footer className={styles.dialogFooter}><span className={styles.reviewNote}>审核通过后才会更新知识库</span><div><Button variant="outline" type="button" disabled={busy} onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={busy || loadingAgents || Boolean(configError) || !agentId || (!material.trim() && !uploads.length)}>{busy ? <><LoaderIcon size={15} className="animate-spin" />正在提交</> : <>开始整理<ArrowRightIcon size={15} /></>}</Button></div></footer>
		</form>
	</DialogContent>;
}
