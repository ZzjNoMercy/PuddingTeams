"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeftIcon, ArrowUpRightIcon, ChevronRightIcon, FileTextIcon, ImageIcon, LayersIcon, MessageSquareIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cancelWikiCuratorJob, getWikiCuratorJob, KnowledgeApiError, listWikiCuratorTaskPage, listRooms, retryWikiCuratorJob, type KnowledgeBindingSummary, type WikiCuratorJob, type WikiCuratorTaskPage } from "@/lib/api";
import { canCancelCuratorJob, curatorJobHref, curatorJobRetryLabel, curatorSourceChatHref, isCuratorJobActive, taskResultLabel, taskStatusLabels, taskStatusMessage } from "@/lib/curator-job-presentation";
import type { RoomSummary } from "@/lib/types";
import { WIKI_REVIEW_CHANGED } from "@/lib/wiki-review-queue";
import styles from "./task-center.module.css";

const groups = [["all","全部"],["active","进行中"],["pending","待审核"],["ended","已结束"],["failed","未完成"]] as const;
const time = (value: string) => new Date(value).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});
const reviewHref = (job: WikiCuratorJob) => `/knowledge/review?vault=${encodeURIComponent(job.targetBindingId)}&batch=${encodeURIComponent(job.candidateBatchId!)}`;
function Status({job}:{job: WikiCuratorJob}) {return <span className={styles.status} data-state={job.displayStatus}>{taskStatusLabels[job.displayStatus] ?? "需要处理"}</span>;}

/** One authorized, paginated query serves the global and library views. */
export function WikiCuratorTasks({ bindingId, selectedJobId, bindings }: { bindingId?: string; selectedJobId: string | null; bindings: KnowledgeBindingSummary[] }) {
	const router = useRouter(), params = useSearchParams();
	const group = params.get("filter") ?? "all", period = params.get("period") ?? "week", query = params.get("q") ?? "";
	const offset = Math.max(0,Number(params.get("offset")) || 0);
	const [search, setSearch] = useState(query), [data, setData] = useState<WikiCuratorTaskPage | null>(null), [selected, setSelected] = useState<WikiCuratorJob | null>(null);
	const [rooms, setRooms] = useState<RoomSummary[] | null>(null), [error, setError] = useState<string | null>(null), [nonce, setNonce] = useState(0);
	const [mutation, setMutation] = useState(false), [actionError, setActionError] = useState<string | null>(null), [confirmCancel, setConfirmCancel] = useState(false);
	const lock = useRef(false), epoch = useRef(0), liveScope = useRef<object | null>(null), retryOperations = useRef(new Map<string,string>());
	const navigate = (patch: Record<string,string | null>) => {
		const q = new URLSearchParams(params.toString()); q.set("tasks","1");
		for (const [key,value] of Object.entries(patch)) {if (value === null || value === "") q.delete(key); else q.set(key,value);}
		router.push(`/knowledge?${q}`);
	};
	useEffect(() => { const scope = {}; liveScope.current = scope; return () => {liveScope.current = null;}; }, [bindingId,selectedJobId,query,group,period,offset]);
	const fast = selectedJobId ? !selected || isCuratorJobActive(selected.status) || ["approved","publishing"].includes(selected.displayStatus) : !data || data.counts.active > 0;
	useEffect(() => {
		let active = true, loading = false;
		const tick = async () => {
			if (!active || document.hidden || loading) return;
			loading = true; const started = epoch.current;
			try {
				if (selectedJobId) {
					const [response, r] = await Promise.all([getWikiCuratorJob(selectedJobId), listRooms().catch(() => null)]);
					if (bindingId && response.job.targetBindingId !== bindingId) throw new Error("此任务属于其他知识库，请核对链接。");
					if (active && started === epoch.current) {setSelected(response.job);setRooms(r);setError(null);}
				} else {
					const page = await listWikiCuratorTaskPage({bindingId,q:query,group,offset,limit:25,...(period === "all" ? {} : {since:new Date(Date.now()-7*86400000).toISOString()})});
					if (active && started === epoch.current) {setData(page);setError(null);}
				}
			} catch (cause) {if (active && started === epoch.current) setError(cause instanceof Error ? cause.message : "暂时无法读取任务，请重试。");}
			finally {loading = false;}
		};
		void tick(); const timer = window.setInterval(() => void tick(),fast ? 2000 : 15000);
		window.addEventListener("focus",tick); window.addEventListener(WIKI_REVIEW_CHANGED,tick); document.addEventListener("visibilitychange",tick);
		return () => {active = false;window.clearInterval(timer);window.removeEventListener("focus",tick);window.removeEventListener(WIKI_REVIEW_CHANGED,tick);document.removeEventListener("visibilitychange",tick);};
	},[bindingId,selectedJobId,query,group,period,offset,nonce,fast]);
	const mutate = async (kind: "retry" | "cancel") => {
		if (!selected || lock.current || (kind === "retry" && !curatorJobRetryLabel(selected)) || (kind === "cancel" && !canCancelCuratorJob(selected.status))) return;
		const job = selected, scope = liveScope.current; const current = () => scope !== null && liveScope.current === scope;
		lock.current = true; setMutation(true); setActionError(null); epoch.current++;
		try {
			if (kind === "retry") {if (!retryOperations.current.has(job.id)) retryOperations.current.set(job.id,crypto.randomUUID()); const response = await retryWikiCuratorJob(job.id,retryOperations.current.get(job.id)!); if (current()) router.push(curatorJobHref(response.job.id,response.job.targetBindingId));}
			else {const response = await cancelWikiCuratorJob(job.id);if (current()) {setSelected(response.job);setConfirmCancel(false);}}
			window.dispatchEvent(new Event(WIKI_REVIEW_CHANGED));
		} catch (cause) {if (current()) {setConfirmCancel(false);setActionError(cause instanceof KnowledgeApiError && cause.status === 409 ? "状态已变化，请查看最新结果后继续操作。" : cause instanceof Error ? cause.message : "操作未成功，请重试。");}}
		finally {lock.current = false;epoch.current++;if (current()) {setMutation(false);setNonce(n=>n+1);}}
	};
	const taskHref = (job: WikiCuratorJob) => {const q = new URLSearchParams(params.toString());q.set("job",job.id);q.set("vault",job.targetBindingId);q.set("taskScope",bindingId ?? "all");q.set("tasks","1");return `/knowledge?${q}`;};
	const backQuery = new URLSearchParams(params.toString());backQuery.delete("job");backQuery.set("tasks","1");if (backQuery.get("taskScope") === "all") backQuery.delete("vault");else if (backQuery.get("taskScope")) backQuery.set("vault",backQuery.get("taskScope")!);backQuery.delete("taskScope");
	const backHref = `/knowledge?${backQuery}`;
	const refresh = <button type="button" className={styles.refresh} aria-label="刷新任务" onClick={() => setNonce(n=>n+1)}><RefreshCwIcon size={15} /></button>;
	if (selectedJobId) {
		const job = selected?.id === selectedJobId ? selected : null;
		if (!job) return <section className={styles.center}><Link className={styles.back} href={backHref}><ArrowLeftIcon size={14} />返回任务列表</Link>{error ? <p role="alert" className={styles.error}>{error} {refresh}</p> : <p className={styles.hint}>正在读取任务…</p>}</section>;
		const chatHref = curatorSourceChatHref(job.origin,rooms), notice = taskStatusMessage(job);
		const retry = curatorJobRetryLabel(job), retryLabel = job.canRetryRegistration ? "继续提交" : "重新整理";
		const stopped = ["failed","cancelled","rejected","closed","nochanges","returned","partial","conflict","unavailable"].includes(job.displayStatus);
		const stopLabel: Record<string,string> = {failed:"整理未完成",cancelled:"整理已停止",rejected:"审核未通过",closed:"更新已关闭",nochanges:"无需修改",returned:"已退回修改",partial:"更新未完成",conflict:"需要重新确认",unavailable:job.publication?.state === "unknown" ? "更新待核对" : "记录待核对"};
		const activeStep = ["queued"].includes(job.displayStatus) ? 0 : ["running","submitting","failed","cancelled"].includes(job.displayStatus) ? 1 : job.displayStatus === "published" ? 4 : ["approved","publishing","partial"].includes(job.displayStatus) || job.publication?.state === "unknown" ? 3 : 2;
		return <section className={styles.center}>
			<Link className={styles.back} href={backHref}><ArrowLeftIcon size={14} />返回任务列表</Link>
			<header className={styles.detailHeading}><h1>{job.title}</h1><div className={styles.detailMeta}><Status job={job} /><span>{job.bindingName}</span><span>{job.executionMode === "worker" ? "来源对话" : "知识库 · 添加资料"}</span><span>{time(job.activityAt)} 更新</span>{refresh}</div></header>
			{error ? <p role="alert" className={styles.error}>暂未刷新成功，以下为上次读取的状态。{error}</p> : null}
			<div className={styles.notice} data-state={job.displayStatus}><div><strong>{notice[0]}</strong><p>{notice[1]}</p></div><div className={styles.actions}>
				{job.displayStatus === "pending" && job.candidateBatchId ? <Button asChild><Link href={reviewHref(job)}>查看并审核<ChevronRightIcon size={15} /></Link></Button> : job.displayStatus === "published" || job.displayStatus === "nochanges" ? <Button asChild><Link href={`/knowledge?vault=${encodeURIComponent(job.targetBindingId)}`}>查看知识库<ChevronRightIcon size={15} /></Link></Button> : job.displayStatus === "returned" && job.review?.revisionJobId ? <Button asChild><Link href={curatorJobHref(job.review.revisionJobId,job.targetBindingId)}>查看修改进度</Link></Button> : retry ? <Button disabled={mutation} onClick={() => void mutate("retry")}>{mutation ? "正在处理…" : retryLabel}</Button> : job.executionMode === "worker" && chatHref ? <Button asChild><Link href={chatHref}>回到对话<ArrowUpRightIcon size={15} /></Link></Button> : canCancelCuratorJob(job.status) ? <Button variant="outline" disabled={mutation} onClick={() => setConfirmCancel(true)}>停止整理</Button> : job.candidateBatchId ? <Button asChild><Link href={reviewHref(job)}>查看处理结果</Link></Button> : null}
			</div></div>
			{actionError ? <p role="alert" className={styles.error}>{actionError}</p> : null}
			<div className={styles.detailGrid}><div>
				<section className={styles.card}><h2>{job.displayStatus === "published" ? "本次更新的资料" : "本次整理的资料"}</h2>{job.review ? <><p className={styles.resultTotal}>{taskResultLabel(job.result)}</p><ul className={styles.files}>{job.review.files.map(file => <li key={file.path}>{file.kind === "image" ? <ImageIcon size={17} /> : <FileTextIcon size={17} />}<span><strong>{file.title}</strong><small>{file.category === "attachment" ? "图片附件" : file.category === "directory" ? "目录" : "资料"}</small></span><em>{job.displayStatus === "partial" ? ({applied:"已更新",rolled_back:"已还原",failed:"未完成",conflict:"需确认",uncertain:"待核对",pending:"待处理"} as Record<string,string>)[file.publicationStatus ?? "pending"] ?? "待处理" : file.operation === "create" ? "新增" : file.operation === "delete" ? "删除" : "更新"}</em></li>)}</ul></> : <p className={styles.hint}>{job.canRetryRegistration ? "整理的修改已保留，送达审核后可以查看。" : ["queued","running","submitting"].includes(job.displayStatus) ? "整理完成后，这里会列出新增或更新的资料。" : "本次没有可审核的资料修改。"}</p>}{job.candidateBatchId ? <Link className={styles.link} href={reviewHref(job)}>查看完整内容与处理结果<ArrowUpRightIcon size={14} /></Link> : null}</section>
				<section className={styles.card}><h2>{job.materialIsRequest ? "来源请求" : "资料来源"}</h2><p className={styles.sourceMeta}><MessageSquareIcon size={15} />{job.executionMode === "worker" ? "来源对话" : "知识库 · 添加资料"} · {time(job.createdAt)}</p>{job.material && !job.materialIsRequest ? <blockquote className={styles.quote}>{job.material}</blockquote> : <p className={styles.hint}>{job.materialUnavailable ? "原始资料暂不可读，任务与修改记录仍保留。" : "原始资料见附件或来源对话。"}</p>}{job.sources?.filter(s=>s.kind !== "text").map(s => <p className={styles.attachmentSource} key={s.id}><FileTextIcon size={14} />{s.title}</p>)}{job.executionMode === "worker" ? chatHref ? <Link className={styles.link} href={chatHref}>查看原对话<ArrowUpRightIcon size={14} /></Link> : <p className={styles.hint}>来源对话暂不可用，资料和任务记录仍保留。</p> : <p className={styles.hint}>整理要求：{job.task}</p>}</section>
				{job.review?.feedback ? <section className={styles.card}><h2>修改意见</h2><p className={styles.quote}>{job.review.feedback}</p>{job.review.revisionJobId ? <Link className={styles.link} href={curatorJobHref(job.review.revisionJobId,job.targetBindingId)}>查看修改进度<ChevronRightIcon size={14} /></Link> : <p className={styles.hint}>修订任务正在准备，请稍后刷新。</p>}</section> : null}
				{job.retryOf || job.parentBatchId ? <section className={styles.card}><h2>关联记录</h2>{job.retryOf ? <Link className={styles.link} href={curatorJobHref(job.retryOf,job.targetBindingId)}>查看上次整理<ChevronRightIcon size={14} /></Link> : null}{job.parentBatchId ? <Link className={styles.link} href={`/knowledge/review?vault=${encodeURIComponent(job.targetBindingId)}&batch=${encodeURIComponent(job.parentBatchId)}`}>查看退回的修改<ChevronRightIcon size={14} /></Link> : null}</section> : null}
				<details className={styles.advanced}><summary>排查信息</summary><dl><dt>任务编号</dt><dd>{job.id}</dd><dt>整理状态</dt><dd>{job.status}</dd><dt>错误记录</dt><dd>{job.failureCode || "无"}</dd><dt>模型</dt><dd>{job.diagnostics?.modelProvider} / {job.diagnostics?.modelId || "未记录"}</dd></dl><pre>{job.task}</pre></details>
			</div><aside className={styles.card}><h2>任务进度</h2><ol className={styles.steps}>{["收到资料","整理资料","审核修改","发布到知识库"].map((label,i) => <li key={label} data-stage={i < activeStep ? "done" : i === activeStep ? stopped ? "stopped" : "current" : "next"}><strong>{i === activeStep && stopped ? stopLabel[job.displayStatus] : label}</strong><small>{i === 0 ? time(job.createdAt) : i === 2 && job.review ? time(job.review.enteredReviewAt) : i === 3 && job.displayStatus === "published" ? time(job.publication?.finishedAt ?? job.review?.updatedAt ?? job.activityAt) : ""}</small></li>)}</ol>{canCancelCuratorJob(job.status) ? <button className={styles.link} type="button" disabled={mutation} onClick={() => setConfirmCancel(true)}>停止整理</button> : null}</aside></div>
			<Dialog open={confirmCancel} onOpenChange={setConfirmCancel}><DialogContent><DialogHeader><DialogTitle>停止这次整理？</DialogTitle><DialogDescription>停止后不再继续整理，知识库不会因此更新。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setConfirmCancel(false)}>继续整理</Button><Button variant="destructive" disabled={mutation} onClick={() => void mutate("cancel")}>{mutation ? "正在停止…" : "停止整理"}</Button></DialogFooter></DialogContent></Dialog>
		</section>;
	}
	return <section className={styles.center} aria-label="编译任务中心"><header className={styles.heading}><div><h1>编译任务</h1><p>查看资料整理进度，完成后确认修改。</p></div>{refresh}</header>
		{bindingId ? <p className={styles.scope}><LayersIcon size={15} />正在查看 {bindings.find(b=>b.id===bindingId)?.name} 的任务 <button onClick={() => navigate({vault:null,offset:null})}>查看全部知识库</button></p> : null}
		{error ? <p role="alert" className={styles.error}>{error} <button onClick={() => setNonce(n=>n+1)}>重试</button></p> : null}
		<section className={styles.panel}><div className={styles.tabs} role="tablist" aria-label="任务状态">{groups.map(([key,label]) => <button key={key} role="tab" aria-selected={group===key} onClick={() => navigate({filter:key,offset:null})}>{label}<span>{data?.counts[key] ?? "…"}</span></button>)}</div>
			<div className={styles.filters}><form className={styles.search} onSubmit={e=>{e.preventDefault();navigate({q:search.trim(),offset:null});}}><SearchIcon size={15} /><input aria-label="搜索任务" value={search} maxLength={200} onChange={e=>setSearch(e.target.value)} placeholder="搜索任务或知识库" /><button type="submit" aria-label="执行搜索"><ChevronRightIcon size={14} /></button></form><select aria-label="筛选知识库" value={bindingId ?? ""} onChange={e=>navigate({vault:e.target.value,offset:null})}><option value="">全部知识库</option>{bindings.map(b=><option value={b.id} key={b.id}>{b.name}</option>)}</select><select aria-label="时间范围" value={period} onChange={e=>navigate({period:e.target.value,offset:null})}><option value="week">最近 7 天</option><option value="all">全部时间</option></select></div>
			{!data ? <p className={styles.empty}>正在读取任务…</p> : data.jobs.length ? <table className={styles.table}><thead><tr><th>任务</th><th>知识库</th><th>状态</th><th>结果</th><th>最近更新</th><th></th></tr></thead><tbody>{data.jobs.map(job=><tr key={job.id}><td><Link className={styles.taskTitle} href={taskHref(job)}>{job.title}</Link><p className={styles.taskSource}><span className={styles.mobileVault}>{job.bindingName} · </span>{job.executionMode === "worker" ? "来源对话" : "知识库 · 添加资料"}</p></td><td><span className={styles.vaultLabel}><LayersIcon size={14} />{job.bindingName}</span></td><td><Status job={job} /></td><td>{job.displayStatus === "nochanges" ? "没有资料变更" : taskResultLabel(job.result)}</td><td>{time(job.activityAt)}</td><td><Link href={job.displayStatus === "pending" && job.candidateBatchId ? reviewHref(job) : taskHref(job)}>{job.displayStatus === "pending" ? "去审核" : "查看"}</Link></td></tr>)}</tbody></table> : <div className={styles.empty}><SearchIcon size={25} /><h2>{query || group !== "all" ? "没有匹配的任务" : "还没有编译任务"}</h2><p>{query || group !== "all" ? "试试其他关键词或筛选条件。" : "在知识库里添加资料，或与管理员对话后，进度会显示在这里。"}</p><button onClick={()=>{setSearch("");navigate({q:null,filter:null,period:"all",offset:null});}}>清除筛选</button></div>}
			<footer className={styles.panelFooter}><span>{data ? `共 ${data.total} 项 · 最近更新优先` : ""}</span><div><button disabled={!offset} onClick={()=>navigate({offset:String(Math.max(0,offset-25))})}>上一页</button><button disabled={!data || offset+25>=data.total} onClick={()=>navigate({offset:String(offset+25)})}>下一页</button></div></footer>
		</section>
	</section>;
}
