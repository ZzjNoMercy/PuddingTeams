import { readCandidateBatch } from "../candidate.js";
import type { CompileJobStore } from "../compile-jobs.js";
import type { ReviewStore } from "./review-store.js";

/** Durable promotion runs at job completion and startup, so opening the review UI is not required. */
export async function syncCandidateBatches(deps: {
	jobs: Pick<CompileJobStore, "list">;
	reviews: ReviewStore;
}, ownerId?: string): Promise<{ registered: number; unavailable: string[] }> {
	let registered = 0;
	const unavailable: string[] = [];
	for (const job of await deps.jobs.list()) {
		if ((ownerId && job.ownerId !== ownerId) || job.status !== "candidate_ready" || !job.candidateBatchId) continue;
		if (await deps.reviews.get(job.candidateBatchId)) continue;
		try {
			const batch = await readCandidateBatch(job);
			if (batch.id !== job.candidateBatchId || batch.bindingId !== job.targetBindingId) throw new Error("candidate identity mismatch");
			await deps.reviews.registerCandidate(batch, job.ownerId);
			registered++;
		} catch {
			unavailable.push(job.id);
		}
	}
	return { registered, unavailable };
}
