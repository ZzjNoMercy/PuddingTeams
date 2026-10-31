"use client";

import { useEffect, useState } from "react";
import { listMemos } from "./memos";

export const MEMO_CHANGED_EVENT = "pudding-memos-changed";

export function notifyMemosChanged(): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new Event(MEMO_CHANGED_EVENT));
}

/** 侧栏徽标只统计未整理；30 秒与重新可见时刷新，窗口事件只做即时更新。 */
export function useMemoInboxCount(): number | null {
	const [count, setCount] = useState<number | null>(null);
	useEffect(() => {
		let active = true;
		let sequence = 0;
		const refresh = () => {
			const current = ++sequence;
			void listMemos({ filter: "unorganized", limit: 1 })
				.then((data) => { if (active && current === sequence) setCount(data.counts.unorganized); })
				// 失败保留上一次成功值，不把徽标错误隐藏。
				.catch(() => undefined);
		};
		refresh();
		const timer = setInterval(refresh, 30_000);
		const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
		window.addEventListener(MEMO_CHANGED_EVENT, refresh);
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			active = false;
			clearInterval(timer);
			window.removeEventListener(MEMO_CHANGED_EVENT, refresh);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, []);
	return count;
}
