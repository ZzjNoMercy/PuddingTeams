"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getHarnessSettings, listAgents, setHarnessSettings, type HarnessSettings } from "@/lib/api";
import type { AgentConfig } from "@/lib/types";

const defaults: HarnessSettings["workerResults"] = {
	offloadThresholdTokens: 20_000,
	previewHeadTokens: 6_000,
	previewTailTokens: 2_000,
	readChunkTokens: 8_000,
};
const fields: Array<{ key: keyof typeof defaults; label: string; hint: string }> = [
	{ key: "offloadThresholdTokens", label: "外置阈值", hint: "超过该估算 token 数时无损落盘。" },
	{ key: "previewHeadTokens", label: "头部预览", hint: "toolResult 中保留的开头预算。" },
	{ key: "previewTailTokens", label: "尾部预览", hint: "保留结论、风险和引用所在的尾部预算。" },
	{ key: "readChunkTokens", label: "分页读取", hint: "read_delegation_result 的默认单页预算。" },
];
type HarnessTab = "search" | "results" | "activation" | "recovery" | "verification" | "workspace";
const harnessTabs: Array<{ id: HarnessTab; label: string }> = [
	{ id: "search", label: "代码搜索" },
	{ id: "results", label: "结果上下文" },
	{ id: "activation", label: "Goal 激活" },
	{ id: "recovery", label: "安全恢复" },
	{ id: "verification", label: "独立验收" },
	{ id: "workspace", label: "Workspace" },
];
export function HarnessSettingsPanel() {
	const [value, setValue] = useState<HarnessSettings>({
		codeSearch: { defaultProvider: "builtin" },
		workerResults: defaults,
		goalActivation: { solo: "manager_explicit", group: "manager_explicit", direct: "user_explicit", confirmWhenAmbiguous: true },
		goalRecovery: { mode: "safe_auto", directMode: "manual", resumeLeaseMs: 30_000, operationRetentionDays: 30, maxOperationsPerSession: 512 },
		verification: {
			enabled: true, defaultWorkItemMode: "manager_review", defaultFinalGoalMode: "independent_evidence_review", trigger: "manager_request",
			reviewers: { evidenceModel: "provider/model", cliAgentId: "", requireRoomMember: false }, cliEnvironmentMode: "isolated_copy",
			isolation: { requireFreshSession: true, forbidExecutorContinuation: true, requireDifferentAgent: false }, firstReleaseScope: "cli_code_first",
			unavailableAction: "block", artifactCaptureFailure: "partial_receipt_block", remoteRunUnknown: "observation_lost_effect_unknown", cancelUnconfirmed: "cancel_requested_observation_lost",
		},
		workspaceExecution: {
			readOnlyDefault: "read_only_shared", gitWriteDefault: "isolated_worktree", nonGitWriteDefault: "exclusive_write", leaseTimeoutMs: 600_000,
			promotion: { autoApplyAfterAcceptance: true, autoCommit: false, autoPush: false, conflictAction: "block_preserve_changes" }, managerWritePolicy: "delegation_required",
		},
	});
	const [saving, setSaving] = useState(false);
	const [tab, setTab] = useState<HarnessTab>("search");
	const [agents, setAgents] = useState<AgentConfig[]>([]);
	useEffect(() => {
		void Promise.all([getHarnessSettings(), listAgents()])
			.then(([settings, availableAgents]) => { setValue(settings); setAgents(availableAgents.filter((agent) => !agent.pinned && agent.enabled !== false)); })
			.catch((error) => toast.error(error instanceof Error ? error.message : String(error)));
	}, []);
	const save = async () => {
		setSaving(true);
		try { setValue(await setHarnessSettings(value)); toast.success("Harness 设置已保存") }
		catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
		finally { setSaving(false) }
	};
	return <div className="harness-settings">
		<div className="harness-settings-tabs" role="tablist" aria-label="Harness 配置分类">
			{harnessTabs.map((item) => <button key={item.id} id={`harness-tab-${item.id}`} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`harness-panel-${item.id}`} data-active={tab === item.id ? "true" : "false"} onClick={() => setTab(item.id)}>{item.label}</button>)}
		</div>
		<section id={`harness-panel-${tab}`} className="settings-card harness-settings-card" role="tabpanel" aria-labelledby={`harness-tab-${tab}`}>
			{tab === "search" ? <div className="harness-settings-pane">
				<div><h3 className="text-sm font-semibold">Worker 默认代码搜索</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">Worker 可用 inherit / builtin / fff 单独覆盖。FFF 只为当前已信任 Workspace 建索引，状态不会跨 Workspace 共享。</p></div>
				<label className="space-y-1.5 text-xs"><span className="font-medium">默认实现</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.codeSearch.defaultProvider} onChange={(event) => setValue((current) => ({ ...current, codeSearch: { defaultProvider: event.target.value as "builtin" | "fff" } }))}><option value="builtin">Pi 内置 grep/find</option><option value="fff">FFF Workspace 索引</option></select></label>
			</div> : null}
			{tab === "results" ? <div className="harness-settings-pane">
				<div><h3 className="text-sm font-semibold">Worker 结果上下文</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">超长结果始终无损外置；这里只调整预览和分页预算，不能退回静默硬截断。token 使用 ceil(chars/4) 估算。</p></div>
				<div className="grid gap-3 sm:grid-cols-2">{fields.map((field) => <label key={field.key} className="space-y-1.5 text-xs"><span className="font-medium">{field.label}</span><Input type="number" min={1} value={value.workerResults[field.key]} onChange={(event) => setValue((current) => ({ ...current, workerResults: { ...current.workerResults, [field.key]: Number(event.target.value) } }))} /><span className="block text-[10px] leading-4 text-muted-foreground">{field.hint}</span></label>)}</div>
			</div> : null}
			{tab === "activation" ? <div className="harness-settings-pane">
				<h3 className="text-sm font-semibold">Goal 激活</h3>
				<div className="grid gap-3 sm:grid-cols-2">
					{(["solo", "group"] as const).map((kind) => <label key={kind} className="space-y-1.5 text-xs"><span className="font-medium">{kind}</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.goalActivation[kind]} onChange={(event) => setValue((current) => ({ ...current, goalActivation: { ...current.goalActivation, [kind]: event.target.value as HarnessSettings["goalActivation"][typeof kind] } }))}><option value="manager_explicit">Manager 显式创建</option><option value="user_explicit">仅用户显式创建</option><option value="disabled">禁用</option></select></label>)}
					<label className="space-y-1.5 text-xs"><span className="font-medium">direct</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.goalActivation.direct} onChange={(event) => setValue((current) => ({ ...current, goalActivation: { ...current.goalActivation, direct: event.target.value as "user_explicit" | "disabled" } }))}><option value="user_explicit">仅用户显式创建</option><option value="disabled">禁用</option></select></label>
					<label className="flex items-center gap-2 self-end pb-2 text-xs"><input type="checkbox" checked={value.goalActivation.confirmWhenAmbiguous} onChange={(event) => setValue((current) => ({ ...current, goalActivation: { ...current.goalActivation, confirmWhenAmbiguous: event.target.checked } }))} />目标含糊时先确认</label>
				</div>
			</div> : null}
			{tab === "recovery" ? <div className="harness-settings-pane">
				<div><h3 className="text-sm font-semibold">恢复与幂等账本</h3><p className="mt-1 text-[11px] text-muted-foreground">direct 始终手动恢复；自动恢复只唤醒 Manager 从安全点决策，不重放旧 Run。</p></div>
				<div className="grid gap-3 sm:grid-cols-2">
					<label className="space-y-1.5 text-xs"><span className="font-medium">solo/group 恢复</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.goalRecovery.mode} onChange={(event) => setValue((current) => ({ ...current, goalRecovery: { ...current.goalRecovery, mode: event.target.value as "safe_auto" | "manual" } }))}><option value="safe_auto">安全自动恢复</option><option value="manual">手动恢复</option></select></label>
					{([{ key: "resumeLeaseMs", label: "恢复租约（毫秒）" }, { key: "operationRetentionDays", label: "幂等记录保留（天）" }, { key: "maxOperationsPerSession", label: "每 Session 最少保留条数" }] as const).map((field) => <label key={field.key} className="space-y-1.5 text-xs"><span className="font-medium">{field.label}</span><Input type="number" min={1} value={value.goalRecovery[field.key]} onChange={(event) => setValue((current) => ({ ...current, goalRecovery: { ...current.goalRecovery, [field.key]: Number(event.target.value) } }))} /></label>)}
				</div>
			</div> : null}
			{tab === "verification" ? <div className="harness-settings-pane">
				<div><h3 className="text-sm font-semibold">独立证据验收</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">这些是新建 WorkItem/Goal 时使用的默认策略；已冻结的任务不会随全局设置漂移。</p></div>
				<div className="grid gap-3 sm:grid-cols-2">
					<label className="space-y-1.5 text-xs"><span className="font-medium">默认 WorkItem 验收</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.verification.defaultWorkItemMode} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, defaultWorkItemMode: event.target.value as HarnessSettings["verification"]["defaultWorkItemMode"] } }))}><option value="manager_review">Manager 验收</option><option value="independent_evidence_review">独立证据验收</option></select></label>
					<label className="space-y-1.5 text-xs"><span className="font-medium">默认 Goal 最终验收</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.verification.defaultFinalGoalMode} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, defaultFinalGoalMode: event.target.value as HarnessSettings["verification"]["defaultFinalGoalMode"] } }))}><option value="independent_evidence_review">独立证据验收</option><option value="manager_review">Manager 验收</option><option value="environment_verified">环境复验</option></select></label>
					<label className="space-y-1.5 text-xs"><span className="font-medium">复验触发</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.verification.trigger} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, trigger: event.target.value as HarnessSettings["verification"]["trigger"] } }))}><option value="manager_request">Manager 请求时</option><option value="auto_on_submission">提交时自动触发</option></select></label>
					<label className="space-y-1.5 text-xs"><span className="font-medium">Verifier 模型</span><Input value={value.verification.reviewers.evidenceModel} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, reviewers: { ...current.verification.reviewers, evidenceModel: event.target.value } } }))} /><span className="block text-[10px] leading-4 text-muted-foreground">格式示例：provider/model。</span></label>
					<label className="space-y-1.5 text-xs"><span className="font-medium">CLI Verifier Worker</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.verification.reviewers.cliAgentId} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, reviewers: { ...current.verification.reviewers, cliAgentId: event.target.value } } }))}><option value="">自动：使用 Executor</option>{agents.map((agent) => <option key={agent.name} value={agent.name}>{agent.displayName?.trim() || agent.name}（{agent.name}）</option>)}</select><span className="block text-[10px] leading-4 text-muted-foreground">运行时仍校验 CLI 能力、Room 规则与 fresh Session。</span></label>
					<label className="space-y-1.5 text-xs"><span className="font-medium">Verifier 房间成员要求</span><select className="h-9 w-full rounded-md border bg-background px-2" value={String(value.verification.reviewers.requireRoomMember)} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, reviewers: { ...current.verification.reviewers, requireRoomMember: event.target.value === "true" } } }))}><option value="false">不要求（可审计 Delegation）</option><option value="true">必须先加入 Room</option></select></label>
					<label className="space-y-1.5 text-xs"><span className="font-medium">CLI 复验环境</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.verification.cliEnvironmentMode} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, cliEnvironmentMode: event.target.value as HarnessSettings["verification"]["cliEnvironmentMode"] } }))}><option value="isolated_copy">隔离复制目录</option><option value="same_target_guarded">原目标受控只读</option></select></label>
					<label className="flex items-center gap-2 self-end pb-2 text-xs"><input type="checkbox" disabled checked={value.verification.enabled} />启用独立复验（首期固定）</label>
					<label className="flex items-center gap-2 self-end pb-2 text-xs"><input type="checkbox" checked={value.verification.isolation.requireDifferentAgent} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, isolation: { ...current.verification.isolation, requireDifferentAgent: event.target.checked } } }))} />强制使用不同 Agent</label>
				</div>
				<div className="grid gap-3 sm:grid-cols-2">
					<label className="space-y-1.5 text-xs"><span className="font-medium">首期复验范围</span><select disabled className="h-9 w-full rounded-md border bg-muted px-2" value={value.verification.firstReleaseScope}><option value="cli_code_first">先 CLI / 代码，后 GUI</option></select></label>
					<label className="space-y-1.5 text-xs"><span className="font-medium">无可用 Verifier</span><select disabled className="h-9 w-full rounded-md border bg-muted px-2" value={value.verification.unavailableAction}><option value="block">阻塞（fail closed）</option></select></label>
					<label className="space-y-1.5 text-xs"><span className="font-medium">Artifact 捕获失败</span><select disabled className="h-9 w-full rounded-md border bg-muted px-2" value={value.verification.artifactCaptureFailure}><option value="partial_receipt_block">保留 partial Receipt 并阻塞验收</option></select></label>
					<label className="space-y-1.5 text-xs"><span className="font-medium">远端 Run 无法对账</span><select disabled className="h-9 w-full rounded-md border bg-muted px-2" value={value.verification.remoteRunUnknown}><option value="observation_lost_effect_unknown">observation_lost / effect_unknown</option></select></label>
					<label className="space-y-1.5 text-xs"><span className="font-medium">取消未获确认</span><select disabled className="h-9 w-full rounded-md border bg-muted px-2" value={value.verification.cancelUnconfirmed}><option value="cancel_requested_observation_lost">cancel_requested → observation_lost</option></select></label>
				</div>
				<p className="text-[10px] leading-4 text-muted-foreground">安全固定项由后端强制校验，即使客户端被绕过也不会允许 fail-open。</p>
			</div> : null}
			{tab === "workspace" ? <div className="harness-settings-pane">
				<div><h3 className="text-sm font-semibold">Workspace 执行与交接</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">写入所有权默认隔离；提升冲突和 Manager 自执行写入始终 fail closed。</p></div>
				<div className="grid gap-3 sm:grid-cols-2">
					<label className="space-y-1.5 text-xs"><span className="font-medium">Git 写任务</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.workspaceExecution.gitWriteDefault} onChange={(event) => setValue((current) => ({ ...current, workspaceExecution: { ...current.workspaceExecution, gitWriteDefault: event.target.value as HarnessSettings["workspaceExecution"]["gitWriteDefault"] } }))}><option value="isolated_worktree">隔离 worktree</option><option value="exclusive_write">独占写入</option></select></label>
					<label className="space-y-1.5 text-xs"><span className="font-medium">非 Git 写任务</span><select disabled className="h-9 w-full rounded-md border bg-muted px-2" value={value.workspaceExecution.nonGitWriteDefault}><option value="exclusive_write">独占写入 + baseline/write-set（首期固定）</option></select></label>
					<label className="space-y-1.5 text-xs"><span className="font-medium">Workspace 租约（毫秒）</span><Input type="number" min={5000} value={value.workspaceExecution.leaseTimeoutMs} onChange={(event) => setValue((current) => ({ ...current, workspaceExecution: { ...current.workspaceExecution, leaseTimeoutMs: Number(event.target.value) } }))} /></label>
					<label className="flex items-center gap-2 self-end pb-2 text-xs"><input type="checkbox" disabled checked={value.workspaceExecution.promotion.autoApplyAfterAcceptance} />验收后自动提升 change-set（固定）</label>
					<label className="flex items-center gap-2 self-end pb-2 text-xs"><input type="checkbox" disabled checked={value.workspaceExecution.promotion.autoCommit} />自动 commit（首期关闭）</label>
					<label className="flex items-center gap-2 self-end pb-2 text-xs"><input type="checkbox" disabled checked={value.workspaceExecution.promotion.autoPush} />自动 push（首期关闭）</label>
				</div>
				<div className="grid gap-3 sm:grid-cols-2">
					<label className="space-y-1.5 text-xs"><span className="font-medium">只读默认</span><select disabled className="h-9 w-full rounded-md border bg-muted px-2" value={value.workspaceExecution.readOnlyDefault}><option value="read_only_shared">共享只读</option></select></label>
					<label className="space-y-1.5 text-xs"><span className="font-medium">提升冲突</span><select disabled className="h-9 w-full rounded-md border bg-muted px-2" value={value.workspaceExecution.promotion.conflictAction}><option value="block_preserve_changes">阻塞并保留 worktree/diff</option></select></label>
					<label className="space-y-1.5 text-xs"><span className="font-medium">Manager 写任务</span><select disabled className="h-9 w-full rounded-md border bg-muted px-2" value={value.workspaceExecution.managerWritePolicy}><option value="delegation_required">必须 Worker Delegation + Receipt</option></select></label>
				</div>
			</div> : null}
			<div className="harness-settings-footer"><Button disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</Button></div>
		</section>
	</div>;
}
