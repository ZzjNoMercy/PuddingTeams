"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, CheckIcon, LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
	applyKnowledgePlan,
	createKnowledgePlan,
	createKnowledgeProbe,
	listKnowledgePresets,
	type KnowledgeBindingSummary,
	type KnowledgeSchemaPresetSummary,
} from "@/lib/api";
import { KnowledgeSchemaView } from "./schema-view";
import { presetTone } from "./vault-tones";

/**
 * 创建知识库对话框（对齐冻结原型 vault modal）：01 基本信息 → 02 结构预览。
 * 与原型差异：结构预览用只读 KnowledgeSchemaView（不做原型里的 SchemaStudio 编辑）；
 * 保存位置真实落盘，走 probe(intent=create) → plan(mode=create) → apply 链路。
 */
export function CreateVaultDialog({ open, onOpenChange, onCreated }: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** 创建成功后回调（父级把新绑定并入列表并刷新）。 */
	onCreated?: (binding: KnowledgeBindingSummary) => void;
}) {
	const router = useRouter();
	const [step, setStep] = useState<1 | 2>(1);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [location, setLocation] = useState("");
	const [presets, setPresets] = useState<KnowledgeSchemaPresetSummary[] | null>(null);
	const [presetsError, setPresetsError] = useState<string | null>(null);
	const [schemaId, setSchemaId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [wasOpen, setWasOpen] = useState(open);

	// 打开沿 render-adjust 模式重置编辑态，避免在 effect 里同步 setState。
	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) {
			setStep(1);
			setName("");
			setDescription("");
			setLocation("");
			setPresets(null);
			setPresetsError(null);
			setSchemaId(null);
			setError(null);
			setBusy(false);
		}
	}

	// 打开时拉取结构预置清单，默认选中第一套。
	useEffect(() => {
		if (!open) return;
		let active = true;
		void listKnowledgePresets()
			.then((value) => {
				if (!active) return;
				setPresets(value);
				setSchemaId((previous) => previous ?? value[0]?.schemaId ?? null);
			})
			.catch((cause) => { if (active) setPresetsError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { active = false; };
	}, [open]);

	const selectedPreset = presets?.find((preset) => preset.schemaId === schemaId) ?? null;
	const effectivePath = location.trim() || `~/Documents/${name.trim()}`;

	const submit = async () => {
		if (busy) return;
		if (step === 1) {
			if (!name.trim() || !description.trim()) {
				setError("请填写知识库名称和描述。");
				return;
			}
			if (!selectedPreset) {
				setError(presetsError ? `资料结构加载失败：${presetsError}` : "资料结构未加载完成，请稍后重试。");
				return;
			}
			setError(null);
			setStep(2);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const { probeId } = await createKnowledgeProbe(effectivePath, "create");
			const plan = await createKnowledgePlan({
				probeId,
				name: name.trim(),
				description: description.trim(),
				mode: "create",
				schemaPresetId: selectedPreset?.schemaId,
			});
			const { binding } = await applyKnowledgePlan(plan.planId);
			onOpenChange(false);
			onCreated?.(binding);
			router.push(`/knowledge?vault=${encodeURIComponent(binding.id)}`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
			<DialogContent className="vault-create flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-[620px]">
				<DialogHeader>
					<DialogTitle>创建知识库</DialogTitle>
					<DialogDescription>说明用途，选择合适的资料分类。</DialogDescription>
				</DialogHeader>
				<DialogBody>
				<form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
					<div className="vault-create-stepper" aria-hidden="true">
						<span data-active={step === 1}>01 基本信息</span>
						<ArrowRightIcon size={13} />
						<span data-active={step === 2}>02 结构预览</span>
					</div>

					{step === 1 ? (
						<>
							<label className="vault-create-field">
								知识库名称
								<input
									value={name}
									onChange={(event) => setName(event.target.value)}
									placeholder="例如：产品灵感、个人生活"
									disabled={busy}
									autoFocus
								/>
							</label>
							<label className="vault-create-field">
								描述 <span className="vault-create-muted">告诉 Manager 这里存什么、什么时候用</span>
								<textarea
									value={description}
									onChange={(event) => setDescription(event.target.value)}
									placeholder="记录产品想法、竞品观察和设计决策，适合在规划新功能时作为参考。"
									maxLength={500}
									disabled={busy}
								/>
							</label>
							<label className="vault-create-field">
								保存位置 <span className="vault-create-muted">可选，留空时按名称创建于 ~/Documents</span>
								<input
									value={location}
									onChange={(event) => setLocation(event.target.value)}
									placeholder={`~/Documents/${name.trim() || "你的知识库"}`}
									disabled={busy}
									spellCheck={false}
								/>
							</label>
							<div className="vault-create-field" role="group" aria-label="选择资料结构">
								选择资料结构
								{presetsError ? (
									<p role="alert" className="vault-create-error">资料结构加载失败：{presetsError}</p>
								) : !presets ? (
									<p className="vault-create-muted">正在加载…</p>
								) : (
									<div className="vault-create-schemas">
										{presets.map((preset) => (
											<button
												key={preset.schemaId}
												type="button"
												className="vault-create-schema"
												data-selected={schemaId === preset.schemaId}
												disabled={busy}
												onClick={() => setSchemaId(preset.schemaId)}
											>
												<span className="vault-create-dot" data-tone={presetTone(preset.schemaId)} />
												<span className="min-w-0 flex-1">
													<strong>{preset.name}</strong>
													<small>{preset.description} · {preset.entities.length} 类实体 / {preset.relations.length} 种关系</small>
												</span>
												{schemaId === preset.schemaId ? <CheckIcon size={17} className="shrink-0" /> : null}
											</button>
										))}
									</div>
								)}
							</div>
						</>
					) : (
						<>
							<div className="vault-create-preview">
								<h3>{name.trim()}</h3>
								<p>{description.trim()}</p>
								{selectedPreset ? (
									<span className="knowledge-vault-schema" data-tone={presetTone(selectedPreset.schemaId)}>{selectedPreset.name}</span>
								) : null}
								<p>这是从内置结构复制给当前知识库的独立版本。创建后可在结构页查看；内置结构的后续更新不影响本库。</p>
								<p className="vault-create-muted">保存位置：{effectivePath}（目录不存在时将自动创建）</p>
							</div>
							{selectedPreset ? <KnowledgeSchemaView schema={selectedPreset} /> : null}
						</>
					)}

					{error ? <div role="alert" className="vault-create-error">{error}</div> : null}
					<div className="vault-create-footer">
						{step === 2 ? (
							<Button type="button" variant="outline" disabled={busy} onClick={() => { setStep(1); setError(null); }}>上一步</Button>
						) : null}
						<Button type="submit" disabled={busy}>
							{busy ? (
								<><LoaderIcon size={15} className="animate-spin" />正在创建…</>
							) : step === 1 ? (
								<>下一步：预览结构<ArrowRightIcon size={16} /></>
							) : (
								"创建知识库"
							)}
						</Button>
					</div>
				</form>
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}
