/** Passive layout changes never override a reader's pause. */
export function conversationScrollTarget(paused: boolean, readingTop: number, bottom: number): number {
	return paused ? readingTop : bottom;
}

export function shouldResumeConversationScroll({ paused, previousTop, top, bottom, userGesture, resizing }: {
	paused: boolean; previousTop: number; top: number; bottom: number; userGesture: boolean; resizing: boolean;
}): boolean {
	return paused && top > previousTop && userGesture && !resizing && bottom - top <= 24;
}
