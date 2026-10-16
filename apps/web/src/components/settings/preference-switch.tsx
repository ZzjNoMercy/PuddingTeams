"use client";

/** 设置页通用开关（外观与日志共用同一套样式与语义）。 */
export function PreferenceSwitch({ checked, label, onToggle, disabled }: { checked: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			className="preference-switch"
			data-checked={checked ? "true" : "false"}
			disabled={disabled}
			onClick={onToggle}
		>
			<span />
		</button>
	);
}
