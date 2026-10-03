import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeBindingRegistry } from "./bindings.js";
import type { KnowledgeAcceptanceStore } from "./acceptance.js";
import { hashBufferSha256, MAX_HASH_BYTES } from "./hashing.js";
import { withKnowledgeMutation } from "./mutation-lock.js";
import { readNoteBytes, resolveNoteAbsolutePath, type KnowledgeObservationService } from "./observation.js";

export class NoteWriteError extends Error {
	constructor(readonly code: "invalid_input" | "baseline_conflict" | "too_large", message: string) { super(message); }
}

/** Human edits change the registered Markdown file directly; never create an Agent candidate. */
export async function writeKnowledgeNote(registry: KnowledgeBindingRegistry, observation: KnowledgeObservationService, acceptance: KnowledgeAcceptanceStore,
	ownerId: string, bindingId: string, input: { path: string; content: string; expectedHash: string }) {
	if (typeof input.path !== "string" || typeof input.content !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedHash ?? "")) {
		throw new NoteWriteError("invalid_input", "保存需要笔记内容和当前文件版本");
	}
	const bytes = Buffer.from(input.content, "utf8");
	if (bytes.length > MAX_HASH_BYTES) throw new NoteWriteError("too_large", "笔记超过 2 MiB 保存上限");
	return withKnowledgeMutation(bindingId, async () => {
		const binding = await registry.requireUsable(ownerId, bindingId);
		// Freeze the before version and refuse effects awaiting publication reconciliation.
		const scan = await observation.scanWithinMutation(binding);
		if (scan.files.get(input.path)?.state === "publishing") throw new NoteWriteError("baseline_conflict", "这篇笔记正在发布，请稍后重新打开再编辑");
		const target = await resolveNoteAbsolutePath(binding, input.path);
		const before = await lstat(target);
		if (before.nlink !== 1) throw new NoteWriteError("invalid_input", "此文件为硬链接，请在本地编辑器中修改");
		if (hashBufferSha256(await readNoteBytes(target)) !== input.expectedHash) throw new NoteWriteError("baseline_conflict", "笔记已被其他操作修改。你的草稿已保留，请重新打开最新版本后再保存");
		const temporary = path.join(path.dirname(target), `.note-edit-${randomUUID()}.tmp`);
		const contentHash = hashBufferSha256(bytes);
		let operationId: string | undefined, written = false;
		try {
			const output = await open(temporary, "wx", before.mode & 0o777);
			try { await output.writeFile(bytes); await output.chmod(before.mode & 0o777); await output.sync(); } finally { await output.close(); }
			await resolveNoteAbsolutePath(binding, input.path);
			const latest = await lstat(target);
			if (latest.dev !== before.dev || latest.ino !== before.ino || latest.nlink !== 1 || latest.mtimeMs !== before.mtimeMs ||
				hashBufferSha256(await readNoteBytes(target)) !== input.expectedHash) throw new NoteWriteError("baseline_conflict", "笔记在保存期间发生变化。你的草稿已保留，请重新打开最新版本");
			operationId = await acceptance.prepareManualEdit(bindingId, input.path, input.expectedHash, contentHash, ownerId);
			// Recheck disk after durable intent persistence, before the actual effect.
			await resolveNoteAbsolutePath(binding, input.path);
			const finalIdentity = await lstat(target);
			if (finalIdentity.dev !== before.dev || finalIdentity.ino !== before.ino || finalIdentity.nlink !== 1 || finalIdentity.mtimeMs !== before.mtimeMs || finalIdentity.ctimeMs !== before.ctimeMs ||
				hashBufferSha256(await readNoteBytes(target)) !== input.expectedHash) throw new NoteWriteError("baseline_conflict", "笔记在保存期间发生变化，请保留草稿后重新打开");
			registry.assertCurrentRevision(ownerId, bindingId, binding);
			await rename(temporary, target);
			written = true;
		} finally {
			await unlink(temporary).catch(() => undefined);
			if (!written && operationId) await acceptance.discardManualEdit(bindingId, input.path, operationId);
		}
		let syncWarning: string | undefined;
		try { await observation.scanWithinMutation(binding); }
		catch { syncWarning = "文件已保存，索引同步暂未完成，可刷新页面重试"; }
		return { note: { path: input.path, content: input.content, size: bytes.length, contentHash, version: "observed" as const, status: "current" as const }, ...(syncWarning ? { syncWarning } : {}) };
	});
}
