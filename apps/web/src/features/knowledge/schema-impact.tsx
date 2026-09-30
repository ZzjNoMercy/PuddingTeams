"use client";

import { useCallback, useState } from "react";
import { AlertTriangleIcon, EyeIcon, Loader2Icon, RotateCcwIcon, SaveIcon } from "lucide-react";
import {
	planKnowledgeSchema,
	saveKnowledgeSchema,
	KnowledgeApiError,
	type KnowledgeSchemaChange,
	type KnowledgeSchemaImpact,
	type KnowledgeSchemaPreset,
} from "@/lib/api";
import { KnowledgeSchemaEditor } from "./schema-editor";

/**
 * 库内结构编辑：表单与 JSON 共用同一草稿，影响预览成功后才允许 CAS 保存根声明。
 */

const CHANGE_KIND_LABELS: Record<KnowledgeSchemaChange["kind"], string> = {
	entity_added: "新增实体",
	entity_removed: "移除实体",
	entity_directory_changed: "实体目录变更",
	field_added: "新增字段",
	field_removed: "移除字段",
	field_changed: "字段定义变更",
	relation_added: "新增关系",
	relation_removed: "移除关系",
	relation_changed: "关系定义变更",
};

function changeSubject(change: KnowledgeSchemaChange): string {
	if (change.entity) return change.field ? `${change.entity}.${change.field}` : change.entity;
	return change.relation ?? "";
}

function formatShape(value: unknown): string {
	if (value === undefined) return "—";
	return JSON.stringify(value);
}

/** schema-plans 返回的受影响原因逐条中文化。 */
export function affectedReasonLabel(reason: string): string {
	if (reason === "entity_removed") return "实体类型在新结构中已移除";
	if (reason.startsWith("missing_required:")) return `缺少新结构要求的必填字段 ${reason.slice("missing_required:".length)}`;
	if (reason.startsWith("enum_narrowed:")) return `字段 ${reason.slice("enum_narrowed:".length)} 的当前取值不在新枚举范围内`;
	if (reason.startsWith("invalid:")) return `字段 ${reason.slice("invalid:".length)} 不符合新结构校验`;
	if (reason.startsWith("directory_changed:")) {
		const [from, to] = reason.slice("directory_changed:".length).split("->");
		return `实体目录由 ${from}/ 变为 ${to}/，文件位置不再匹配`;
	}
	return reason;
}

interface ImpactResult {
	/** 产生该结果的草稿；仅当与已提交草稿一致时才展示，避免编辑中误读旧结果。 */
	draft: string;
	value: KnowledgeSchemaImpact;
}

interface ImpactFailure {
	draft: string;
	/** schema_invalid 的逐条错误。 */
	issues: string[] | null;
	message: string;
}

export function KnowledgeSchemaImpactPanel({ bindingId, current, currentHash, onSaved, onCancel }: {
	bindingId: string;
	current: KnowledgeSchemaPreset;
	currentHash: string;
	onSaved: () => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState(() => JSON.stringify(current, null, 2));
	const [busy, setBusy] = useState(false);
	const [saving, setSaving] = useState(false);
	const [acknowledged, setAcknowledged] = useState(false);
	const [result, setResult] = useState<ImpactResult | null>(null);
	const [failure, setFailure] = useState<ImpactFailure | null>(null);

	const runPreview = useCallback(async () => {
		setBusy(true);
		setFailure(null);
		const submitted = draft;
		let schema: KnowledgeSchemaPreset;
		try {
			schema = JSON.parse(submitted) as KnowledgeSchemaPreset;
		} catch (cause) {
			setFailure({ draft: submitted, issues: null, message: `JSON 解析失败：${cause instanceof Error ? cause.message : String(cause)}` });
			setBusy(false);
			return;
		}
		try {
			const impact = await planKnowledgeSchema(bindingId, schema);
			setResult({ draft: submitted, value: impact });
		} catch (cause) {
			if (cause instanceof KnowledgeApiError && cause.code === "schema_invalid" && Array.isArray(cause.details)) {
				setFailure({ draft: submitted, issues: cause.details.map((issue) => String(issue)), message: cause.message });
			} else {
				setFailure({ draft: submitted, issues: null, message: cause instanceof Error ? cause.message : String(cause) });
			}
			setResult(null);
		} finally {
			setBusy(false);
		}
	}, [bindingId, draft]);

	const currentResult = result && result.draft !== draft ? null : result;
	const currentFailure = failure && failure.draft !== draft ? null : failure;
	const save = useCallback(async () => {
		if (!currentResult || currentResult.value.changes.length === 0 || (currentResult.value.affectedFiles.length > 0 && !acknowledged)) return;
		setSaving(true);
		setFailure(null);
		try {
			await saveKnowledgeSchema(bindingId, JSON.parse(draft) as KnowledgeSchemaPreset, currentHash, currentResult.value.affectedFiles, acknowledged);
			onSaved();
		} catch (cause) {
			if (cause instanceof KnowledgeApiError && cause.code === "schema_invalid" && Array.isArray(cause.details)) {
				setFailure({ draft, issues: cause.details.map(String), message: cause.message });
			} else {
				setFailure({ draft, issues: null, message: cause instanceof Error ? cause.message : String(cause) });
			}
		} finally {
			setSaving(false);
		}
	}, [acknowledged, bindingId, currentHash, currentResult, draft, onSaved]);

	return (
		<section className="mt-6 rounded-lg border border-border bg-card p-4">
			<h3 className="text-sm font-medium">编辑实体与关系</h3>
			<p className="knowledge-banner is-warning mt-3" role="status">
				<AlertTriangleIcon size={14} />
				<span>先预览影响，再保存根目录的 wiki.schema.json。保存不会改动 wiki/ 或 raw/；受影响笔记需明确确认。</span>
			</p>
			<div className="mt-4"><KnowledgeSchemaEditor draft={draft} onChange={(value) => { setDraft(value); setAcknowledged(false); }} /></div>
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<button
					type="button"
					onClick={() => void runPreview()}
					disabled={busy || saving || !draft.trim()}
					className="flex items-center gap-1.5 rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
				>
					{busy ? <Loader2Icon size={14} className="animate-spin" /> : <EyeIcon size={14} />}
					{busy ? "正在预览…" : "预览影响"}
				</button>
				<button
					type="button"
					onClick={() => { setDraft(JSON.stringify(current, null, 2)); setResult(null); setFailure(null); setAcknowledged(false); }}
					disabled={busy || saving}
					className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
				>
					<RotateCcwIcon size={14} />重置为当前结构
				</button>
				<button type="button" onClick={onCancel} disabled={busy || saving} className="ml-auto rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50">取消</button>
				<button type="button" onClick={() => void save()} disabled={busy || saving || !currentResult || currentResult.value.changes.length === 0 || (currentResult.value.affectedFiles.length > 0 && !acknowledged)}
					className="flex items-center gap-1.5 rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50">
					{saving ? <Loader2Icon size={14} className="animate-spin" /> : <SaveIcon size={14} />}
					{saving ? "正在保存…" : "保存结构"}
				</button>
			</div>

			{currentFailure ? (
				<div className="knowledge-banner is-error mt-4" role="alert">
					<AlertTriangleIcon size={14} />
					<span>
						{currentFailure.message}
						{currentFailure.issues ? (
							<span className="mt-1 block">
								{currentFailure.issues.map((issue) => <code key={issue} className="block">{issue}</code>)}
							</span>
						) : null}
					</span>
				</div>
			) : null}

			{currentResult ? (
				<div className="mt-4">
					<h4 className="text-sm font-medium">结构变更 · {currentResult.value.changes.length} 项</h4>
					{currentResult.value.changes.length === 0 ? (
						<p className="mt-2 text-sm text-muted-foreground">与当前生效结构没有差异。</p>
					) : (
						<ul className="mt-2 space-y-1">
							{currentResult.value.changes.map((change, index) => (
								<li key={`${change.kind}-${changeSubject(change)}-${index}`} className="flex flex-wrap items-baseline gap-x-2 rounded border border-border bg-background px-3 py-1.5 text-xs">
									<span className="font-medium">{CHANGE_KIND_LABELS[change.kind]}</span>
									<code>{changeSubject(change)}</code>
									{(change.from !== undefined || change.to !== undefined) ? (
										<code className="break-all text-muted-foreground">
											{formatShape(change.from)} → {formatShape(change.to)}
										</code>
									) : null}
								</li>
							))}
						</ul>
					)}

					<h4 className="mt-4 text-sm font-medium">受影响笔记（已同步内容）· {currentResult.value.affectedFiles.length} 篇</h4>
					{currentResult.value.affectedFiles.length === 0 ? (
						<p className="mt-2 text-sm text-muted-foreground">没有已同步笔记受这次变更影响。</p>
					) : (
						<div className="mt-2 overflow-x-auto rounded-lg border border-border">
							<table className="w-full text-left text-xs">
								<thead>
									<tr className="border-b border-border bg-muted text-muted-foreground">
										<th className="px-3 py-2 font-medium">笔记路径</th>
										<th className="px-3 py-2 font-medium">实体</th>
										<th className="px-3 py-2 font-medium">原因</th>
									</tr>
								</thead>
								<tbody>
									{currentResult.value.affectedFiles.map((file) => (
										<tr key={file.path} className="border-b border-border last:border-0">
											<td className="px-3 py-2"><code className="break-all">{file.path}</code></td>
											<td className="px-3 py-2"><code>{file.entity}</code></td>
											<td className="px-3 py-2 text-muted-foreground">{file.reasons.map(affectedReasonLabel).join("；")}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
					<p className="mt-3 text-xs text-muted-foreground">
						{currentResult.value.note}
						{currentResult.value.unknownFieldsPreserved ? "；笔记中未在结构里声明的字段会原样保留。" : ""}
					</p>
					{currentResult.value.affectedFiles.length > 0 ? (
						<label className="mt-3 flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50/60 p-3 text-sm dark:bg-amber-950/20">
							<input type="checkbox" className="mt-1" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
							<span>我已查看以上 {currentResult.value.affectedFiles.length} 篇受影响笔记，确认保存结构声明。</span>
						</label>
					) : null}
				</div>
			) : null}
		</section>
	);
}
