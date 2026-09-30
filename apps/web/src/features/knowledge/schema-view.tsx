"use client";

import { useState } from "react";
import { FileTextIcon, Link2Icon } from "lucide-react";
import type { KnowledgeSchemaFieldType, KnowledgeSchemaPreset } from "@/lib/api";

/** 结构声明只读视图（UI046/047/048）：实体清单、关系清单、声明 JSON 三个页签。 */

export const FIELD_TYPE_LABELS: Record<KnowledgeSchemaFieldType, string> = {
	text: "文本",
	date: "日期",
	datetime: "日期时间",
	text_list: "文本列表",
	source_refs: "来源引用",
	note_refs: "笔记引用",
	enum: "枚举",
};

type SchemaTab = "entities" | "relations" | "document";

const SCHEMA_TABS: Array<{ id: SchemaTab; label: string }> = [
	{ id: "entities", label: "实体清单" },
	{ id: "relations", label: "关系清单" },
	{ id: "document", label: "结构 JSON" },
];

export function KnowledgeSchemaView({ schema }: { schema: KnowledgeSchemaPreset }) {
	const [tab, setTab] = useState<SchemaTab>("entities");

	return (
		<div>
			<div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
				{SCHEMA_TABS.map((item) => (
					<button
						key={item.id}
						type="button"
						className="knowledge-version-tab"
						data-active={tab === item.id}
						onClick={() => setTab(item.id)}
					>
						{item.label}
					</button>
				))}
				<span className="ml-auto px-2 text-xs text-muted-foreground">
					{schema.entities.length} 类实体 · {schema.relations.length} 种关系
				</span>
			</div>

			{tab === "entities" ? (
				<div className="mt-4 grid gap-3 lg:grid-cols-2">
					{schema.entities.map((entity) => (
						<section key={entity.type} className="rounded-lg border border-border bg-card p-3">
							<header className="flex items-center gap-2">
								<FileTextIcon size={14} className="shrink-0 text-muted-foreground" />
								<code className="text-sm font-medium">{entity.type}</code>
								<span className="text-xs text-muted-foreground">{entity.directory}/</span>
								<span className="ml-auto shrink-0 text-xs text-muted-foreground">{entity.fields.length} 个字段</span>
							</header>
							<ul className="mt-2 space-y-1 border-t border-border pt-2">
								{entity.fields.map((field) => (
									<li key={field.name} className="flex flex-wrap items-baseline gap-x-2 text-xs">
										<code className="font-medium">{field.name}</code>
										<span className="text-muted-foreground">
											{FIELD_TYPE_LABELS[field.type] ?? field.type}
											{field.values ? `（${field.values.join(" / ")}）` : ""}
										</span>
										<span className={field.required ? "text-foreground" : "text-muted-foreground"}>
											{field.required ? "必填" : "可选"}
										</span>
										{field.requiresSourceField ? (
											<span className="text-muted-foreground">需佐证来源字段 {field.requiresSourceField}</span>
										) : null}
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
			) : null}

			{tab === "relations" ? (
				schema.relations.length === 0 ? (
					<p className="mt-4 text-sm text-muted-foreground">这套结构没有声明关系。</p>
				) : (
					<ul className="mt-4 space-y-2">
						{schema.relations.map((relation) => (
							<li key={relation.type} className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm">
								<Link2Icon size={14} className="shrink-0 text-muted-foreground" />
								<code className="font-medium">{relation.type}</code>
							<span className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
								{(relation.endpoints ?? [{ from: relation.from, to: relation.to }]).map((endpoint) => (
									<span key={`${endpoint.from}-${endpoint.to}`}>{endpoint.from} → {endpoint.to}</span>
								))}
							</span>
								{relation.inverseName ? (
									<span className="text-xs text-muted-foreground">反向：{relation.inverseName}</span>
								) : null}
							</li>
						))}
					</ul>
				)
			) : null}

			{tab === "document" ? (
				<div className="mt-4">
					<p className="mb-2 text-xs text-muted-foreground">结构文件内容（teams-schema v{schema.formatVersion} · {schema.schemaId}@{schema.revision}），只读。</p>
					<pre className="knowledge-json">{JSON.stringify(schema, null, 2)}</pre>
				</div>
			) : null}
		</div>
	);
}
