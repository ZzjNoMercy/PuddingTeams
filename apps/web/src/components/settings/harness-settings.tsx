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
type VerificationPreset = "quick" | "standard" | "strict" | "custom";

const verificationPresets: Array<{ id: Exclude<VerificationPreset, "custom">; label: string; description: string }> = [
	{ id: "quick", label: "快速", description: "WorkItem 和 Goal 都由 Manager 验收" },
	{ id: "standard", label: "标准", description: "Manager 验收过程，独立 Reviewer 验收最终 Goal" },
	{ id: "strict", label: "严格", description: "过程独立验收，最终还要做环境复验" },
];

function getVerificationPreset(verification: HarnessSettings["verification"]): VerificationPreset {
	if (verification.defaultWorkItemMode === "manager_review" && verification.defaultFinalGoalMode === "manager_review") return "quick";
	if (verification.defaultWorkItemMode === "manager_review" && verification.defaultFinalGoalMode === "independent_evidence_review") return "standard";
	if (verification.defaultWorkItemMode === "independent_evidence_review" && verification.defaultFinalGoalMode === "environment_verified") return "strict";
	return "custom";
}

function applyVerificationPreset(verification: HarnessSettings["verification"], preset: Exclude<VerificationPreset, "custom">): HarnessSettings["verification"] {
	if (preset === "quick") return { ...verification, defaultWorkItemMode: "manager_review", defaultFinalGoalMode: "manager_review" };
	if (preset === "strict") return { ...verification, defaultWorkItemMode: "independent_evidence_review", defaultFinalGoalMode: "environment_verified" };
	return { ...verification, defaultWorkItemMode: "manager_review", defaultFinalGoalMode: "independent_evidence_review" };
}

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
			reviewers: { evidenceModel: "", cliAgentId: "", requireRoomMember: false }, cliEnvironmentMode: "isolated_copy",
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
				<div><h3 className="text-sm font-semibold">恢复方式</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">只决定服务重启后由谁发起恢复。系统不会重放已经执行过的旧 Run。</p></div>
				<div className="harness-choice-grid harness-choice-grid-two" role="radiogroup" aria-label="solo 和 group 的恢复方式">
					<button type="button" className="harness-choice" role="radio" aria-checked={value.goalRecovery.mode === "safe_auto"} data-active={value.goalRecovery.mode === "safe_auto" ? "true" : "false"} onClick={() => setValue((current) => ({ ...current, goalRecovery: { ...current.goalRecovery, mode: "safe_auto" } }))}>
						<strong>安全自动恢复 <span>推荐</span></strong><small>唤醒 Manager，从安全点重新判断下一步。</small>
					</button>
					<button type="button" className="harness-choice" role="radio" aria-checked={value.goalRecovery.mode === "manual"} data-active={value.goalRecovery.mode === "manual" ? "true" : "false"} onClick={() => setValue((current) => ({ ...current, goalRecovery: { ...current.goalRecovery, mode: "manual" } }))}>
						<strong>手动恢复</strong><small>重启后保持暂停，等待用户决定是否继续。</small>
					</button>
				</div>
				<details className="harness-advanced">
					<summary>高级恢复参数</summary>
					<div className="grid gap-3 pt-3 sm:grid-cols-2">
						<label className="space-y-1.5 text-xs"><span className="font-medium">恢复租约（秒）</span><Input type="number" min={5} max={300} value={value.goalRecovery.resumeLeaseMs / 1_000} onChange={(event) => setValue((current) => ({ ...current, goalRecovery: { ...current.goalRecovery, resumeLeaseMs: Number(event.target.value) * 1_000 } }))} /><span className="block text-[10px] leading-4 text-muted-foreground">防止多个恢复流程同时接管同一个 Goal。</span></label>
						<label className="space-y-1.5 text-xs"><span className="font-medium">幂等记录保留（天）</span><Input type="number" min={7} max={365} value={value.goalRecovery.operationRetentionDays} onChange={(event) => setValue((current) => ({ ...current, goalRecovery: { ...current.goalRecovery, operationRetentionDays: Number(event.target.value) } }))} /><span className="block text-[10px] leading-4 text-muted-foreground">用于识别重复恢复请求。</span></label>
						<label className="space-y-1.5 text-xs sm:col-span-2"><span className="font-medium">每个 Session 至少保留的操作记录</span><Input type="number" min={128} max={4096} value={value.goalRecovery.maxOperationsPerSession} onChange={(event) => setValue((current) => ({ ...current, goalRecovery: { ...current.goalRecovery, maxOperationsPerSession: Number(event.target.value) } }))} /></label>
					</div>
				</details>
				<div className="harness-safety-note"><strong>固定安全规则</strong><p>Direct 会话始终手动恢复；自动恢复只唤醒 Manager，不会自动重跑 Worker 或重复副作用。</p></div>
			</div> : null}
			{tab === "verification" ? <div className="harness-settings-pane">
				<div><h3 className="text-sm font-semibold">默认验收强度</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">为新建任务选择一套默认策略。已开始的 WorkItem 和 Goal 不会被全局设置改写。</p></div>
				<div className="harness-choice-grid" role="radiogroup" aria-label="默认验收强度">
					{verificationPresets.map((preset) => <button key={preset.id} type="button" className="harness-choice" role="radio" aria-checked={getVerificationPreset(value.verification) === preset.id} data-active={getVerificationPreset(value.verification) === preset.id ? "true" : "false"} onClick={() => setValue((current) => ({ ...current, verification: applyVerificationPreset(current.verification, preset.id) }))}>
						<strong>{preset.label}{preset.id === "standard" ? <span>推荐</span> : null}</strong><small>{preset.description}</small>
					</button>)}
				</div>
				{getVerificationPreset(value.verification) === "custom" ? <p className="harness-inline-status">当前是高级设置中的自定义组合。</p> : null}
				<label className="space-y-1.5 text-xs"><span className="font-medium">何时启动独立验收</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.verification.trigger} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, trigger: event.target.value as HarnessSettings["verification"]["trigger"] } }))}><option value="manager_request">由 Manager 判断需要时启动（推荐）</option><option value="auto_on_submission">Worker 提交后自动启动</option></select></label>
				<details className="harness-advanced">
					<summary>高级验收设置</summary>
					<div className="grid gap-3 pt-3 sm:grid-cols-2">
						<label className="space-y-1.5 text-xs"><span className="font-medium">WorkItem 验收</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.verification.defaultWorkItemMode} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, defaultWorkItemMode: event.target.value as HarnessSettings["verification"]["defaultWorkItemMode"] } }))}><option value="manager_review">Manager 验收</option><option value="independent_evidence_review">独立证据验收</option></select></label>
						<label className="space-y-1.5 text-xs"><span className="font-medium">Goal 最终验收</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.verification.defaultFinalGoalMode} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, defaultFinalGoalMode: event.target.value as HarnessSettings["verification"]["defaultFinalGoalMode"] } }))}><option value="manager_review">Manager 验收</option><option value="independent_evidence_review">独立证据验收</option><option value="environment_verified">环境复验</option></select></label>
						<label className="space-y-1.5 text-xs"><span className="font-medium">Reviewer 模型</span><Input placeholder="留空则跟随 Manager 模型" value={value.verification.reviewers.evidenceModel} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, reviewers: { ...current.verification.reviewers, evidenceModel: event.target.value } } }))} /><span className="block text-[10px] leading-4 text-muted-foreground">仅用于无工具的证据 Reviewer；自定义格式为 provider/model。</span></label>
						<label className="space-y-1.5 text-xs"><span className="font-medium">CLI 复验 Worker</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.verification.reviewers.cliAgentId} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, reviewers: { ...current.verification.reviewers, cliAgentId: event.target.value } } }))}><option value="">自动选择当前 Executor</option>{agents.map((agent) => <option key={agent.name} value={agent.name}>{agent.displayName?.trim() || agent.name}（{agent.name}）</option>)}</select></label>
						<label className="space-y-1.5 text-xs"><span className="font-medium">CLI 复验环境</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.verification.cliEnvironmentMode} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, cliEnvironmentMode: event.target.value as HarnessSettings["verification"]["cliEnvironmentMode"] } }))}><option value="isolated_copy">隔离副本（推荐）</option><option value="same_target_guarded">原目标受控只读</option></select></label>
						<label className="space-y-1.5 text-xs"><span className="font-medium">房间成员要求</span><select className="h-9 w-full rounded-md border bg-background px-2" value={String(value.verification.reviewers.requireRoomMember)} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, reviewers: { ...current.verification.reviewers, requireRoomMember: event.target.value === "true" } } }))}><option value="false">不要求，保留可审计 Delegation</option><option value="true">Verifier 必须先加入房间</option></select></label>
						<label className="harness-check-row sm:col-span-2"><input type="checkbox" checked={value.verification.isolation.requireDifferentAgent} onChange={(event) => setValue((current) => ({ ...current, verification: { ...current.verification, isolation: { ...current.verification.isolation, requireDifferentAgent: event.target.checked } } }))} /><span><strong>必须使用不同 Agent</strong><small>默认允许同一 Agent 在全新 Session 中复验；开启后要求身份也不同。</small></span></label>
					</div>
				</details>
				<div className="harness-safety-note"><strong>平台始终强制</strong><p>每次复验使用 fresh Session；无法找到 Verifier、证据捕获失败或远端 Run 无法对账时都会阻塞，不会降级为自动通过。首期强制复验只覆盖 CLI / 代码任务。</p></div>
			</div> : null}
			{tab === "workspace" ? <div className="harness-settings-pane">
				<div><h3 className="text-sm font-semibold">Git 写入方式</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">选择 Worker 修改 Git 项目时的默认工作方式。只读任务和非 Git 写任务由平台采用固定安全策略。</p></div>
				<div className="harness-choice-grid harness-choice-grid-two" role="radiogroup" aria-label="Git 写入方式">
					<button type="button" className="harness-choice" role="radio" aria-checked={value.workspaceExecution.gitWriteDefault === "isolated_worktree"} data-active={value.workspaceExecution.gitWriteDefault === "isolated_worktree" ? "true" : "false"} onClick={() => setValue((current) => ({ ...current, workspaceExecution: { ...current.workspaceExecution, gitWriteDefault: "isolated_worktree" } }))}>
						<strong>隔离 Worktree <span>推荐</span></strong><small>每个写任务独立执行，验收后再提升 change-set。</small>
					</button>
					<button type="button" className="harness-choice" role="radio" aria-checked={value.workspaceExecution.gitWriteDefault === "exclusive_write"} data-active={value.workspaceExecution.gitWriteDefault === "exclusive_write" ? "true" : "false"} onClick={() => setValue((current) => ({ ...current, workspaceExecution: { ...current.workspaceExecution, gitWriteDefault: "exclusive_write" } }))}>
						<strong>独占当前目录</strong><small>串行锁定目标 Workspace，适合无法使用 worktree 的流程。</small>
					</button>
				</div>
				<details className="harness-advanced">
					<summary>高级 Workspace 参数</summary>
					<label className="mt-3 block space-y-1.5 text-xs"><span className="font-medium">独占租约（分钟）</span><Input type="number" min={1} max={60} value={value.workspaceExecution.leaseTimeoutMs / 60_000} onChange={(event) => setValue((current) => ({ ...current, workspaceExecution: { ...current.workspaceExecution, leaseTimeoutMs: Number(event.target.value) * 60_000 } }))} /><span className="block text-[10px] leading-4 text-muted-foreground">仅用于需要独占写入的任务；超时后重新协调所有权。</span></label>
				</details>
				<div className="harness-safety-note"><strong>平台始终强制</strong><p>只读任务共享只读；非 Git 写任务独占执行并记录 baseline/write-set；验收通过后提升精确 change-set，但不自动 commit 或 push。发生冲突时保留 worktree/diff 并阻塞，Manager 写任务必须委托 Worker。</p></div>
			</div> : null}
			<div className="harness-settings-footer"><Button disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</Button></div>
		</section>
	</div>;
}
