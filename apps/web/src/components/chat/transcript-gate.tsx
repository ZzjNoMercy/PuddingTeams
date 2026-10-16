"use client";

import { useEffect, useState, type ReactNode } from "react";

export function TranscriptGate({ loading, onReady, onReadinessChange, children }: { loading: boolean; onReady?: () => void; onReadinessChange?: (ready: boolean) => void; children: ReactNode }) {
	const [revealed, setRevealed] = useState(false);
	// Latch once: later live turns must not hide an already visible conversation.
	if (!loading && !revealed) setRevealed(true);
	useEffect(() => { if (revealed) onReady?.(); }, [revealed, onReady]);
	useEffect(() => { onReadinessChange?.(revealed); }, [revealed, onReadinessChange]);
	const waiting = loading && !revealed;
	return <>
		{waiting ? <p role="status" className="py-16 text-center text-sm text-muted-foreground">正在加载对话…</p> : null}
		<div hidden={waiting} aria-busy={waiting} className={waiting ? undefined : "contents"}>{children}</div>
	</>;
}

