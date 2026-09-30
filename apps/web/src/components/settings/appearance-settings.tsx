"use client";

import { useSyncExternalStore } from "react";
import { CheckCircle2Icon } from "lucide-react";
import { toast } from "sonner";
import { useTheme } from "@/components/theme-provider";

const MOTION_STORAGE_KEY = "puddingteams:reduce-motion";
const MOTION_EVENT = "puddingteams:motion-change";

function subscribeMotion(listener: () => void) {
	window.addEventListener(MOTION_EVENT, listener);
	return () => window.removeEventListener(MOTION_EVENT, listener);
}

function getMotionSnapshot() {
	return document.documentElement.dataset.reduceMotion === "true";
}

function subscribeSystemTheme(listener: () => void) {
	const media = window.matchMedia("(prefers-color-scheme: dark)");
	media.addEventListener("change", listener);
	return () => media.removeEventListener("change", listener);
}

function getSystemDarkSnapshot() {
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function PreferenceSwitch({ checked, label, onToggle }: { checked: boolean; label: string; onToggle: () => void }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			className="preference-switch"
			data-checked={checked ? "true" : "false"}
			onClick={onToggle}
		>
			<span />
		</button>
	);
}

export function AppearanceSettings() {
	const { theme, setTheme } = useTheme();
	const reduceMotion = useSyncExternalStore(subscribeMotion, getMotionSnapshot, () => false);
	const systemDark = useSyncExternalStore(subscribeSystemTheme, getSystemDarkSnapshot, () => false);
	const dark = theme === "dark" || (theme === "system" && systemDark);

	const toggleMotion = () => {
		const next = !reduceMotion;
		document.documentElement.dataset.reduceMotion = next ? "true" : "false";
		try { localStorage.setItem(MOTION_STORAGE_KEY, next ? "1" : "0"); } catch { /* Keep this tab's preference usable without persistence. */ }
		window.dispatchEvent(new Event(MOTION_EVENT));
	};

	return (
		<div className="appearance-settings">
			<div className="appearance-theme-cards" role="group" aria-label="界面主题">
				{(["light", "dark"] as const).map((option) => {
					const selected = (option === "dark") === dark;
					return <button key={option} type="button" className="appearance-theme-card" data-preview={option} aria-pressed={selected} onClick={() => setTheme(option)}>
						<span className="appearance-theme-mini" aria-hidden="true"><span /><span><i /><i /><i /></span></span>
						<span className="appearance-theme-label">{option === "light" ? "浅色" : "深色"}{selected ? <CheckCircle2Icon className="size-4" aria-hidden="true" /> : null}</span>
					</button>;
				})}
			</div>
			<div className="preference-row">
				<div>
					<strong>深色模式</strong>
					<span>在浅色与深色界面之间切换</span>
				</div>
				<PreferenceSwitch checked={dark} label="深色模式" onToggle={() => setTheme(dark ? "light" : "dark")} />
			</div>
			<div className="preference-row">
				<div>
					<strong>减少动态效果</strong>
					<span>关闭非必要过渡动画</span>
				</div>
				<PreferenceSwitch checked={reduceMotion} label="减少动态效果" onToggle={toggleMotion} />
			</div>
			<section className="appearance-preview" aria-label="当前主题预览">
				<div className="appearance-preview-heading">预览</div>
				<div className="appearance-preview-surface">
					<span className="appearance-preview-badge">进行中</span>
					<h3>让工作，更有条理。</h3>
					<p>清晰的层次、柔和的底色和统一的青绿色焦点。</p>
					<button type="button" onClick={() => toast.info("这是当前主题下的主要按钮样式")}>主要操作</button>
				</div>
			</section>
		</div>
	);
}
