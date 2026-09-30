"use client";

import { useEffect, useState } from "react";
import { listWikiBatchPage, type WikiBatchPage } from "./api";

export const WIKI_REVIEW_CHANGED = "pudding:wiki-review-changed";
let inFlight: Promise<WikiBatchPage> | null = null;

/** Counts always cover the full owner-visible queue, independent of the open vault. */
export function useWikiReviewQueue(refreshKey = 0) {
	const [page, setPage] = useState<WikiBatchPage | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let active = true;
		let loading = false;
		const refresh = async () => {
			if (document.visibilityState !== "visible" || loading) return;
			loading = true;
			try {
				inFlight ??= listWikiBatchPage({ limit: 1 }).finally(() => { inFlight = null; });
				const next = await inFlight;
				if (active) { setPage(next); setError(null); }
			} catch (cause) {
				if (active) { setPage(null); setError(cause instanceof Error ? cause.message : String(cause)); }
			} finally { loading = false; }
		};
		void refresh();
		const timer = window.setInterval(() => void refresh(), 4000);
		window.addEventListener(WIKI_REVIEW_CHANGED, refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			active = false;
			window.clearInterval(timer);
			window.removeEventListener(WIKI_REVIEW_CHANGED, refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [refreshKey]);
	return { error, pendingCount: page?.pendingCount ?? null };
}
