import type { FastifyInstance } from "fastify";
import { lstat } from "node:fs/promises";
import path from "node:path";

/** Explicit, read-only inspection. Boot never reads or drains the removed queue. */
export function registerLegacyDataDiagnostics(app: FastifyInstance, stateRoot: string): void {
 app.get("/api/diagnostics/legacy-data", async () => {
  const file = path.join(stateRoot, "worker-input-queue.json");
  try {
   const stat = await lstat(file);
   return { files: [{ path: file, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), action: "manual_cleanup_only" }], automaticReplay: false };
  } catch (error) {
   if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
   return { files: [], automaticReplay: false };
  }
 });
}
