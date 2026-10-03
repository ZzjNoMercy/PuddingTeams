export interface CalendarSelection { providerId: string; id: string; name: string; visible: boolean }
export const calendarSelectionKey = (source: CalendarSelection) => JSON.stringify([source.providerId, source.id]);

/** Adding calendars never replaces another selection or changes its visibility. */
export function appendCalendarSelections(current: CalendarSelection[], added: CalendarSelection[]): CalendarSelection[] {
	const result = [...current], seen = new Set(current.map(calendarSelectionKey));
	for (const source of added) {
		const key = calendarSelectionKey(source);
		if (!seen.has(key)) { seen.add(key); result.push(source); }
	}
	return result;
}

export function calendarSourceLabel(event: { sourceId: string; providerName?: string; sourceName?: string }): string {
	if (event.sourceId === "platform") return "平台日历";
	return `${event.providerName ?? "外部日历"} · ${event.sourceName ?? "日历"}`;
}
