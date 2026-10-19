/** 当前 model turn 从稳定消息时间戳起已经过的整秒数。 */
export function thinkingElapsedSeconds(startedAt: number, now = Date.now()): number {
	return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/** 「12 秒」「1 分 6 秒」：折叠行只留一行状态，用中文时长替代秒数。 */
export function formatThinkingDuration(seconds: number): string {
	if (seconds < 60) return `${seconds} 秒`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}
