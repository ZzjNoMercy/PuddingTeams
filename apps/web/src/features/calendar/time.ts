export function validDay(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && value >= "1900-01-01" && value <= "9999-12-31" && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
export function plusDay(day: string, amount: number): string { const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); }
export function weekStart(day: string): string { return plusDay(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7)); }
export function wallTime(instant: string | number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(instant));
	const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
	return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
/** Round-trip candidate offsets through Intl. Gaps have zero matches; folds have two. */
export function resolveWallTime(local: string, timeZone: string, fold: "reject" | "earlier" | "later" = "reject"): string {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) || !validDay(local.slice(0, 10)) || +local.slice(11, 13) > 23 || +local.slice(14, 16) > 59) throw new Error("请输入有效日期和时间");
	const nominal = Date.parse(`${local}:00Z`), offsets = new Set<number>();
	for (let h = -48; h <= 48; h += 6) { const sample = nominal + h * 3600_000; offsets.add(Date.parse(`${wallTime(sample, timeZone)}:00Z`) - sample); }
	const matches = [...offsets].map((offset) => nominal - offset).filter((value) => wallTime(value, timeZone) === local).sort((a, b) => a - b);
	if (!matches.length) throw new Error("此时区的夏令时跳变使该时间不存在，请选择其他时间");
	if (matches.length > 1 && fold === "reject") throw new Error("此时间因夏令时回拨出现两次，请选择第一次或第二次");
	return new Date(fold === "later" ? matches.at(-1)! : matches[0]!).toISOString();
}

/** A civil day can begin after 00:00 during a DST jump. Never use host timezone. */
export function dayBoundary(day: string, timeZone: string): string {
	for (let minute = 0; minute <= 180; minute++) {
		try { return resolveWallTime(`${day}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`, timeZone, "earlier"); }
		catch { /* Find the first actual minute of this civil day. */ }
	}
	throw new Error("无法解析当前日历区间的时区边界，请选择其他日期");
}
