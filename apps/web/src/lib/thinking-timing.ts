/** 当前 model turn 从稳定消息时间戳起已经过的整秒数。 */
export function thinkingElapsedSeconds(startedAt: number, now = Date.now()): number {
	return Math.max(0, Math.floor((now - startedAt) / 1000));
}
