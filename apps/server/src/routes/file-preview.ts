import type { FileHandle } from "node:fs/promises";

export const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;

export const TEXT_PREVIEW_EXTENSIONS = new Set([
	".md", ".mdx", ".txt", ".log", ".json", ".jsonl", ".csv", ".tsv",
	".yaml", ".yml", ".toml", ".xml", ".html", ".css", ".js", ".jsx",
	".ts", ".tsx", ".py", ".sh", ".zsh", ".sql", ".rs", ".go", ".java",
]);

/** Read through the already validated descriptor; one extra byte distinguishes a full preview from a truncated one. */
export async function readBoundedPreviewBytes(handle: FileHandle): Promise<Buffer | undefined> {
	const buffer = Buffer.alloc(TEXT_PREVIEW_LIMIT + 1);
	let length = 0;
	while (length < buffer.length) {
		const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
		if (bytesRead === 0) break;
		length += bytesRead;
	}
	return length > TEXT_PREVIEW_LIMIT ? undefined : buffer.subarray(0, length);
}
