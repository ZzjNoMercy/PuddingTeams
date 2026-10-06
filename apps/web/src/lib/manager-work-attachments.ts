const drafts = new Map<string, File[]>();
const pendingSubmissions = new Map<string, { operationId: string; files: File[] }>();

/** Keep selected files across same-tab project changes without putting their bytes in localStorage. */
export function loadManagerWorkAttachments(key: string): File[] {
	return [...(drafts.get(key) ?? [])];
}

export function saveManagerWorkAttachments(key: string, files: File[]): void {
	if (files.length) drafts.set(key, [...files]);
	else drafts.delete(key);
}

/** File identity for a submitted operation survives same-tab project navigation only. */
export function loadPendingManagerWorkAttachments(key: string, operationId: string): File[] | null {
	const pending = pendingSubmissions.get(key);
	return pending?.operationId === operationId ? [...pending.files] : null;
}

export function savePendingManagerWorkAttachments(key: string, operationId: string, files: File[]): void {
	pendingSubmissions.set(key, { operationId, files: [...files] });
}

export function clearPendingManagerWorkAttachments(key: string, operationId: string): void {
	if (pendingSubmissions.get(key)?.operationId === operationId) pendingSubmissions.delete(key);
}

export function clearSubmittedManagerWorkAttachments(key: string, submitted: File[]): void {
	const current = drafts.get(key) ?? [];
	const sent = new Set(submitted);
	saveManagerWorkAttachments(key, current.filter((file) => !sent.has(file)));
}

export function validateManagerWorkAttachments(files: File[]): string | null {
	if (files.length > 5) return "单次最多添加 5 个附件";
	if (files.some((file) => file.size === 0)) return "不能添加空文件";
	if (files.some((file) => file.size > 8 * 1024 * 1024)) return "每个附件不能超过 8MB";
	if (files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) return "附件总大小不能超过 20MB";
	return null;
}

async function fingerprintBytes(bytes: ArrayBuffer): Promise<string> {
	if (globalThis.crypto?.subtle) {
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	// Remote HTTP browsers may lack SubtleCrypto. This is only a local retry hint;
	// the server still checks the full SHA-256 upload identity before reusing a key.
	let hash = BigInt("0xcbf29ce484222325");
	for (const byte of new Uint8Array(bytes)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * BigInt("0x100000001b3"));
	return `fnv64-${hash.toString(16).padStart(16, "0")}`;
}

/** Persist only content identities; selected File bytes remain in browser memory. */
export async function fingerprintManagerWorkAttachments(files: File[]): Promise<string[]> {
	return Promise.all(files.map(async (file) => {
		const contentHash = await fingerprintBytes(await file.arrayBuffer());
		return JSON.stringify([file.name, file.type || "application/octet-stream", file.size, contentHash]);
	}));
}

export function sameManagerWorkAttachments(current: string[], pending: string[] | undefined): boolean {
	return Boolean(pending && current.length === pending.length && current.every((fingerprint, index) => fingerprint === pending[index]));
}

export async function encodeManagerWorkAttachment(file: File): Promise<{ filename: string; mediaType: string; data: string }> {
	const data = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error(`读取附件「${file.name}」失败`));
		reader.onload = () => {
			const value = String(reader.result);
			const comma = value.indexOf(",");
			if (!value.startsWith("data:") || comma < 0) reject(new Error(`读取附件「${file.name}」失败`));
			else resolve(value.slice(comma + 1));
		};
		reader.readAsDataURL(file);
	});
	return { filename: file.name, mediaType: file.type || "application/octet-stream", data };
}
