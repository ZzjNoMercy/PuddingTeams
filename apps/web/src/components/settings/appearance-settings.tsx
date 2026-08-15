"use client";

import { useSyncExternalStore } from "react";
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
	const dark = theme === "dark" || (theme === "system" && typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);

	const toggleMotion = () => {
		const next = !reduceMotion;
		document.documentElement.dataset.reduceMotion = next ? "true" : "false";
		localStorage.setItem(MOTION_STORAGE_KEY, next ? "1" : "0");
		window.dispatchEvent(new Event(MOTION_EVENT));
	};

	return (
		<div className="appearance-settings">
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
		</div>
	);
}
