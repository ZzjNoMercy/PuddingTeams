"use client";

import type { ReactNode } from "react";
import { RefreshCwIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { KnowledgeBindingSummary } from "@/lib/api";
import styles from "./knowledge-picker-menu.module.css";

/** A multi-select menu, not a modal: outside clicks also reach the input/navigation. */
export function KnowledgePickerMenu({ children, bindings, selected, disabled, saving, error, allowDeselectUnavailable = false, onToggle, onRetry, onCloseAutoFocus }: {
	children: ReactNode;
	bindings: KnowledgeBindingSummary[];
	selected: ReadonlySet<string>;
	disabled: boolean;
	saving: boolean;
	error: string | null;
	allowDeselectUnavailable?: boolean;
	onToggle: (id: string, checked: boolean) => void;
	onRetry?: () => void;
	onCloseAutoFocus?: (event: Event) => void;
}) {
	return <DropdownMenu modal={false}>
		<DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
		<DropdownMenuContent align="start" sideOffset={8} collisionPadding={12} className={styles.menu} aria-label="选择知识库" onCloseAutoFocus={onCloseAutoFocus}>
			{error && <>
				<p className={styles.error} role="alert">{error}</p>
				{onRetry && <DropdownMenuItem onSelect={event => { event.preventDefault(); onRetry(); }}><RefreshCwIcon size={13} />重试读取知识库</DropdownMenuItem>}
			</>}
			{!error && bindings.length === 0 && <DropdownMenuItem disabled>还没有已接入的知识库</DropdownMenuItem>}
			{bindings.map(binding => <DropdownMenuCheckboxItem
				key={binding.id}
				className={styles.option}
				textValue={binding.name}
				title={binding.description || binding.name}
				checked={selected.has(binding.id)}
				disabled={saving || disabled || (binding.availability !== "available" && !(allowDeselectUnavailable && selected.has(binding.id)))}
				onSelect={event => event.preventDefault()}
				onCheckedChange={checked => onToggle(binding.id, checked === true)}
			>
				<span className={styles.text}><strong>{binding.name}{binding.availability !== "available" && <span className={styles.offline}>离线</span>}</strong>{binding.description && <small>{binding.description}</small>}</span>
			</DropdownMenuCheckboxItem>)}
		</DropdownMenuContent>
	</DropdownMenu>;
}
