"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
	AlertTriangleIcon,
	ArrowLeftIcon,
	CheckCircle2Icon,
	CheckIcon,
	ChevronRightIcon,
	CircleAlertIcon,
	FilePlus2Icon,
	FileTextIcon,
	FolderOpenIcon,
	FolderPlusIcon,
	FolderSearchIcon,
	Loader2Icon,
	MinusIcon,
	ShieldCheckIcon,
} from "lucide-react";
import {
	applyKnowledgePlan,
	createKnowledgePlan,
	createKnowledgeProbe,
	getKnowledgeObservations,
	getKnowledgePlan,
	listKnowledgePresets,
	pickWorkspaceDirectory,
	scanKnowledgeBinding,
	KnowledgeApiError,
	type KnowledgeApplyReceipt,
	type KnowledgeBindingSummary,
	type KnowledgeObservations,
	type KnowledgePlan,
	type KnowledgeProbeRecord,
	type KnowledgeSchemaPresetSummary,
} from "@/lib/api";
import { getDesktopBridge } from "@/lib/desktop";

/**
 * 接入向导 /knowledge/connect：选择目录 → 检查结果 → 名称与结构 → 计划预览 → 同步完成。
 * 全程不丢已填内容；?plan=<planId> 深链恢复到计划预览步。
 */

type WizardStep = "path" | "probe" | "details" | "plan" | "sync";

const WIZARD_STEPS: Array<{ id: WizardStep; label: string }> = [
	{ id: "path", label: "选择目录" },
	{ id: "probe", label: "检查结果" },
	{ id: "details", label: "名称与结构" },
	{ id: "plan", label: "计划预览" },
	{ id: "sync", label: "目录同步" },
];

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/** probe 失败按 status/code 分级：不存在 / 相对路径 / 不是目录 / 无权限 分别给标题；不存在时允许转入创建流程。 */
function probeErrorInfo(cause: unknown): { title: string; detail: string; canCreate?: boolean } {
	if (cause instanceof KnowledgeApiError) {
		if (cause.status === 404) return { title: "目录不存在", detail: "请核对路径拼写，或确认对应磁盘与挂载卷已连接。", canCreate: true };
		if (cause.code === "invalid_path") {
			const detail = cause.message;
			const title = detail.includes("绝对路径") ? "需要绝对路径"
				: detail.includes("父目录不存在") ? "父目录不存在"
				: detail.includes("不是目录") ? "目标不是目录"
				: detail.includes("无写入权限") ? "父目录无写入权限"
				: detail.includes("权限") || detail.includes("无法访问") ? "目录无法访问"
				: "路径不可用";
			return { title, detail };
		}
		return { title: "检查失败", detail: cause.message };
	}
	return { title: "检查失败", detail: errorMessage(cause) };
}

function StepsBar({ step }: { step: WizardStep }) {
	const currentIndex = WIZARD_STEPS.findIndex((item) => item.id === step);
	return (
		<ol className="knowledge-steps" aria-label="接入步骤">
			{WIZARD_STEPS.map((item, index) => {
				const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "todo";
				return (
					<li key={item.id} className="knowledge-step" data-state={state} aria-current={state === "current" ? "step" : undefined}>
						<span className="knowledge-step-index">{state === "done" ? <CheckIcon size={11} /> : index + 1}</span>
						{item.label}
					</li>
				);
			})}
		</ol>
	);
}

function MarkerRow({ ok, label }: { ok: boolean; label: string }) {
	return (
		<div className="flex items-center gap-2 text-sm">
			{ok
				? <CheckCircle2Icon size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
				: <MinusIcon size={14} className="shrink-0 text-muted-foreground" />}
			<span className={ok ? "" : "text-muted-foreground"}>{label}</span>
		</div>
	);
}

function ReceiptList({ receipts }: { receipts: KnowledgeApplyReceipt[] }) {
	return (
		<ul className="space-y-1">
			{receipts.map((receipt) => (
				<li key={receipt.relativePath} className="flex items-center gap-2 text-xs">
					{receipt.status === "created" ? (
						<>
							<CheckCircle2Icon size={13} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
							<code className="min-w-0 flex-1 truncate">{receipt.relativePath}</code>
							<span className="shrink-0 text-muted-foreground">已创建</span>
						</>
					) : receipt.status === "skipped_exists" ? (
						<>
							<MinusIcon size={13} className="shrink-0 text-muted-foreground" />
							<code className="min-w-0 flex-1 truncate">{receipt.relativePath}</code>
							<span className="knowledge-status-badge shrink-0">已存在 · 未覆盖</span>
						</>
					) : (
						<>
							<CircleAlertIcon size={13} className="shrink-0 text-destructive" />
							<code className="min-w-0 flex-1 truncate">{receipt.relativePath}</code>
							<span className="shrink-0 text-destructive">失败{receipt.error ? `：${receipt.error}` : ""}</span>
						</>
					)}
				</li>
			))}
		</ul>
	);
}

interface ApplyFailure {
	message: string;
	code?: string;
	receipts?: KnowledgeApplyReceipt[];
}

export function KnowledgeConnectWizard() {
	const planParam = useSearchParams().get("plan");

	const [step, setStep] = useState<WizardStep>("path");
	const [notice, setNotice] = useState<string | null>(null);
	const [pathInput, setPathInput] = useState("");
	const hasDirectoryPicker = useSyncExternalStore(
		() => () => {},
		() => { const bridge = getDesktopBridge(); return Boolean(bridge?.isDesktop && bridge.pickDirectory); },
		() => false,
	);
	const [pickerBusy, setPickerBusy] = useState(false);
	const [pickerError, setPickerError] = useState<string | null>(null);
	const [probe, setProbe] = useState<KnowledgeProbeRecord | null>(null);
	const [probeBusy, setProbeBusy] = useState(false);
	const [probeError, setProbeError] = useState<{ title: string; detail: string; canCreate?: boolean } | null>(null);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [mode, setMode] = useState<"bind" | "create">("bind");
	const [obsidianRoot, setObsidianRoot] = useState<string | null>(null);
	const [schemaPresetId, setSchemaPresetId] = useState<string | null>(null);
	const [detailsError, setDetailsError] = useState<string | null>(null);
	const [presetsNonce, setPresetsNonce] = useState(0);
	const [presetsState, setPresetsState] = useState<{ key: number; value: KnowledgeSchemaPresetSummary[] | null; error: string | null } | null>(null);
	const [planBusy, setPlanBusy] = useState(false);
	const [plan, setPlan] = useState<KnowledgePlan | null>(null);
	const [applyBusy, setApplyBusy] = useState(false);
	const [applyError, setApplyError] = useState<ApplyFailure | null>(null);
	const [receipts, setReceipts] = useState<KnowledgeApplyReceipt[] | null>(null);
	const [binding, setBinding] = useState<KnowledgeBindingSummary | null>(null);
	const [observeNonce, setObserveNonce] = useState(0);
	const [observationsState, setObservationsState] = useState<{ key: string; value: KnowledgeObservations | null; error: string | null } | null>(null);
	const [restoring, setRestoring] = useState(Boolean(planParam));
	const restoredRef = useRef(false);

	// ?plan=<planId> 深链：恢复到计划预览；404（过期/不存在）回第一步并提示。
	useEffect(() => {
		if (restoredRef.current) return;
		restoredRef.current = true;
		if (!planParam) return;
		let active = true;
		void getKnowledgePlan(planParam)
			.then((value) => {
				if (!active) return;
				setPlan(value);
				setPathInput(value.canonicalBindingRoot);
				setName(value.name);
				setDescription(value.description);
				setMode(value.mode);
				if (value.obsidianRoot) setObsidianRoot(value.obsidianRoot);
				setSchemaPresetId(value.schemaPresetId ?? null);
				setStep("plan");
			})
			.catch((cause) => {
				if (!active) return;
				setNotice(
					cause instanceof KnowledgeApiError && cause.status === 404
						? "接入计划不存在或已过期，请重新检查目录并生成新计划。"
						: errorMessage(cause),
				);
				setStep("path");
			})
			.finally(() => { if (active) setRestoring(false); });
		return () => { active = false; };
	}, [planParam]);

	// 结构预置清单：进入 details/plan 步时加载，失败原位重试（presetsNonce）。
	useEffect(() => {
		if (step !== "details" && step !== "plan") return;
		let active = true;
		void listKnowledgePresets()
			.then((value) => { if (active) setPresetsState({ key: presetsNonce, value, error: null }); })
			.catch((cause) => { if (active) setPresetsState({ key: presetsNonce, value: null, error: errorMessage(cause) }); });
		return () => { active = false; };
	}, [step, presetsNonce]);

	const presets = presetsState && presetsState.key === presetsNonce ? presetsState.value : null;
	const presetsError = presetsState && presetsState.key === presetsNonce ? presetsState.error : null;
	const presetsLoading = (step === "details" || step === "plan") && !presets && !presetsError;

	// 同步完成：进入 sync 步先强制扫描，再拉观察快照。
	useEffect(() => {
		if (step !== "sync" || !binding) return;
		const key = `${binding.id} ${observeNonce}`;
		let active = true;
		void (async () => {
			try {
				await scanKnowledgeBinding(binding.id);
				const value = await getKnowledgeObservations(binding.id);
				if (active) setObservationsState({ key, value, error: null });
			} catch (cause) {
				if (active) setObservationsState({ key, value: null, error: errorMessage(cause) });
			}
		})();
		return () => { active = false; };
	}, [step, binding, observeNonce]);

	const observationsKey = binding ? `${binding.id} ${observeNonce}` : null;
	const observations = observationsState && observationsState.key === observationsKey ? observationsState.value : null;
	const observationsError = observationsState && observationsState.key === observationsKey ? observationsState.error : null;
	const obsidianCandidates = probe?.obsidianRootCandidates ?? null;

	const runProbe = useCallback(async (intent?: "create") => {
		const value = pathInput.trim();
		if (!value) return; // 按钮在空输入时禁用，此处仅兜底
		setProbeBusy(true);
		setProbeError(null);
		setPickerError(null);
		setNotice(null);
		try {
			const { probe: record } = await createKnowledgeProbe(value, intent);
			setProbe(record);
			if (!name.trim()) setName(record.canonicalBindingRoot.split("/").filter(Boolean).pop() ?? "");
			const hasExistingLayout = record.profile === "managed-wiki" || record.markers.hasWiki || record.markers.hasRaw || record.markers.hasManifest || record.markers.hasSchema;
			// 目录尚不存在时模式固定为 create（details 步隐藏 bind 选项）。
			setMode(!record.targetExists || !hasExistingLayout ? "create" : "bind");
			setObsidianRoot(record.obsidianRoot ?? null);
			setSchemaPresetId(null);
			setPlan(null);
			setReceipts(null);
			setApplyError(null);
			setDetailsError(null);
			setStep("probe");
		} catch (cause) {
			setProbeError(probeErrorInfo(cause));
		} finally {
			setProbeBusy(false);
		}
	}, [pathInput, name]);

	const pickDirectory = useCallback(async () => {
		setPickerBusy(true);
		setPickerError(null);
		try {
			const picked = await pickWorkspaceDirectory(pathInput.trim() || "/");
			if (picked) setPathInput(picked);
		} catch (cause) {
			setPickerError(errorMessage(cause));
		} finally {
			setPickerBusy(false);
		}
	}, [pathInput]);

	const submitDetails = useCallback(async () => {
		if (!probe) return;
		const trimmedName = name.trim();
		const trimmedDescription = description.trim();
		if (!trimmedName || !trimmedDescription) {
			setDetailsError("请填写名称与描述，说明这个知识库的用途。");
			return;
		}
		if (obsidianCandidates && !obsidianRoot) {
			setDetailsError("根目录与 wiki/ 均存在 .obsidian，请先在检查结果中选择 Obsidian 根。");
			return;
		}
		setPlanBusy(true);
		setDetailsError(null);
		try {
			const created = await createKnowledgePlan({
				probeId: probe.probeId,
				name: trimmedName,
				description: trimmedDescription,
				mode,
				...(obsidianCandidates && obsidianRoot ? { obsidianRoot } : {}),
				...(mode === "create" && schemaPresetId ? { schemaPresetId } : {}),
			});
			setPlan(created);
			setApplyError(null);
			setReceipts(null);
			setStep("plan");
		} catch (cause) {
			if (cause instanceof KnowledgeApiError && cause.status === 404) {
				// probeId 内存 TTL 10 分钟：过期后回到路径步重新探测，已填内容保留。
				setNotice("探测结果已过期（检查完成后 10 分钟内有效），请重新检查目录。");
				setProbe(null);
				setPlan(null);
				setStep("path");
			} else {
				setDetailsError(errorMessage(cause));
			}
		} finally {
			setPlanBusy(false);
		}
	}, [probe, name, description, mode, obsidianCandidates, obsidianRoot, schemaPresetId]);

	const runApply = useCallback(async () => {
		if (!plan) return;
		setApplyBusy(true);
		setApplyError(null);
		try {
			const result = await applyKnowledgePlan(plan.planId);
			setBinding(result.binding);
			setReceipts(result.receipts);
			setStep("sync");
		} catch (cause) {
			if (cause instanceof KnowledgeApiError) {
				if (cause.code === "partial" && Array.isArray(cause.details)) {
					setApplyError({ message: cause.message, code: cause.code, receipts: cause.details as KnowledgeApplyReceipt[] });
				} else if (cause.code === "root_changed") {
					setApplyError({ message: "目录在检查后被替换或已离线，无法按原计划接入。", code: cause.code });
				} else {
					setApplyError({ message: cause.message, code: cause.code });
				}
			} else {
				setApplyError({ message: errorMessage(cause) });
			}
		} finally {
			setApplyBusy(false);
		}
	}, [plan]);

	const restartFromPath = useCallback((message: string) => {
		setNotice(message);
		setProbe(null);
		setPlan(null);
		setApplyError(null);
		setReceipts(null);
		setStep("path");
	}, []);

	const backFromPlan = useCallback(() => setStep(probe ? "details" : "path"), [probe]);
	const vaultHref = binding ? `/knowledge?vault=${encodeURIComponent(binding.id)}` : "/knowledge";

	if (restoring) {
		return (
			<div className="flex min-w-0 flex-1 items-center justify-center bg-background text-sm text-muted-foreground">
				<Loader2Icon size={15} className="mr-2 animate-spin" />正在恢复接入计划…
			</div>
		);
	}

	return (
		<div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
			<header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
				<div>
					<Link href="/knowledge" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
						<ArrowLeftIcon size={12} />知识库
					</Link>
					<h1 className="mt-0.5 text-2xl font-medium tracking-tight">接入知识库</h1>
				</div>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-3xl px-6 py-6">
					<StepsBar step={step} />

					{step === "path" ? (
						<form
							className="mt-6"
							onSubmit={(event) => { event.preventDefault(); void runProbe(); }}
						>
							<h2 className="text-lg font-medium">选择知识库目录</h2>
							<p className="mt-1 text-sm text-muted-foreground">
								选择 Teams 服务所在机器上的一个目录：可以是已有的标准 Wiki、普通 Markdown 笔记目录，也可以是准备新建知识库的空目录。
							</p>
							{notice ? (
								<p className="knowledge-banner is-warning mt-4" role="status">
									<AlertTriangleIcon size={14} />
									<span>{notice}</span>
								</p>
							) : null}
							<label className="mt-4 block text-xs font-medium text-muted-foreground" htmlFor="knowledge-connect-path">
								目录路径（服务端机器上的绝对路径）
							</label>
							<div className="mt-1 flex gap-2">
								<input
									id="knowledge-connect-path"
									value={pathInput}
									onChange={(event) => setPathInput(event.target.value)}
									placeholder="/Users/you/Documents/my-wiki"
									autoComplete="off"
									spellCheck={false}
									className="min-w-0 flex-1 rounded border border-border bg-background px-3 py-2 font-mono text-sm"
								/>
								{hasDirectoryPicker ? (
									<button
										type="button"
										onClick={() => void pickDirectory()}
										disabled={pickerBusy}
										className="flex shrink-0 items-center gap-1.5 rounded border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
									>
										{pickerBusy ? <Loader2Icon size={14} className="animate-spin" /> : <FolderOpenIcon size={14} />}
										选择目录…
									</button>
								) : null}
							</div>
							<p className="mt-2 text-xs text-muted-foreground">
								这里填写的是运行 Teams 服务的电脑上的路径，不是浏览器所在机器；输入路径本身不会授予任何写入权限，正式接入前还会展示并确认完整的文件计划。
							</p>
							{pickerError ? (
								<p role="alert" className="mt-2 text-xs text-destructive">{pickerError}</p>
							) : null}
							{probeError ? (
								probeError.canCreate ? (
									<div className="mt-3 rounded-lg border border-border bg-card p-4" role="alert">
										<p className="flex items-center gap-2 text-sm font-medium">
											<CircleAlertIcon size={14} className="shrink-0 text-amber-600 dark:text-amber-400" />
											目录不存在
										</p>
										<p className="mt-1 break-all font-mono text-xs text-muted-foreground">{pathInput.trim()}</p>
										<p className="mt-2 text-sm text-muted-foreground">
											{probeError.detail}如果就是要在这里新建知识库，可以确认创建该目录；正式写入前还会展示并确认完整的文件计划。
										</p>
										<div className="mt-3 flex flex-wrap items-center gap-2">
											<button
												type="button"
												onClick={() => void runProbe("create")}
												disabled={probeBusy}
												className="flex items-center gap-1.5 rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
											>
												{probeBusy ? <Loader2Icon size={14} className="animate-spin" /> : <FolderPlusIcon size={14} />}
												{probeBusy ? "正在检查…" : "创建该目录并初始化知识库"}
											</button>
											<button
												type="button"
												onClick={() => setProbeError(null)}
												className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm hover:bg-muted"
											>
												<ArrowLeftIcon size={14} />返回修改路径
											</button>
										</div>
									</div>
								) : (
									<div className="knowledge-banner is-error mt-3" role="alert">
										<CircleAlertIcon size={14} />
										<span><strong>{probeError.title}</strong>：{probeError.detail}</span>
									</div>
								)
							) : null}
							<div className="mt-6 flex items-center justify-end gap-2">
								<button
									type="submit"
									disabled={probeBusy || !pathInput.trim()}
									className="flex items-center gap-1.5 rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
								>
									{probeBusy ? <Loader2Icon size={14} className="animate-spin" /> : <FolderSearchIcon size={14} />}
									{probeBusy ? "正在检查…" : "检查目录"}
								</button>
							</div>
						</form>
					) : null}

					{step === "probe" && probe ? (
						<section className="mt-6">
							<div className="flex flex-wrap items-center gap-2">
								<h2 className="text-lg font-medium">检查结果</h2>
								<span className="rounded-full bg-accent px-2.5 py-0.5 text-xs text-accent-foreground">
									{!probe.targetExists ? "待创建的新目录" : probe.profile === "managed-wiki" ? "标准 Wiki 布局" : "普通 Markdown 目录"}
								</span>
							</div>
							<p className="mt-2 break-all font-mono text-xs text-muted-foreground">{probe.canonicalBindingRoot}</p>

							{probe.targetExists && !probe.capabilities.read ? (
								<p className="knowledge-banner is-error mt-4" role="alert">
									<CircleAlertIcon size={14} />
									<span>内容目录不可读，接入后也无法阅读；请在服务端机器上修正目录权限后重新检查。</span>
								</p>
							) : null}

							{!probe.targetExists ? (
								<div className="mt-4 rounded-lg border border-border bg-card p-4">
									<p className="flex items-center gap-2 text-sm font-medium">
										<FolderPlusIcon size={14} className="shrink-0 text-muted-foreground" />
										目录尚不存在，将在应用计划时创建
									</p>
									<p className="mt-2 text-xs text-muted-foreground">
										接入方式固定为「初始化新库」：创建目录后生成首页 wiki/index.md 等脚手架文件，可在下一步选择结构预置；不会写入该目录之外的任何位置。
									</p>
								</div>
							) : (
								<>
									<div className="mt-4 rounded-lg border border-border bg-card p-4">
										<p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">目录标记</p>
										<div className="grid gap-2 sm:grid-cols-2">
											<MarkerRow ok={probe.markers.hasWiki} label="wiki/ 笔记目录" />
											<MarkerRow ok={probe.markers.hasRaw} label="raw/ 资料目录" />
											<MarkerRow ok={probe.markers.hasManifest} label="来源清单 raw/manifest.jsonl" />
											<MarkerRow ok={probe.markers.hasSchema} label="结构声明 wiki.schema.json" />
											<MarkerRow ok={probe.markers.hasObsidianRoot} label="根目录 .obsidian 配置" />
											<MarkerRow ok={probe.markers.hasObsidianWiki} label="wiki/ 内 .obsidian 配置" />
										</div>
									</div>

									<div className="mt-3 rounded-lg border border-border bg-card p-4">
										<p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">能力</p>
										<ul className="space-y-1.5 text-sm">
											<li className="flex items-center gap-2">
												{probe.capabilities.read
													? <CheckCircle2Icon size={14} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
													: <CircleAlertIcon size={14} className="shrink-0 text-destructive" />}
												<span>阅读{probe.capabilities.read ? "可用" : "不可用"}：目录树、笔记正文、双链解析</span>
											</li>
											<li className="flex items-center gap-2 text-muted-foreground">
												<MinusIcon size={14} className="shrink-0" />
												<span>
													{probe.markers.hasSchema
														? "结构化校验将按库内结构声明提供"
														: "未检测到结构声明：结构化校验不可用，可正常阅读"}
												</span>
											</li>
											<li className="flex items-center gap-2 text-muted-foreground">
												<MinusIcon size={14} className="shrink-0" />
												<span>写入与发布由发布流程接管，接入过程不做任何隐式写盘</span>
											</li>
										</ul>
									</div>
								</>
							)}

							{probe.warnings.length > 0 ? (
								<div className="knowledge-banner is-warning mt-4" role="status">
									<AlertTriangleIcon size={14} />
									<span>
										{probe.warnings.map((warning) => <span key={warning} className="block">{warning}</span>)}
									</span>
								</div>
							) : null}

							{obsidianCandidates ? (
								<fieldset className="mt-4">
									<legend className="text-sm font-medium">选择 Obsidian 根（必选）</legend>
									<p className="mt-1 text-xs text-muted-foreground">
										根目录与 wiki/ 都存在 .obsidian 配置。请选择 Obsidian 客户端实际打开的库根；只影响「在 Obsidian 中打开」，不影响平台阅读。
									</p>
									<div className="mt-2 space-y-2">
										{obsidianCandidates.map((candidate) => (
											<label key={candidate} className="knowledge-option" data-selected={obsidianRoot === candidate}>
												<input
													type="radio"
													name="obsidian-root"
													checked={obsidianRoot === candidate}
													onChange={() => setObsidianRoot(candidate)}
												/>
												<span className="min-w-0">
													<strong className="block text-sm">{candidate === probe.canonicalBindingRoot ? "库根目录" : "wiki/ 子目录"}</strong>
													<code className="block break-all text-xs text-muted-foreground">{candidate}</code>
												</span>
											</label>
										))}
									</div>
								</fieldset>
							) : null}

							<div className="mt-6 flex items-center justify-between gap-2">
								<button type="button" onClick={() => setStep("path")} className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm hover:bg-muted">
									<ArrowLeftIcon size={14} />上一步
								</button>
								<button
									type="button"
									onClick={() => setStep("details")}
									disabled={(probe.targetExists && !probe.capabilities.read) || (obsidianCandidates !== null && obsidianRoot === null)}
									className="flex items-center gap-1.5 rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
								>
									下一步：名称与结构<ChevronRightIcon size={14} />
								</button>
							</div>
						</section>
					) : null}

					{step === "details" ? (
						<section className="mt-6">
							{!probe ? (
								<div>
									<h2 className="text-lg font-medium">名称与结构</h2>
									<p className="knowledge-banner is-warning mt-4" role="status">
										<AlertTriangleIcon size={14} />
										<span>当前计划是从链接恢复的，没有保留探测上下文；如需修改，请从第一步重新检查目录。</span>
									</p>
									<div className="mt-6 flex items-center gap-2"><button type="button" onClick={() => restartFromPath("请重新检查目录并生成新计划。")} className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm hover:bg-muted"><ArrowLeftIcon size={14} />重新检查目录</button></div>
								</div>
							) : (
								<>
									<h2 className="text-lg font-medium">这个知识库用来做什么？</h2>
									<p className="mt-1 break-all font-mono text-xs text-muted-foreground">{probe.canonicalBindingRoot}</p>
									<div className="mt-4 grid gap-3">
										<label className="block text-xs font-medium text-muted-foreground">
											名称（必填，120 字以内）
											<input
												value={name}
												maxLength={120}
												onChange={(event) => setName(event.target.value)}
												className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground"
											/>
										</label>
										<label className="block text-xs font-medium text-muted-foreground">
											描述（必填，{description.trim().length}/500）
											<textarea
												value={description}
												maxLength={500}
												rows={3}
												placeholder="例如：沉淀 Agent、Harness 与 AI 工程研究，保留资料来源和证据关系。"
												onChange={(event) => setDescription(event.target.value)}
												className="mt-1 w-full resize-y rounded border border-border bg-background px-3 py-2 text-sm text-foreground"
											/>
										</label>
									</div>

									<fieldset className="mt-5">
										<legend className="text-sm font-medium">接入方式</legend>
										<div className="mt-2 space-y-2">
											{probe.targetExists ? (
												<label className="knowledge-option" data-selected={mode === "bind"}>
													<input type="radio" name="connect-mode" checked={mode === "bind"} onChange={() => setMode("bind")} />
													<span>
														<strong className="block text-sm">绑定现有目录</strong>
														<span className="block text-xs text-muted-foreground">只登记目录映射与描述，零磁盘写入；目录中已有文件保持原样。</span>
													</span>
												</label>
											) : null}
											<label className="knowledge-option" data-selected={mode === "create"}>
												<input type="radio" name="connect-mode" checked={mode === "create"} onChange={() => setMode("create")} />
												<span>
													<strong className="block text-sm">在目录中初始化新库</strong>
													<span className="block text-xs text-muted-foreground">
														{probe.targetExists
															? "创建首页 wiki/index.md 等脚手架文件；已存在的同名文件跳过、不覆盖，应用前可先预览文件清单与内容。"
															: "目录尚不存在：应用计划时先创建该目录，再生成首页 wiki/index.md 等脚手架文件；应用前可先预览文件清单与内容。"}
													</span>
												</span>
											</label>
										</div>
									</fieldset>

									{mode === "create" ? (
										<fieldset className="mt-5">
											<legend className="text-sm font-medium">资料结构（可选）</legend>
											<p className="mt-1 text-xs text-muted-foreground">
												选中的预置会复制为本库根目录唯一的 wiki.schema.json；之后内置预置更新不影响本库，本库结构变更走发布流程。
											</p>
											{presetsLoading ? (
												<p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Loader2Icon size={14} className="animate-spin" />正在加载结构预置…</p>
											) : presetsError ? (
												<p role="alert" className="mt-3 text-sm text-destructive">
													{presetsError}{" "}
													<button type="button" onClick={() => setPresetsNonce((value) => value + 1)} className="underline">重试</button>
												</p>
											) : (
												<div className="mt-2 space-y-2">
													<label className="knowledge-option" data-selected={schemaPresetId === null}>
														<input type="radio" name="schema-preset" checked={schemaPresetId === null} onChange={() => setSchemaPresetId(null)} />
														<span>
															<strong className="block text-sm">不使用结构</strong>
															<span className="block text-xs text-muted-foreground">普通 Markdown 库；以后可以在库内添加结构声明。</span>
														</span>
													</label>
													{(presets ?? []).map((preset) => (
														<label key={preset.schemaId} className="knowledge-option" data-selected={schemaPresetId === preset.schemaId}>
															<input type="radio" name="schema-preset" checked={schemaPresetId === preset.schemaId} onChange={() => setSchemaPresetId(preset.schemaId)} />
															<span className="min-w-0">
																<strong className="block text-sm">{preset.name}</strong>
																<span className="block text-xs text-muted-foreground">
																	{preset.entities.length} 类实体 · {preset.relations.length} 种关系
																</span>
																<span className="mt-1 block text-xs text-muted-foreground">
																	{preset.entities.map((entity) => `${entity.type}（${entity.directory}/）`).join("、")}
																</span>
															</span>
														</label>
													))}
												</div>
											)}
										</fieldset>
									) : null}

									{detailsError ? (
										<p role="alert" className="mt-4 text-sm text-destructive">{detailsError}</p>
									) : null}

									<div className="mt-6 flex items-center justify-between gap-2">
										<button type="button" onClick={() => setStep("probe")} className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm hover:bg-muted">
											<ArrowLeftIcon size={14} />上一步
										</button>
										<button
											type="button"
											onClick={() => void submitDetails()}
											disabled={planBusy}
											className="flex items-center gap-1.5 rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
										>
											{planBusy ? <Loader2Icon size={14} className="animate-spin" /> : null}
											{planBusy ? "正在生成计划…" : "生成接入计划"}
										</button>
									</div>
								</>
							)}
						</section>
					) : null}

					{step === "plan" && plan ? (
						<section className="mt-6">
							<h2 className="text-lg font-medium">{plan.mode === "create" ? "先看看将要创建的内容" : "确认接入这个知识库"}</h2>
							<div className="mt-3 rounded-lg border border-border bg-card p-4">
								<p className="text-sm font-medium">{plan.name}</p>
								<p className="mt-1 text-sm text-muted-foreground">{plan.description}</p>
								<p className="mt-2 break-all font-mono text-xs text-muted-foreground">{plan.canonicalBindingRoot}</p>
								<div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
									<span className="rounded-full bg-accent px-2.5 py-0.5 text-accent-foreground">
										{plan.mode === "bind" ? "绑定现有目录 · 零磁盘写入" : "初始化新库"}
									</span>
									{plan.schemaPresetId ? (
										<span className="rounded-full bg-accent px-2.5 py-0.5 text-accent-foreground">
											结构预置：{presets?.find((preset) => preset.schemaId === plan.schemaPresetId)?.name ?? plan.schemaPresetId}
										</span>
									) : null}
									{plan.obsidianRoot ? (
										<span className="rounded-full bg-accent px-2.5 py-0.5 text-accent-foreground">已选择 Obsidian 根</span>
									) : null}
								</div>
							</div>

							{plan.createRootDir ? (
								<div className="mt-4 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
									<FolderPlusIcon size={14} className="shrink-0 text-muted-foreground" />
									<span className="shrink-0 font-medium">将创建目录</span>
									<code className="min-w-0 flex-1 truncate break-all text-xs text-muted-foreground">{plan.canonicalBindingRoot}</code>
								</div>
							) : null}

							<h3 className="mt-5 text-sm font-medium">
								{plan.filesToCreate.length > 0 ? `拟创建文件 · ${plan.filesToCreate.length} 项` : "文件操作 · 无"}
							</h3>
							{plan.filesToCreate.length > 0 ? (
								<ul className="mt-2 space-y-2">
									{plan.filesToCreate.map((file) => {
										const previewLines = file.content.split("\n").slice(0, 12);
										const truncated = file.content.split("\n").length > previewLines.length;
										return (
											<li key={file.relativePath} className="rounded-lg border border-border bg-card">
												<details>
													<summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
														<FilePlus2Icon size={14} className="shrink-0 text-muted-foreground" />
														<code className="min-w-0 flex-1 truncate">{file.relativePath}</code>
														<span className="shrink-0 text-xs text-muted-foreground">{formatBytes(file.bytes)} · 新建</span>
													</summary>
													<pre className="knowledge-json mx-3 mb-3">{previewLines.join("\n")}{truncated ? "\n…" : ""}</pre>
												</details>
											</li>
										);
									})}
								</ul>
							) : (
								<p className="mt-2 text-sm text-muted-foreground">
									仅登记目录映射、名称与描述；不会在目录中添加或改写任何文件。
								</p>
							)}

							{plan.filesToSkip.length > 0 ? (
								<div className="mt-4">
									<h3 className="text-sm font-medium">已存在 · 不覆盖 · {plan.filesToSkip.length} 项</h3>
									<ul className="mt-2 space-y-1">
										{plan.filesToSkip.map((file) => (
											<li key={file.relativePath} className="flex items-center gap-2 text-xs">
												<FileTextIcon size={13} className="shrink-0 text-muted-foreground" />
												<code className="min-w-0 flex-1 truncate">{file.relativePath}</code>
												<span className="knowledge-status-badge shrink-0">已存在 · 保持原样</span>
											</li>
										))}
									</ul>
								</div>
							) : null}

							{plan.warnings.length > 0 ? (
								<div className="knowledge-banner is-warning mt-4" role="status">
									<AlertTriangleIcon size={14} />
									<span>
										{plan.warnings.map((warning) => <span key={warning} className="block">{warning}</span>)}
									</span>
								</div>
							) : null}

							{applyError ? (
								<div className="mt-4">
									<div className="knowledge-banner is-error" role="alert">
										<CircleAlertIcon size={14} />
										<span>
											{applyError.message}
											{applyError.code === "partial" ? (
												<span className="mt-1 block">本次已创建且未被改动的文件已被清理；其余文件保持原样。可修正后重试应用，或返回第一步重新检查目录。</span>
											) : null}
											{applyError.code === "root_changed" ? (
												<span className="mt-1 block">目录在检查后被替换。请重新探测并生成新计划。</span>
											) : null}
										</span>
									</div>
									{applyError.receipts ? (
										<div className="mt-2 rounded-lg border border-border bg-card p-3">
											<ReceiptList receipts={applyError.receipts} />
										</div>
									) : null}
									{applyError.code === "root_changed" || applyError.code === "not_found" ? (
										<button
											type="button"
											onClick={() => restartFromPath("请重新检查目录并生成新计划。")}
											className="mt-3 flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm hover:bg-muted"
										>
											<ArrowLeftIcon size={14} />重新检查目录
										</button>
									) : null}
								</div>
							) : null}

							<div className="mt-6 flex items-center justify-between gap-2">
								<button type="button" onClick={backFromPlan} className="flex items-center gap-1.5 rounded border border-border px-3 py-2 text-sm hover:bg-muted">
									<ArrowLeftIcon size={14} />上一步
								</button>
								<button
									type="button"
									onClick={() => void runApply()}
									disabled={applyBusy}
									className="flex items-center gap-1.5 rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
								>
									{applyBusy ? <Loader2Icon size={14} className="animate-spin" /> : <ShieldCheckIcon size={14} />}
									{applyBusy ? "正在应用…" : plan.mode === "bind" ? "确认绑定（不写入文件）" : "确认创建并接入"}
								</button>
							</div>
						</section>
					) : null}

					{step === "sync" && binding ? (
						<section className="mt-6">
							<h2 className="text-lg font-medium">已接入 · {binding.name}</h2>
							<p className="mt-1 text-sm text-muted-foreground">
								知识库已接入。现有笔记及之后在 Obsidian 或编辑器中的修改会自动同步，无需审核；Agent 生成的候选仍需确认后发布。
							</p>

							{receipts && receipts.length > 0 ? (
								<details className="mt-4 rounded-lg border border-border bg-card p-3">
									<summary className="cursor-pointer text-sm font-medium">初始化文件结果 · {receipts.length} 项</summary>
									<div className="mt-2">
										<ReceiptList receipts={receipts} />
									</div>
								</details>
							) : null}

							{!observations && !observationsError ? (
								<p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2Icon size={14} className="animate-spin" />正在扫描目录…</p>
							) : observationsError ? (
								<p role="alert" className="mt-4 text-sm text-destructive">
									{observationsError}{" "}
									<button type="button" onClick={() => setObserveNonce((value) => value + 1)} className="underline">重新扫描</button>
								</p>
							) : observations ? (
								<div className="mt-4">
									{observations.files.length === 0 ? (
										<div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
											目录中还没有 Markdown 笔记。可以在 Obsidian 或编辑器中添加，平台会自动同步。
										</div>
									) : (
										<>
											<p className="text-sm">扫描到 <strong>{observations.files.length}</strong> 个 Markdown 文件：</p>
											{observations.duplicates.length > 0 ? (
												<div className="knowledge-banner is-warning mt-3" role="status">
													<AlertTriangleIcon size={14} />
													<span>
														{observations.duplicates.map((entry) => (
															<span key={entry.declaredId} className="block">笔记 id「{entry.declaredId}」被 {entry.paths.length} 篇笔记声明，将按路径登记。</span>
														))}
													</span>
												</div>
											) : null}
											<details className="mt-3 rounded-lg border border-border bg-card p-3">
												<summary className="cursor-pointer text-sm font-medium">查看清单 · {observations.files.length} 篇</summary>
												<ul className="mt-2 max-h-72 space-y-1 overflow-y-auto">
													{observations.files.map((file) => (
														<li key={file.path} className="flex items-center gap-2 text-xs">
															<FileTextIcon size={13} className="shrink-0 text-muted-foreground" />
															<code className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</code>
															<span className="shrink-0 text-muted-foreground">{formatBytes(file.size)}</span>
														</li>
													))}
												</ul>
											</details>
										</>
									)}

									<div className="mt-6 flex justify-end"><Link href={vaultHref} className="flex items-center gap-1.5 rounded bg-primary px-3 py-2 text-sm text-primary-foreground">进入知识库<ChevronRightIcon size={14} /></Link></div>
								</div>
							) : null}
						</section>
					) : null}
				</div>
			</div>
		</div>
	);
}
