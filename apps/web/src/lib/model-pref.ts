// Preferred model reference (`${provider}/${modelId}`) for new sessions. The
// composer writes it only after the current Session confirms a model change.
const STORAGE_KEY = "puddingteams-model";

export function getPreferredModel(): string | null {
	if (typeof window === "undefined") return null;
	try { return localStorage.getItem(STORAGE_KEY); }
	catch { return null; }
}

export function setPreferredModel(ref: string): void {
	try { localStorage.setItem(STORAGE_KEY, ref); }
	catch { /* 当前标签中的模型选择仍可使用 */ }
}
