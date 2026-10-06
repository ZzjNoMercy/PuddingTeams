import { createHash } from "node:crypto";

export const MAX_HASH_BYTES = 2 * 1024 * 1024;

export function hashBufferSha256(content: Buffer | string): string {
	return createHash("sha256").update(content).digest("hex");
}
