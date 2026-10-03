import type { CalendarInput } from "./store.js";

export class CalendarProviderError extends Error {
	constructor(readonly code: "authorization_required" | "permission_required" | "not_configured" | "unavailable" | "invalid_input" | "not_found", message: string) { super(message); }
}
export interface CalendarProviderDescriptor {
	id: string;
	name: string;
	description: string;
	color: string;
	readOnly: boolean;
	setupUrl?: string;
	authorization?: { description: string };
}
export interface ExternalCalendarSource { id: string; name: string; type: string; writable: boolean }
export type ExternalCalendarEvent = CalendarInput & { id: string; sourceId: string; readonly: true; appLink?: string };
export interface CalendarAuthorization {
	id: string; state: "pending" | "completed" | "failed" | "expired" | "cancelled";
	expiresAt: string; verificationUrl?: string; qrCodeDataUrl?: string; message?: string;
}
/** Platform read-through adapter; credentials remain owned by each connection authority. */
export interface CalendarProvider {
	descriptor: CalendarProviderDescriptor;
	calendars(): Promise<ExternalCalendarSource[]>;
	events(calendarId: string, start: string, end: string): Promise<ExternalCalendarEvent[]>;
	authorization?: {
		begin(): Promise<CalendarAuthorization>;
		status(id: string): Promise<CalendarAuthorization | undefined>;
		cancel(id: string): Promise<void>;
	};
}
export class CalendarProviderRegistry {
	private readonly providers = new Map<string, CalendarProvider>();
	constructor(providers: CalendarProvider[]) {
		for (const provider of providers) {
			const d = provider.descriptor;
			if (!/^[a-z][a-z0-9-]{0,63}$/.test(d.id) || !/^#[0-9a-f]{6}$/i.test(d.color) || this.providers.has(d.id) || Boolean(d.authorization) !== Boolean(provider.authorization) || (d.setupUrl && (!d.setupUrl.startsWith("/") || d.setupUrl.startsWith("//")))) throw new Error("日历来源声明无效或重复");
			this.providers.set(d.id, provider);
		}
	}
	list(): CalendarProviderDescriptor[] { return [...this.providers.values()].map(p => p.descriptor); }
	get(id: string): CalendarProvider {
		const provider = this.providers.get(id);
		if (!provider) throw new CalendarProviderError("not_found", "日历来源尚未接入");
		return provider;
	}
}
