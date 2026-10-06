"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useStickToBottom, type StickToBottomOptions } from "use-stick-to-bottom";
import { conversationScrollTarget, shouldResumeConversationScroll } from "@/lib/conversation-scroll-policy";

/** Reading intent is not geometry: a shrinking Worker card must not resume following. */
export function useConversationScroll(options: StickToBottomOptions) {
	const pausedRef = useRef(false);
	const [paused, setPaused] = useState(false);
	const requestedTarget = options.targetScrollTop;
	const changePaused = useCallback((value: boolean) => {
		pausedRef.current = value;
		setPaused(value);
	}, []);
	const targetScrollTop = useCallback<NonNullable<StickToBottomOptions["targetScrollTop"]>>((target, elements) => {
		return conversationScrollTarget(pausedRef.current, elements.scrollElement.scrollTop, pausedRef.current ? target : requestedTarget?.(target, elements) ?? target);
	}, [requestedTarget]);
	const instance = useStickToBottom({ ...options, targetScrollTop });
	const { scrollRef, contentRef, scrollToBottom: originalScroll, stopScroll: originalStop, state } = instance;
	const stopScroll = useCallback(() => { changePaused(true); originalStop(); }, [changePaused, originalStop]);
	const scrollToBottom = useCallback<typeof originalScroll>((request = {}) => {
		const preserve = typeof request === "object" && request.preserveScrollPosition;
		if (preserve && pausedRef.current) return false;
		if (!preserve) changePaused(false); // Explicit “back to bottom”, not passive resize.
		return originalScroll(request);
	}, [changePaused, originalScroll]);
	useEffect(() => {
		const viewport = scrollRef.current, content = contentRef.current;
		if (!viewport || !content) return;
		let top = viewport.scrollTop, gestureUntil = 0, touchY: number | null = null, dragging = false;
		const gesture = (up: boolean) => { gestureUntil = Date.now() + 400; if (up && viewport.scrollHeight > viewport.clientHeight) stopScroll(); };
		const wheel = (event: WheelEvent) => {
			let target = event.target instanceof Element ? event.target : null;
			while (target && target !== viewport) {
				if (/(auto|scroll)/.test(getComputedStyle(target).overflowY) && target.scrollHeight > target.clientHeight) return;
				target = target.parentElement;
			}
			if (target === viewport && event.deltaY) gesture(event.deltaY < 0);
		};
		const key = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
			if (["ArrowUp", "PageUp", "Home"].includes(event.key)) gesture(true);
			else if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) gesture(event.key === " " && event.shiftKey);
		};
		const pointerDown = (event: PointerEvent) => { if (event.target === viewport) { dragging = true; gesture(false); } };
		const pointerUp = () => { if (dragging) { dragging = false; gestureUntil = Date.now() + 400; } };
		const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? null; };
		const touchMove = (event: TouchEvent) => {
			const next = event.touches[0]?.clientY ?? null;
			if (next !== null && touchY !== null && next !== touchY) gesture(next > touchY);
			touchY = next;
		};
		const scroll = () => {
			const next = viewport.scrollTop;
			const userGesture = dragging || Date.now() < gestureUntil;
			if (next < top && !state.resizeDifference && !state.animation) stopScroll();
			if (shouldResumeConversationScroll({ paused: pausedRef.current, previousTop: top, top: next, bottom: viewport.scrollHeight - viewport.clientHeight, userGesture, resizing: Boolean(state.resizeDifference) })) {
				changePaused(false);
				void originalScroll({ animation: "instant", preserveScrollPosition: false });
			}
			top = next;
		};
		// The upstream observer re-locks on negative resize. Keep the user's pause,
		// even if the browser has had to clamp scrollTop to the new valid range.
		const observer = new ResizeObserver(() => { if (pausedRef.current) originalStop(); });
		observer.observe(content); observer.observe(viewport);
		viewport.addEventListener("wheel", wheel, { passive: true });
		viewport.addEventListener("keydown", key);
		viewport.addEventListener("scroll", scroll, { passive: true });
		viewport.addEventListener("pointerdown", pointerDown);
		window.addEventListener("pointerup", pointerUp);
		viewport.addEventListener("touchstart", touchStart, { passive: true });
		viewport.addEventListener("touchmove", touchMove, { passive: true });
		return () => {
			observer.disconnect();
			viewport.removeEventListener("wheel", wheel); viewport.removeEventListener("keydown", key);
			viewport.removeEventListener("scroll", scroll); viewport.removeEventListener("pointerdown", pointerDown);
			window.removeEventListener("pointerup", pointerUp);
			viewport.removeEventListener("touchstart", touchStart); viewport.removeEventListener("touchmove", touchMove);
		};
	}, [scrollRef, contentRef, state, stopScroll, originalStop, originalScroll, changePaused]);
	return { ...instance, stopScroll, scrollToBottom, isAtBottom: !paused && instance.isAtBottom };
}
