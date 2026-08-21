import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface WorkerResultContextSettings {
	offloadThresholdTokens: number;
	previewHeadTokens: number;
	previewTailTokens: number;
	readChunkTokens: number;
}
export const DEFAULT_WORKER_RESULT_CONTEXT: WorkerResultContextSettings = {
	offloadThresholdTokens: 20_000,
	previewHeadTokens: 6_000,
	previewTailTokens: 2_000,
	readChunkTokens: 8_000,
};
const CHARS_PER_ESTIMATED_TOKEN = 4;
export function validateWorkerResultContext(input: Partial<WorkerResultContextSettings>): WorkerResultContextSettings {
	const integer = (value: unknown, fallback: number, min: number, max: number, field: string) => {
		const number = value === undefined ? fallback : value;
		if (!Number.isInteger(number) || (number as number) < min || (number as number) > max) throw new Error(field + " 超出安全范围");
		return number as number;
	};
	const settings = {
		offloadThresholdTokens: integer(input.offloadThresholdTokens, DEFAULT_WORKER_RESULT_CONTEXT.offloadThresholdTokens, 4_000, 200_000, "offloadThresholdTokens"),
		previewHeadTokens: integer(input.previewHeadTokens, DEFAULT_WORKER_RESULT_CONTEXT.previewHeadTokens, 500, 40_000, "previewHeadTokens"),
		previewTailTokens: integer(input.previewTailTokens, DEFAULT_WORKER_RESULT_CONTEXT.previewTailTokens, 200, 20_000, "previewTailTokens"),
		readChunkTokens: integer(input.readChunkTokens, DEFAULT_WORKER_RESULT_CONTEXT.readChunkTokens, 500, 40_000, "readChunkTokens"),
	};
	if (settings.previewHeadTokens + settings.previewTailTokens >= settings.offloadThresholdTokens) throw new Error("previewHeadTokens + previewTailTokens 必须小于 offloadThresholdTokens");
	return settings;
}
export interface WorkerResultProjection {
	text: string;
	offloaded: boolean;
	originalChars: number;
	estimatedTokens: number;
	delegationId: string;
	estimation: "ceil(chars/4)";
}
export class LargeWorkerResultStore {
	constructor(private readonly stateDir: string) {}
	private directory(): string { return path.join(this.stateDir, "large-worker-results") }
	private file(delegationId: string): string {
		if (!/^[A-Za-z0-9_-]+$/.test(delegationId)) throw new Error("delegationId 非法");
		return path.join(this.directory(), delegationId + ".txt");
	}
	async project(delegationId: string, content: string, settings: WorkerResultContextSettings): Promise<WorkerResultProjection> {
		const estimatedTokens = Math.ceil(content.length / CHARS_PER_ESTIMATED_TOKEN);
		if (estimatedTokens <= settings.offloadThresholdTokens) {
			return { text: content, offloaded: false, originalChars: content.length, estimatedTokens, delegationId, estimation: "ceil(chars/4)" };
		}
		await mkdir(this.directory(), { recursive: true });
		const file = this.file(delegationId);
		const temp = file + "." + randomUUID().slice(0, 8) + ".tmp";
		await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
		await rename(temp, file);
		await open(file, "r").then(async (handle) => { await handle.chmod(0o600); await handle.close() });
		const headChars = settings.previewHeadTokens * CHARS_PER_ESTIMATED_TOKEN;
		const tailChars = settings.previewTailTokens * CHARS_PER_ESTIMATED_TOKEN;
		const preview = content.slice(0, headChars) + "\n\n…（中间内容已无损外置）…\n\n" + content.slice(-tailChars);
		return {
			text: preview + "\n\n[完整结果已外置] delegationId=" + delegationId + "，originalChars=" + content.length + "，estimatedTokens=" + estimatedTokens + "（估算方法 ceil(chars/4)）。用 read_delegation_result 分页精确读取。",
			offloaded: true,
			originalChars: content.length,
			estimatedTokens,
			delegationId,
			estimation: "ceil(chars/4)",
		};
	}
	async read(delegationId: string, offset: number, limit: number): Promise<{ content: string; offset: number; nextOffset?: number; totalChars: number }> {
		if (!Number.isInteger(offset) || offset < 0) throw new Error("offset 必须是非负整数");
		if (!Number.isInteger(limit) || limit < 1 || limit > 160_000) throw new Error("limit 超出安全范围");
		const content = await readFile(this.file(delegationId), "utf8");
		const chunk = content.slice(offset, offset + limit);
		const next = offset + chunk.length;
		return { content: chunk, offset, ...(next < content.length ? { nextOffset: next } : {}), totalChars: content.length };
	}
}
