/** 会话/窗口时间的紧凑展示（微信会话列表同款阶梯）。 */

/** 列表用：今天显示具体时刻，其余按 昨天/周X/月日 降级。 */
export function compactTime(value?: string | number): string {
	if (!value) return "刚刚";
	const date = new Date(value);
	const now = new Date();
	const delta = now.getTime() - date.getTime();
	if (delta < 60_000) return "刚刚";
	if (date.toDateString() === now.toDateString()) {
		return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
	}
	return compactDay(date);
}

/** 天粒度（会话分隔条用）：今天/昨天/周X/月日。 */
export function compactDay(value: string | number | Date): string {
	const date = value instanceof Date ? value : new Date(value);
	const now = new Date();
	if (date.toDateString() === now.toDateString()) return "今天";
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (date.toDateString() === yesterday.toDateString()) return "昨天";
	if (now.getTime() - date.getTime() < 7 * 24 * 60 * 60 * 1000) {
		return `周${"日一二三四五六"[date.getDay()]}`;
	}
	return `${date.getMonth() + 1}/${date.getDate()}`;
}
