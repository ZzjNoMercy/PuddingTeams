import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export interface SourceManifestInspection {
	entries: number;
	verifiedHashes: number;
	diagnostics: Array<{ line: number; code: "invalid_json" | "invalid_entry" | "unsafe_path" | "duplicate_path" | "missing_snapshot" | "hash_mismatch" }>;
}

/** Read-only diagnostic for the existing raw/manifest.jsonl convention. It grants no capability. */
export async function inspectSourceManifest(bindingRoot: string, verifyHashes = false): Promise<SourceManifestInspection> {
	const rawRoot = path.join(bindingRoot, "raw");
	const manifest = path.join(rawRoot, "manifest.jsonl");
	const rawStat = await lstat(rawRoot);
	const manifestStat = await lstat(manifest);
	if (!rawStat.isDirectory() || rawStat.isSymbolicLink() || manifestStat.isSymbolicLink()) throw new Error("source manifest root must not be a symlink");
	if (!manifestStat.isFile() || manifestStat.size > 20 * 1024 * 1024) throw new Error("source manifest must be a bounded file");
	const lines = (await readFile(manifest, "utf8")).split(/\r?\n/);
	if (lines.length > 100_001) throw new Error("source manifest has too many entries");
	const result: SourceManifestInspection = { entries: 0, verifiedHashes: 0, diagnostics: [] };
	const seen = new Set<string>();
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue;
		const lineNumber = index + 1;
		result.entries++;
		let value: unknown;
		try { value = JSON.parse(line); }
		catch { result.diagnostics.push({ line: lineNumber, code: "invalid_json" }); continue; }
		if (!value || typeof value !== "object") { result.diagnostics.push({ line: lineNumber, code: "invalid_entry" }); continue; }
		const entry = value as Record<string, unknown>;
		if (typeof entry.source_id !== "string" || !entry.source_id || typeof entry.snapshot_path !== "string" ||
			typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
			result.diagnostics.push({ line: lineNumber, code: "invalid_entry" }); continue;
		}
		const relative = entry.snapshot_path;
		const parts = relative.split("/");
		if (relative.startsWith("/") || /^[A-Za-z]:/.test(relative) || relative.includes("\\") || relative.includes("\0") ||
			parts.some((part) => !part || part === "." || part === "..")) {
			result.diagnostics.push({ line: lineNumber, code: "unsafe_path" }); continue;
		}
		if (seen.has(relative)) { result.diagnostics.push({ line: lineNumber, code: "duplicate_path" }); continue; }
		seen.add(relative);
		let current = rawRoot;
		let safe = true;
		for (const [partIndex, part] of parts.entries()) {
			current = path.join(current, part);
			const info = await lstat(current).catch(() => null);
			if (!info) { result.diagnostics.push({ line: lineNumber, code: "missing_snapshot" }); safe = false; break; }
			if (info.isSymbolicLink() || (partIndex < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
				result.diagnostics.push({ line: lineNumber, code: "unsafe_path" }); safe = false; break;
			}
		}
		if (!safe || !verifyHashes) continue;
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(current)) hash.update(chunk);
		if (hash.digest("hex") !== entry.sha256) result.diagnostics.push({ line: lineNumber, code: "hash_mismatch" });
		else result.verifiedHashes++;
	}
	return result;
}
