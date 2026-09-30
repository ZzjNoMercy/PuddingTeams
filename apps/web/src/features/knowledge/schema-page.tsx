"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
	AlertTriangleIcon,
	BookOpenIcon,
	CheckCircle2Icon,
	CircleAlertIcon,
	LayersIcon,
	Loader2Icon,
	PencilIcon,
} from "lucide-react";
import {
	getKnowledgeSchema,
	listKnowledgeBindings,
	listKnowledgePresets,
	type KnowledgeBindingSummary,
	type KnowledgeEffectiveSchema,
	type KnowledgeSchemaPresetSummary,
} from "@/lib/api";
import { KnowledgeSchemaView } from "./schema-view";
import { KnowledgeSchemaImpactPanel } from "./schema-impact";
import { KnowledgePageShell } from "./page-shell";

/**
 * 结构页 /knowledge/schema：?vault=<id> 看库生效结构（UI049/050），?preset=<id> 看内置预置
 * （UI046–048），都不传 → 预置清单 + 库选择。
 */

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function SchemaPageShell({ children, title, back }: { children: React.ReactNode; title: string; back?: { href: string; label: string } }) {
	return (
		<KnowledgePageShell title={title} back={back ?? { href: "/knowledge", label: "返回知识库" }} layout="centered">{children}</KnowledgePageShell>
	);
}

export function KnowledgeSchemaPage() {
	const params = useSearchParams();
	const vaultId = params.get("vault");
	const presetId = params.get("preset");

	const [presetsNonce, setPresetsNonce] = useState(0);
	const [presetsState, setPresetsState] = useState<{ key: number; value: KnowledgeSchemaPresetSummary[] | null; error: string | null } | null>(null);
	const [bindingsNonce, setBindingsNonce] = useState(0);
	const [bindingsState, setBindingsState] = useState<{ key: number; value: KnowledgeBindingSummary[] | null; error: string | null } | null>(null);
	const [schemaNonce, setSchemaNonce] = useState(0);
	const [editingVaultId, setEditingVaultId] = useState<string | null>(null);
	const [schemaState, setSchemaState] = useState<{ key: string; value: KnowledgeEffectiveSchema | null; error: string | null; notFound: boolean } | null>(null);

	useEffect(() => {
		let active = true;
		void listKnowledgePresets()
			.then((value) => { if (active) setPresetsState({ key: presetsNonce, value, error: null }); })
			.catch((cause) => { if (active) setPresetsState({ key: presetsNonce, value: null, error: errorMessage(cause) }); });
		return () => { active = false; };
	}, [presetsNonce]);

	useEffect(() => {
		let active = true;
		void listKnowledgeBindings()
			.then((value) => { if (active) setBindingsState({ key: bindingsNonce, value, error: null }); })
			.catch((cause) => { if (active) setBindingsState({ key: bindingsNonce, value: null, error: errorMessage(cause) }); });
		return () => { active = false; };
	}, [bindingsNonce]);

	useEffect(() => {
		if (!vaultId) return;
		const key = `${vaultId} ${schemaNonce}`;
		let active = true;
		void getKnowledgeSchema(vaultId)
			.then((value) => { if (active) setSchemaState({ key, value, error: null, notFound: false }); })
			.catch((cause) => {
				if (!active) return;
				const status = typeof (cause as { status?: unknown }).status === "number" ? (cause as { status: number }).status : 0;
				setSchemaState({ key, value: null, error: errorMessage(cause), notFound: status === 404 });
			});
		return () => { active = false; };
	}, [vaultId, schemaNonce]);

	const presets = presetsState && presetsState.key === presetsNonce ? presetsState.value : null;
	const presetsError = presetsState && presetsState.key === presetsNonce ? presetsState.error : null;
	const bindings = bindingsState && bindingsState.key === bindingsNonce ? bindingsState.value : null;
	const bindingsError = bindingsState && bindingsState.key === bindingsNonce ? bindingsState.error : null;

	// ---- 库视图（UI049 + UI050 影响预览）----
	if (vaultId) {
		const editing = editingVaultId === vaultId;
		const schemaKey = `${vaultId} ${schemaNonce}`;
		const schema = schemaState && schemaState.key === schemaKey ? schemaState.value : null;
		const schemaError = schemaState && schemaState.key === schemaKey ? schemaState.error : null;
		const schemaNotFound = schemaState && schemaState.key === schemaKey ? schemaState.notFound : false;
		const vault = bindings?.find((item) => item.id === vaultId) ?? null;

		return (
			<SchemaPageShell
				title={vault ? `结构 · ${vault.name}` : "知识库结构"}
				back={{ href: `/knowledge?vault=${encodeURIComponent(vaultId)}`, label: vault ? `返回 ${vault.name}` : "返回知识库" }}
			>
				{!schema && !schemaError ? (
					<p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2Icon size={14} className="animate-spin" />正在加载结构…</p>
				) : schemaError ? (
					<div>
						<p role="alert" className="text-sm text-destructive">
							{schemaNotFound ? "知识库不存在或已移除。" : schemaError}
						</p>
						{!schemaNotFound ? (
							<button type="button" onClick={() => setSchemaNonce((value) => value + 1)} className="mt-2 text-sm underline">重试</button>
						) : null}
					</div>
				) : schema ? (
					<>
						<section className="rounded-xl border border-border bg-card p-4">
							<div className="flex flex-wrap items-start justify-between gap-3">
								<div className="min-w-0">
									<p className="text-xs text-muted-foreground">当前结构</p>
									<h2 className="mt-1 flex items-center gap-2 text-lg font-medium">
										{schema.schema ? <CheckCircle2Icon size={17} className="shrink-0 text-primary" aria-hidden="true" /> : <CircleAlertIcon size={17} className="shrink-0 text-muted-foreground" aria-hidden="true" />}
										{schema.schema?.name ?? "暂无可用结构"}
									</h2>
								</div>
								{schema.schema && schema.schemaRef ? (
									<button type="button" onClick={() => setEditingVaultId(editing ? null : vaultId)} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted">
										<PencilIcon size={14} />{editing ? "结束编辑" : "编辑实体与关系"}
									</button>
								) : null}
							</div>
							{schema.schema ? (
								<>
									<p className="mt-2 text-sm text-muted-foreground">{schema.schema.entities.length} 类实体 · {schema.schema.relations.length} 种关系 · 结构文件：<code>wiki.schema.json</code></p>
									<details className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
										<summary className="w-fit cursor-pointer hover:text-foreground">技术详情</summary>
										<div className="mt-2 space-y-1">
											<p>结构 ID：<code>{schema.schema.schemaId}</code> · 版本：{schema.schema.revision}</p>
											{schema.schemaRef?.originPresetId ? <p>来源预置：{schema.schemaRef.originPresetId}</p> : null}
											{schema.schemaRef ? <p>校验哈希：<code className="break-all">{schema.schemaRef.hash}</code></p> : null}
										</div>
									</details>
								</>
							) : (
								<p className="mt-2 text-sm text-muted-foreground">知识库根目录没有可用的结构文件 <code>wiki.schema.json</code>；Markdown 仍可阅读和搜索。</p>
							)}
						</section>

						{schema.warnings.length > 0 ? (
							<div className="knowledge-banner is-warning mt-4" role="status">
								<AlertTriangleIcon size={14} />
								<span>
									{schema.warnings.map((warning) => <span key={warning} className="block">{warning}</span>)}
								</span>
							</div>
						) : null}

						{schema.origin === "none" || !schema.schema ? (
							<div className="mt-4 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
								<p className="flex items-start gap-2">
									<CircleAlertIcon size={15} className="mt-0.5 shrink-0" />
									<span>
										添加或修正根目录的 wiki.schema.json 后，就可以按结构检查笔记并预览结构变更。
									</span>
								</p>
							</div>
						) : (
							<>
								{editing && schema.schemaRef ? (
									<KnowledgeSchemaImpactPanel bindingId={vaultId} current={schema.schema} currentHash={schema.schemaRef.hash}
										onCancel={() => setEditingVaultId(null)} onSaved={() => { setEditingVaultId(null); setSchemaNonce((value) => value + 1); }} />
								) : (
									<div className="mt-6"><KnowledgeSchemaView schema={schema.schema} /></div>
								)}
							</>
						)}
					</>
				) : null}
			</SchemaPageShell>
		);
	}

	// ---- 预置视图（UI046/047/048）----
	if (presetId) {
		const preset = presets?.find((item) => item.schemaId === presetId) ?? null;
		return (
			<SchemaPageShell title={preset ? `内置结构预置 · ${preset.name}` : "内置结构预置"} back={{ href: "/knowledge/schema", label: "结构" }}>
				{!presets && !presetsError ? (
					<p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2Icon size={14} className="animate-spin" />正在加载预置…</p>
				) : presetsError ? (
					<p role="alert" className="text-sm text-destructive">
						{presetsError}{" "}
						<button type="button" onClick={() => setPresetsNonce((value) => value + 1)} className="underline">重试</button>
					</p>
				) : !preset ? (
					<p role="alert" className="text-sm text-destructive">预置 {presetId} 不存在。</p>
				) : (
					<>
						<div className="flex flex-wrap gap-2">
							{(presets ?? []).map((item) => (
								<Link
									key={item.schemaId}
									href={`/knowledge/schema?preset=${encodeURIComponent(item.schemaId)}`}
									className="knowledge-version-tab"
									data-active={item.schemaId === preset.schemaId}
								>
									{item.name}
								</Link>
							))}
						</div>
						<div className="mt-4 flex flex-wrap items-center gap-2">
							<span className="rounded-full bg-accent px-2.5 py-0.5 text-xs font-medium text-accent-foreground">系统内置 · 只读</span>
							<span className="text-xs text-muted-foreground">{preset.schemaId}@{preset.revision} · hash {preset.hash.slice(0, 12)}</span>
						</div>
						<p className="mt-2 text-sm text-muted-foreground">
							预置在产品端只读；新建知识库时选用后会成为该库的独立副本，预置的后续变化不会自动影响已接入的库。
						</p>
						<div className="mt-6">
							<KnowledgeSchemaView schema={preset} />
						</div>
					</>
				)}
			</SchemaPageShell>
		);
	}

	// ---- 入口：预置清单 + 库选择 ----
	return (
		<SchemaPageShell title="资料结构">
			<section>
				<h2 className="flex items-center gap-2 text-sm font-medium"><LayersIcon size={15} />内置结构预置</h2>
				<p className="mt-1 text-xs text-muted-foreground">四套内置结构只读可查看；在接入新知识库时选用。</p>
				{!presets && !presetsError ? (
					<p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Loader2Icon size={14} className="animate-spin" />正在加载…</p>
				) : presetsError ? (
					<p role="alert" className="mt-3 text-sm text-destructive">
						{presetsError}{" "}
						<button type="button" onClick={() => setPresetsNonce((value) => value + 1)} className="underline">重试</button>
					</p>
				) : (
					<div className="mt-3 grid gap-3 sm:grid-cols-2">
						{(presets ?? []).map((preset) => (
							<Link
								key={preset.schemaId}
								href={`/knowledge/schema?preset=${encodeURIComponent(preset.schemaId)}`}
								className="rounded-lg border border-border bg-card p-4 hover:border-primary/50"
							>
								<p className="text-sm font-medium">{preset.name}</p>
								<p className="mt-1 text-xs text-muted-foreground">
									{preset.entities.length} 类实体 · {preset.relations.length} 种关系
								</p>
								<p className="mt-1 text-xs text-muted-foreground">
									{preset.entities.map((entity) => `${entity.type}（${entity.directory}/）`).join("、")}
								</p>
							</Link>
						))}
					</div>
				)}
			</section>

			<section className="mt-8">
				<h2 className="flex items-center gap-2 text-sm font-medium"><BookOpenIcon size={15} />我的知识库</h2>
				<p className="mt-1 text-xs text-muted-foreground">查看某个已接入知识库当前生效的结构，并预览变更影响。</p>
				{!bindings && !bindingsError ? (
					<p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Loader2Icon size={14} className="animate-spin" />正在加载…</p>
				) : bindingsError ? (
					<p role="alert" className="mt-3 text-sm text-destructive">
						{bindingsError}{" "}
						<button type="button" onClick={() => setBindingsNonce((value) => value + 1)} className="underline">重试</button>
					</p>
				) : bindings && bindings.length === 0 ? (
					<p className="mt-3 text-sm text-muted-foreground">
						尚未接入知识库。<Link href="/knowledge/connect" className="underline">接入一个</Link>
					</p>
				) : (
					<div className="mt-3 grid gap-3 sm:grid-cols-2">
						{(bindings ?? []).map((binding) => (
							<Link
								key={binding.id}
								href={`/knowledge/schema?vault=${encodeURIComponent(binding.id)}`}
								className="rounded-lg border border-border bg-card p-4 hover:border-primary/50"
							>
								<p className="text-sm font-medium">{binding.name}</p>
								<p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{binding.description}</p>
							</Link>
						))}
					</div>
				)}
			</section>
		</SchemaPageShell>
	);
}
