"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon, Layers3Icon, RefreshCwIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getKnowledgeSelection, listKnowledgeBindings, updateKnowledgeSelection, type KnowledgeBindingSummary, type KnowledgeSelectionSummary } from "@/lib/api";
import { MEMORY_SETUP_COMPLETED_EVENT } from "@/features/knowledge/memory-onboarding";

/** Session identity fixes the selection across cwd changes and prevents room cross-talk. */
export function SessionKnowledgePicker({ sessionId, disabled, onSavingChange }: {
	sessionId: string;
	disabled: boolean;
	onSavingChange: (saving: boolean) => void;
}) {
	const contextKey = `session:${sessionId}`;
	const [value, setValue] = useState<{ key: string; bindings: KnowledgeBindingSummary[]; selection: KnowledgeSelectionSummary } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [nonce, setNonce] = useState(0);
	const currentKey = useRef(contextKey);
	useLayoutEffect(() => { currentKey.current = contextKey; }, [contextKey]);
	const savingRef = useRef(false);
	const current = value?.key === contextKey ? value : null;
	const selected = new Set(current?.selection.selectedBindingIds ?? []);
	const loading = !current && !error;
	useEffect(() => {
		const refresh = () => setNonce((previous) => previous + 1);
		window.addEventListener(MEMORY_SETUP_COMPLETED_EVENT, refresh);
		return () => window.removeEventListener(MEMORY_SETUP_COMPLETED_EVENT, refresh);
	}, []);

	useEffect(() => {
		let active = true;
		void Promise.all([listKnowledgeBindings(), getKnowledgeSelection(contextKey)]).then(([bindings, selection]) => {
			if (active) { setValue({ key: contextKey, bindings: bindings.filter((binding) => binding.availability !== "revoked"), selection }); setError(null); }
		}).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
		return () => { active = false; };
	}, [contextKey, nonce]);

	const toggle = async (bindingId: string, checked: boolean) => {
		if (!current || disabled || savingRef.current) return;
		const next = new Set(current.selection.selectedBindingIds);
		if (checked) next.add(bindingId); else next.delete(bindingId);
		savingRef.current = true;
		setSaving(true);
		onSavingChange(true);
		try {
			const selection = await updateKnowledgeSelection(current.selection, [...next]);
			if (currentKey.current === contextKey) { setValue({ ...current, selection }); setError(null); }
		} catch (cause) {
			if (currentKey.current === contextKey) {
				setError(cause instanceof Error ? cause.message : String(cause));
				// A concurrent revision/response loss must be reconciled before the next toggle.
				setNonce((previous) => previous + 1);
			}
		} finally {
			savingRef.current = false;
			if (currentKey.current === contextKey) { setSaving(false); onSavingChange(false); }
		}
	};

	const label = saving ? "保存知识库…" : loading ? "读取知识库…" : selected.size > 0 ? `${selected.size} 个知识库` : "选择知识库";
	return <DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="m1-workbench-knowledge session-knowledge-trigger" disabled={disabled || loading || saving} aria-label={`会话知识库：${label}`} title="当前会话可访问的知识库"><Layers3Icon size={14} /><span>{label}</span><ChevronDownIcon size={12} /></button></DropdownMenuTrigger><DropdownMenuContent align="start" className="m1-workbench-knowledge-menu">
		{error ? <><DropdownMenuItem disabled>{error}</DropdownMenuItem><DropdownMenuItem onSelect={() => setNonce((previous) => previous + 1)}><RefreshCwIcon size={13} />重试读取知识库</DropdownMenuItem></> : null}
		{current?.bindings.length === 0 ? <DropdownMenuItem disabled>还没有已接入的知识库</DropdownMenuItem> : null}
		{current?.bindings.map((binding) => <DropdownMenuCheckboxItem key={binding.id} checked={selected.has(binding.id)} disabled={saving || disabled || (binding.availability !== "available" && !selected.has(binding.id))} onSelect={(event) => event.preventDefault()} onCheckedChange={(checked) => void toggle(binding.id, checked === true)}><span className="m1-workbench-knowledge-item"><strong>{binding.name}{binding.availability !== "available" ? " · 离线" : ""}</strong>{binding.description ? <small>{binding.description}</small> : null}</span></DropdownMenuCheckboxItem>)}
	</DropdownMenuContent></DropdownMenu>;
}
