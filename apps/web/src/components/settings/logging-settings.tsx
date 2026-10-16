"use client";

import { useEffect, useState } from "react";
import { DownloadIcon, LoaderIcon, ScrollTextIcon } from "lucide-react";
import { toast } from "sonner";
import { SERVER_URL, getLoggingSettings, setLoggingSettings, type LogLevel, type LoggingSettingsSnapshot } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { PreferenceSwitch } from "./preference-switch";

const LEVELS: Array<{ id: LogLevel; label: string; hint: string }> = [
	{ id: "error", label: "仅错误", hint: "只记录失败，最省空间。" },
	{ id: "warn", label: "警告", hint: "错误，加上降级、超时与异常。" },
	{ id: "info", label: "信息", hint: "推荐。再加启动、生命周期与请求。" },
	{ id: "debug", label: "调试", hint: "最详细；只在排障时临时打开。" },
];

/** 设置 → 日志：开关与级别立即生效（后端运行时改级，不需要重启）。 */
export function LoggingSettingsPanel() {
	const [snapshot, setSnapshot] = useState<LoggingSettingsSnapshot | null>(null);
	const [busy, setBusy] = useState(false);
	const [exporting, setExporting] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void getLoggingSettings()
			.then((value) => { if (active) { setSnapshot(value); setError(null); } })
			.catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "日志设置读取失败"); })
			.finally(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, []);

	const apply = async (input: { enabled?: boolean; level?: LogLevel }, message: string) => {
		setBusy(true);
		setError(null);
		try {
			setSnapshot(await setLoggingSettings(input));
			toast.success(message);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "日志设置保存失败");
		} finally {
			setBusy(false);
		}
	};

	const enabled = snapshot?.logging.enabled ?? true;
	const level = snapshot?.logging.level ?? "info";

	/**
	 * 导出诊断包：走服务端 `/api/diagnostics/logs/bundle`，由后端统一决定包含
	 * 什么（运行标识 + 日志尾部，不含密钥）。用 fetch+blob 而不是直接导航，
	 * 这样打包失败能给出可读错误而不是跳走页面。
	 */
	const exportBundle = async () => {
		setExporting(true);
		setError(null);
		try {
			const response = await fetch(`${SERVER_URL}/api/diagnostics/logs/bundle`, { cache: "no-store" });
			if (!response.ok) throw new Error(`导出失败：HTTP ${response.status}`);
			const blob = await response.blob();
			const name = /filename="?([^";]+)"?/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "puddingteams-logs.json";
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = name;
			anchor.click();
			URL.revokeObjectURL(url);
			toast.success("诊断包已下载，可直接发给支持方");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "导出诊断包失败");
		} finally {
			setExporting(false);
		}
	};

	return (
		<div className="settings-content-column [&>section+section]:mt-4">
			<div className="settings-section-heading">
				<h2>日志</h2>
				<p>控制后端写入多少日志。改动立即生效，不需要重启。</p>
			</div>
			<section className="settings-card space-y-5">
				<div className="flex items-center gap-2 text-sm font-medium">
					<ScrollTextIcon className="size-4 text-primary" />
					{busy ? "正在应用…" : enabled ? `正在记录日志 · ${snapshot?.effectiveLevel ?? level}` : "已关闭日志记录"}
					{loading ? <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" /> : null}
				</div>
				<div className="preference-row">
					<div>
						<strong>记录日志</strong>
						<span>关闭后后端不写任何一行（含 Agent、扩展的 console 输出）；排障时请先打开。</span>
					</div>
					<PreferenceSwitch
						checked={enabled}
						label="记录日志"
						disabled={busy || !snapshot}
						onToggle={() => void apply({ enabled: !enabled }, enabled ? "已关闭日志记录" : "已开始记录日志")}
					/>
				</div>
				<div className="space-y-2">
					<strong className="text-[13px] font-medium">级别</strong>
					<div className="harness-choice-grid harness-choice-grid-two" role="radiogroup" aria-label="日志级别">
						{LEVELS.map((item) => <button
							key={item.id}
							type="button"
							role="radio"
							aria-checked={level === item.id}
							data-active={level === item.id ? "true" : "false"}
							className="harness-choice"
							disabled={busy || !snapshot || !enabled}
							onClick={() => void apply({ level: item.id }, `日志级别已切换为「${item.label}」`)}
						>
							<strong>{item.label}{level === item.id ? <span>当前</span> : null}</strong>
							<small>{item.hint}</small>
						</button>)}
					</div>
				</div>
				<p className="text-xs leading-relaxed text-muted-foreground">
					日志文件：{snapshot?.logFile
					? <span className="font-mono break-all">{snapshot.logFile}</span>
					: "开发态输出到终端；发行版由启动器写入 ~/.puddingteams/logs/server.log"}
					。文件超过上限会轮转为同目录的 <span className="font-mono">.1</span>（只保留一份历史）。
				</p>
				<div className="flex items-center justify-between gap-3 border-t border-border/60 pt-4">
					<p className="text-xs leading-relaxed text-muted-foreground">
						排障需要外部协助时，导出诊断包：包含运行标识、日志级别与日志尾部（各 1 MiB，不含密钥或会话内容）。
					</p>
					<Button type="button" variant="outline" disabled={exporting} onClick={() => void exportBundle()}>
						{exporting ? <LoaderIcon className="size-4 animate-spin" /> : <DownloadIcon className="size-4" />}
						导出诊断包
					</Button>
				</div>
				{error ? <p role="alert" className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}
			</section>
		</div>
	);
}
