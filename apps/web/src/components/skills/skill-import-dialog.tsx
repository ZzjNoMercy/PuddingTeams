"use client";

import { useRef, useState } from "react";
import { FileArchiveIcon, FolderOpenIcon, LoaderIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface SkillImportDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	path: string;
	onPathChange: (path: string) => void;
	onPickDirectory: () => Promise<void> | void;
	onImportPath: () => Promise<void> | void;
	onImportZip: (file: File) => Promise<void> | void;
	importing: boolean;
}

export function SkillImportDialog({ open, onOpenChange, ...props }: SkillImportDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open ? <SkillImportDialogContent {...props} onClose={() => onOpenChange(false)} /> : null}
		</Dialog>
	);
}

function SkillImportDialogContent({
	path,
	onPathChange,
	onPickDirectory,
	onImportPath,
	onImportZip,
	importing,
	onClose,
}: Omit<SkillImportDialogProps, "open" | "onOpenChange"> & { onClose: () => void }) {
	const zipInputRef = useRef<HTMLInputElement>(null);
	const [zipFile, setZipFile] = useState<File | null>(null);

	const chooseDirectory = async () => {
		setZipFile(null);
		if (zipInputRef.current) zipInputRef.current.value = "";
		await onPickDirectory();
	};

	const chooseZip = (file: File | undefined) => {
		if (!file) return;
		setZipFile(file);
		onPathChange("");
	};

	const clearZip = () => {
		setZipFile(null);
		if (zipInputRef.current) zipInputRef.current.value = "";
	};

	const submit = async () => {
		if (zipFile) await onImportZip(zipFile);
		else await onImportPath();
	};

	const hasSource = Boolean(zipFile || path.trim());

	return (
		<DialogContent className="skill-import-dialog sm:max-w-[580px]">
			<DialogHeader className="skill-import-header">
				<div className="skill-import-heading-icon" aria-hidden="true"><SparklesIcon /></div>
				<div className="min-w-0">
					<DialogTitle>导入 Skill</DialogTitle>
					<DialogDescription>
						从本地目录、单个 SKILL.md 或 ZIP 包导入到全局 Skill 库，并与 pi CLI 共享。
					</DialogDescription>
				</div>
			</DialogHeader>

			<div className="skill-import-body">
				<label className="skill-import-field">
					<span className="skill-import-label">本地路径</span>
					<Input
						value={path}
						onChange={(event) => {
							clearZip();
							onPathChange(event.target.value);
						}}
						placeholder="/path/to/skill 或 /path/to/SKILL.md"
						className="skill-import-path"
						disabled={importing}
					/>
				</label>

				<div className="skill-import-picker-grid">
					<button type="button" className="skill-import-picker" disabled={importing} onClick={() => void chooseDirectory()}>
						<span className="skill-import-picker-icon"><FolderOpenIcon /></span>
						<span className="skill-import-picker-copy">
							<strong>选择目录</strong>
							<small>目录内包含 SKILL.md</small>
						</span>
					</button>

					<input
						ref={zipInputRef}
						type="file"
						accept=".zip,application/zip"
						className="hidden"
						onChange={(event) => chooseZip(event.target.files?.[0])}
					/>
					<button
						type="button"
						className={`skill-import-picker${zipFile ? " is-selected" : ""}`}
						disabled={importing}
						onClick={() => zipInputRef.current?.click()}
					>
						<span className="skill-import-picker-icon"><FileArchiveIcon /></span>
						<span className="skill-import-picker-copy">
							<strong>{zipFile ? zipFile.name : "选择 ZIP 包"}</strong>
							<small>{zipFile ? "已选择，点击可更换" : "支持批量导入多个 Skill"}</small>
						</span>
					</button>
				</div>

				<p className="skill-import-note">重名 Skill 会自动跳过；启用范围仍由各 Agent 配置决定。</p>
			</div>

			<DialogFooter className="skill-import-footer">
				<Button type="button" variant="ghost" disabled={importing} onClick={onClose}>取消</Button>
				<Button type="button" disabled={importing || !hasSource} onClick={() => void submit()}>
					{importing ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
					导入
				</Button>
			</DialogFooter>
		</DialogContent>
	);
}
