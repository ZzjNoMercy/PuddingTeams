"use client";

import { useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import type { KnowledgeSchemaField, KnowledgeSchemaFieldType, KnowledgeSchemaPreset, KnowledgeSchemaRelation } from "@/lib/api";
import { FIELD_TYPE_LABELS } from "./schema-view";

const inputClass = "min-w-0 rounded-lg border border-border bg-background px-2.5 py-2 text-sm outline-none focus-visible:border-primary";
const smallButtonClass = "inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:bg-muted";
const FIELD_TYPES = Object.keys(FIELD_TYPE_LABELS) as KnowledgeSchemaFieldType[];

function relationEndpoints(relation: KnowledgeSchemaRelation): Array<{ from: string; to: string }> {
	return relation.endpoints ?? [{ from: relation.from ?? "", to: relation.to ?? "" }];
}

export function KnowledgeSchemaEditor({ draft, onChange }: { draft: string; onChange: (value: string) => void }) {
	const [tab, setTab] = useState<"entities" | "relations" | "json">("entities");
	let schema: KnowledgeSchemaPreset | null = null;
	try {
		const parsed: unknown = JSON.parse(draft);
		if (parsed && typeof parsed === "object" && Array.isArray((parsed as KnowledgeSchemaPreset).entities) && Array.isArray((parsed as KnowledgeSchemaPreset).relations)
			&& (parsed as KnowledgeSchemaPreset).entities.every((entity) => entity && typeof entity === "object" && Array.isArray(entity.fields) && entity.fields.every((field) => field && typeof field === "object"))
			&& (parsed as KnowledgeSchemaPreset).relations.every((relation) => relation && typeof relation === "object" && (!relation.endpoints || (Array.isArray(relation.endpoints) && relation.endpoints.every((endpoint) => endpoint && typeof endpoint === "object"))))) {
			schema = parsed as KnowledgeSchemaPreset;
		}
	} catch { /* Keep invalid JSON available for repair in the advanced tab. */ }
	const current = schema;
	const update = (change: (next: KnowledgeSchemaPreset) => void) => {
		if (!current) return;
		const next = structuredClone(current);
		change(next);
		onChange(JSON.stringify(next, null, 2));
	};
	const types = current?.entities.map((entity) => entity.type).filter(Boolean) ?? [];

	return (
		<div>
			<div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="结构编辑方式">
				{([ ["entities", "实体与字段"], ["relations", "关系"], ["json", "高级 JSON"] ] as const).map(([id, label]) => (
					<button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
						className="rounded-md px-3 py-1.5 text-sm data-[active=true]:bg-background data-[active=true]:text-foreground data-[active=true]:shadow-sm"
						data-active={tab === id}>{label}</button>
				))}
			</div>
			{!current && tab !== "json" ? (
				<p role="alert" className="mt-3 text-sm text-destructive">JSON 草稿无效，请到「高级 JSON」修正后继续编辑。</p>
			) : null}
			{tab === "entities" && current ? (
				<div className="mt-4 space-y-4">
					<p className="text-xs text-muted-foreground">实体类型对应 Wiki 页面类型；修改目录会影响现有笔记路径。字段名与类型按页面 frontmatter 校验。</p>
					{current.entities.map((entity, entityIndex) => (
						<section key={entityIndex} className="rounded-xl border border-border bg-background p-4">
							<div className="flex flex-wrap items-end gap-3">
								<label className="flex min-w-44 flex-1 flex-col gap-1 text-xs text-muted-foreground">实体类型
									<input className={inputClass} value={entity.type} onChange={(event) => {
										const value = event.target.value;
										update((next) => {
											const previous = next.entities[entityIndex]!.type;
											next.entities[entityIndex]!.type = value;
											for (const relation of next.relations) {
												if (relation.from === previous) relation.from = value;
												if (relation.to === previous) relation.to = value;
												for (const endpoint of relation.endpoints ?? []) {
													if (endpoint.from === previous) endpoint.from = value;
													if (endpoint.to === previous) endpoint.to = value;
												}
											}
										});
									}} aria-label={`实体 ${entityIndex + 1} 类型`} />
								</label>
								<label className="flex min-w-44 flex-1 flex-col gap-1 text-xs text-muted-foreground">目录
									<input className={inputClass} value={entity.directory} onChange={(event) => update((next) => { next.entities[entityIndex]!.directory = event.target.value; })} aria-label={`实体 ${entityIndex + 1} 目录`} />
								</label>
								<button type="button" className={smallButtonClass} onClick={() => update((next) => { next.entities.splice(entityIndex, 1); })} aria-label={`移除实体 ${entity.type}`}><Trash2Icon size={13} />移除实体</button>
							</div>
							<div className="mt-4 space-y-2 border-t border-border pt-3">
								<p className="text-xs font-medium">字段</p>
								{entity.fields.map((field, fieldIndex) => (
									<div key={fieldIndex} className="rounded-lg border border-border/70 p-2.5">
										<div className="flex flex-wrap items-center gap-2">
											<input className={`${inputClass} w-40`} value={field.name} aria-label={`${entity.type} 字段 ${fieldIndex + 1} 名称`}
												onChange={(event) => update((next) => { next.entities[entityIndex]!.fields[fieldIndex]!.name = event.target.value; })} />
											<select className={inputClass} value={field.type} aria-label={`${field.name} 字段类型`} onChange={(event) => update((next) => {
												const target = next.entities[entityIndex]!.fields[fieldIndex]!;
												target.type = event.target.value as KnowledgeSchemaFieldType;
												if (target.type === "enum") target.values ??= ["option"];
												else delete target.values;
											})}>
												{FIELD_TYPES.map((type) => <option key={type} value={type}>{FIELD_TYPE_LABELS[type]}</option>)}
											</select>
											<label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={field.required} onChange={(event) => update((next) => { next.entities[entityIndex]!.fields[fieldIndex]!.required = event.target.checked; })} />必填</label>
											<button type="button" className={`${smallButtonClass} ml-auto`} onClick={() => update((next) => { next.entities[entityIndex]!.fields.splice(fieldIndex, 1); })} aria-label={`移除字段 ${field.name}`}><Trash2Icon size={13} />移除</button>
										</div>
										{field.type === "enum" ? <label className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">枚举值（逗号分隔）
											<input className={inputClass} value={field.values?.join(", ") ?? ""} onChange={(event) => update((next) => { next.entities[entityIndex]!.fields[fieldIndex]!.values = event.target.value.split(",").map((value) => value.trim()).filter(Boolean); })} />
										</label> : null}
										<details className="mt-2 text-xs text-muted-foreground">
											<summary className="cursor-pointer">佐证字段{field.requiresSourceField ? `：${field.requiresSourceField}` : "（可选）"}</summary>
											<label className="mt-2 flex flex-col gap-1">需要佐证来源的字段
												<input className={inputClass} value={field.requiresSourceField ?? ""} placeholder="例如 sources" onChange={(event) => update((next) => {
													const target = next.entities[entityIndex]!.fields[fieldIndex]!;
													if (event.target.value) target.requiresSourceField = event.target.value;
													else delete target.requiresSourceField;
												})} />
											</label>
										</details>
									</div>
								))}
								<button type="button" className={smallButtonClass} onClick={() => update((next) => { next.entities[entityIndex]!.fields.push({ name: "", type: "text", required: false } satisfies KnowledgeSchemaField); })}><PlusIcon size={13} />添加字段</button>
							</div>
						</section>
					))}
					<button type="button" className={smallButtonClass} onClick={() => update((next) => { next.entities.push({ type: "", directory: "", fields: [{ name: "type", type: "text", required: true }, { name: "title", type: "text", required: true }] }); })}><PlusIcon size={13} />添加实体</button>
				</div>
			) : null}
			{tab === "relations" && current ? (
				<div className="mt-4 space-y-3">
					<p className="text-xs text-muted-foreground">每种关系可声明一组或多组明确的「起点 → 终点」实体类型；保存时检查类型是否存在且配对不重复。</p>
					{current.relations.map((relation, relationIndex) => (
						<section key={relationIndex} className="rounded-xl border border-border bg-background p-4">
							<div className="flex flex-wrap items-end gap-2">
								<label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground">关系名称
									<input className={inputClass} value={relation.type} aria-label={`关系 ${relationIndex + 1} 名称`} onChange={(event) => update((next) => { next.relations[relationIndex]!.type = event.target.value; })} />
								</label>
								<label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground">反向名称（可选）
									<input className={inputClass} value={relation.inverseName ?? ""} onChange={(event) => update((next) => {
										if (event.target.value) next.relations[relationIndex]!.inverseName = event.target.value;
										else delete next.relations[relationIndex]!.inverseName;
									})} />
								</label>
								<label className="flex items-center gap-1 pb-2 text-xs"><input type="checkbox" checked={relation.requiresEvidence} onChange={(event) => update((next) => { next.relations[relationIndex]!.requiresEvidence = event.target.checked; })} />需要证据</label>
								<button type="button" className={smallButtonClass} onClick={() => update((next) => { next.relations.splice(relationIndex, 1); })} aria-label={`移除关系 ${relation.type}`}><Trash2Icon size={13} />移除关系</button>
							</div>
							<div className="mt-3 space-y-2 border-t border-border pt-3">
								{relationEndpoints(relation).map((endpoint, endpointIndex) => (
									<div key={endpointIndex} className="flex flex-wrap items-center gap-2">
										<select className={`${inputClass} min-w-40 flex-1`} value={endpoint.from} aria-label={`${relation.type} 配对 ${endpointIndex + 1} 起点`} onChange={(event) => update((next) => {
											const target = next.relations[relationIndex]!;
											target.endpoints = relationEndpoints(target).map((item) => ({ ...item })); delete target.from; delete target.to;
											target.endpoints[endpointIndex]!.from = event.target.value;
										})}>{types.map((type) => <option key={type} value={type}>{type}</option>)}</select>
										<span className="text-muted-foreground">→</span>
										<select className={`${inputClass} min-w-40 flex-1`} value={endpoint.to} aria-label={`${relation.type} 配对 ${endpointIndex + 1} 终点`} onChange={(event) => update((next) => {
											const target = next.relations[relationIndex]!;
											target.endpoints = relationEndpoints(target).map((item) => ({ ...item })); delete target.from; delete target.to;
											target.endpoints[endpointIndex]!.to = event.target.value;
										})}>{types.map((type) => <option key={type} value={type}>{type}</option>)}</select>
										<button type="button" className={smallButtonClass} onClick={() => update((next) => {
											const target = next.relations[relationIndex]!;
											target.endpoints = relationEndpoints(target).filter((_, index) => index !== endpointIndex); delete target.from; delete target.to;
										})} aria-label={`移除 ${relation.type} 配对 ${endpointIndex + 1}`}><Trash2Icon size={13} /></button>
									</div>
								))}
								<button type="button" className={smallButtonClass} disabled={!types.length} onClick={() => update((next) => {
									const target = next.relations[relationIndex]!;
									target.endpoints = [...relationEndpoints(target), { from: types[0]!, to: types[0]! }]; delete target.from; delete target.to;
								})}><PlusIcon size={13} />添加配对</button>
							</div>
						</section>
					))}
					<button type="button" className={smallButtonClass} disabled={!types.length} onClick={() => update((next) => { next.relations.push({ type: "", from: types[0]!, to: types[0]!, requiresEvidence: true }); })}><PlusIcon size={13} />添加关系</button>
				</div>
			) : null}
			{tab === "json" ? (
				<div className="mt-3">
					<p className="mb-2 text-xs text-muted-foreground">高级模式直接编辑完整声明；JSON 无效时表单暂停编辑，草稿不会丢失。</p>
					<textarea aria-label="结构声明 JSON 草稿" className="knowledge-json-input" spellCheck={false} value={draft} onChange={(event) => onChange(event.target.value)} />
				</div>
			) : null}
		</div>
	);
}
