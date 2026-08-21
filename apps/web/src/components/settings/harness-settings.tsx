"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getHarnessSettings, setHarnessSettings, type HarnessSettings } from "@/lib/api";

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
export function HarnessSettingsPanel() {
	const [value, setValue] = useState<HarnessSettings>({
		workerResults: defaults,
		goalActivation: { solo: "manager_explicit", group: "manager_explicit", direct: "user_explicit", confirmWhenAmbiguous: true },
		goalRecovery: { mode: "safe_auto", directMode: "manual", resumeLeaseMs: 30_000, operationRetentionDays: 30, maxOperationsPerSession: 512 },
	});
	const [saving, setSaving] = useState(false);
	useEffect(() => { void getHarnessSettings().then(setValue).catch((error) => toast.error(error instanceof Error ? error.message : String(error))) }, []);
	const save = async () => {
		setSaving(true);
		try { setValue(await setHarnessSettings(value)); toast.success("Harness 设置已保存") }
		catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
		finally { setSaving(false) }
	};
	return <div className="space-y-5">
		<div><h3 className="text-sm font-semibold">Worker 结果上下文</h3><p className="mt-1 text-xs leading-5 text-muted-foreground">超长结果始终无损外置；这里只调整预览和分页预算，不能退回静默硬截断。token 使用 ceil(chars/4) 估算。</p></div>
		<div className="grid gap-3 sm:grid-cols-2">{fields.map((field) => <label key={field.key} className="space-y-1.5 text-xs"><span className="font-medium">{field.label}</span><Input type="number" min={1} value={value.workerResults[field.key]} onChange={(event) => setValue((current) => ({ ...current, workerResults: { ...current.workerResults, [field.key]: Number(event.target.value) } }))} /><span className="block text-[10px] leading-4 text-muted-foreground">{field.hint}</span></label>)}</div>
		<div className="border-t pt-4"><h3 className="text-sm font-semibold">Goal 激活</h3><div className="mt-3 grid gap-3 sm:grid-cols-2">
			{(["solo", "group"] as const).map((kind) => <label key={kind} className="space-y-1.5 text-xs"><span className="font-medium">{kind}</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.goalActivation[kind]} onChange={(event) => setValue((current) => ({ ...current, goalActivation: { ...current.goalActivation, [kind]: event.target.value as HarnessSettings["goalActivation"][typeof kind] } }))}><option value="manager_explicit">Manager 显式创建</option><option value="user_explicit">仅用户显式创建</option><option value="disabled">禁用</option></select></label>)}
			<label className="space-y-1.5 text-xs"><span className="font-medium">direct</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.goalActivation.direct} onChange={(event) => setValue((current) => ({ ...current, goalActivation: { ...current.goalActivation, direct: event.target.value as "user_explicit" | "disabled" } }))}><option value="user_explicit">仅用户显式创建</option><option value="disabled">禁用</option></select></label>
			<label className="flex items-center gap-2 self-end pb-2 text-xs"><input type="checkbox" checked={value.goalActivation.confirmWhenAmbiguous} onChange={(event) => setValue((current) => ({ ...current, goalActivation: { ...current.goalActivation, confirmWhenAmbiguous: event.target.checked } }))} />目标含糊时先确认</label>
		</div></div>
		<div className="border-t pt-4"><h3 className="text-sm font-semibold">恢复与幂等账本</h3><p className="mt-1 text-[11px] text-muted-foreground">direct 始终手动恢复；自动恢复只唤醒 Manager 从安全点决策，不重放旧 Run。</p><div className="mt-3 grid gap-3 sm:grid-cols-2">
			<label className="space-y-1.5 text-xs"><span className="font-medium">solo/group 恢复</span><select className="h-9 w-full rounded-md border bg-background px-2" value={value.goalRecovery.mode} onChange={(event) => setValue((current) => ({ ...current, goalRecovery: { ...current.goalRecovery, mode: event.target.value as "safe_auto" | "manual" } }))}><option value="safe_auto">安全自动恢复</option><option value="manual">手动恢复</option></select></label>
			{([{ key: "resumeLeaseMs", label: "恢复租约（毫秒）" }, { key: "operationRetentionDays", label: "幂等记录保留（天）" }, { key: "maxOperationsPerSession", label: "每 Session 最少保留条数" }] as const).map((field) => <label key={field.key} className="space-y-1.5 text-xs"><span className="font-medium">{field.label}</span><Input type="number" min={1} value={value.goalRecovery[field.key]} onChange={(event) => setValue((current) => ({ ...current, goalRecovery: { ...current.goalRecovery, [field.key]: Number(event.target.value) } }))} /></label>)}
		</div></div>
		<div className="flex justify-end"><Button disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</Button></div>
	</div>;
}
