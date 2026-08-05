// Preferred model reference (`${provider}/${modelId}`), shared by the new-session
// flow (page) and the per-session composer picker.
const STORAGE_KEY = "puddingteams-model";

export function getPreferredModel(): string | null {
	if (typeof window === "undefined") return null;
	return localStorage.getItem(STORAGE_KEY);
}

export function setPreferredModel(ref: string): void {
	localStorage.setItem(STORAGE_KEY, ref);
}
