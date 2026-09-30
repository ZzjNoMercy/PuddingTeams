import type { HarnessSettings } from "@/lib/api";

/** Keep edits made after a request was sent while advancing the saved baseline. */
export function harnessAfterSave(current: HarnessSettings, submitted: HarnessSettings, saved: HarnessSettings): HarnessSettings {
	return JSON.stringify(current) === JSON.stringify(submitted) ? saved : current;
}
