import { createHash } from "node:crypto";

/** Teams 2.0 M0 wire contract. IDs are opaque; a path or display name is never identity. */
export interface KnowledgeBinding {
	id: string;
	ownerId: string;
	name: string;
	description: string;
	metadataMode: "registry" | "file";
	metadataPath?: string;
	canonicalBindingRoot: string;
	rootIdentity: string;
	contentRoot: string;
	linkRoot: string;
	obsidianRoot?: string;
	schemaRef?: { format: string; id: string; revision: number; hash: string; originPresetId?: string };
	readPolicy: "private" | "workspace";
	publisherRef?: string;
	bindingRevision: number;
	trustRevision: number;
	availability: "available" | "offline" | "revoked";
}

export interface KnowledgeSelection {
	ownerId: string;
	contextKey: string;
	selectedBindingIds: string[];
	/** Explicit per-context opt-outs from installation defaults. */
	excludedDefaultBindingIds?: string[];
	revision: number;
}

export type NoteIdentity =
	| { bindingId: string; declaredNoteId: string; normalizedRelativePath?: never }
	| { bindingId: string; declaredNoteId?: never; normalizedRelativePath: string };

export interface ObservedNoteVersion {
	noteIdentity: NoteIdentity;
	relativePath: string;
	contentHash: string;
	observedAt: string;
	state: "present" | "missing" | "unreadable";
}

export interface AcceptedNoteVersion {
	noteIdentity: NoteIdentity;
	contentHash: string;
	snapshotRef: string;
	acceptedBy: string;
	acceptedAt: string;
	acceptanceId: string;
	schemaHash?: string;
	sourceRefs: string[];
	availability: "current" | "changed" | "missing" | "revoked";
}

export interface KnowledgeContextSnapshot {
	id: string;
	windowId: string;
	sessionId: string;
	runId?: string;
	contextKey: string;
	selectionRevision: number;
	bindingRevisions: Record<string, number>;
	trustRevisions: Record<string, number>;
	acceptedNotes: Array<{ acceptanceId: string; contentHash: string }>;
	ruleRevision?: number;
	evidenceRefs: string[];
	retrievalQuery: string;
	budget: number;
	createdAt: string;
}

export type CompileJobStatus = "queued" | "running" | "candidate_ready" | "failed" | "cancelled";
export interface CompileJob {
	id: string;
	operationId: string;
	ownerId: string;
	targetBindingId: string;
	bindingRevision: number;
	trustRevision: number;
	rootIdentity: string;
	/** Stable accepted-note identities selected for this Job, in source order. */
	sourceAcceptanceIds: string[];
	sourceSnapshotRefs: string[];
	/** Frozen, materialized inputs. Never points at a live Wiki root. */
	sourceSnapshotRoot: string;
	/** Exact tree content at Job creation; rechecked around the Driver run. */
	sourceSnapshotHash: string;
	stagingRoot: string;
	privateRoot: string;
	compilerRef: string;
	compilerPackageSha256: string;
	agentId: string;
	agentRevision: number;
	task: string;
	/** Frozen canonical structure instructions shown to the compiler, when present. */
	schemaContract?: string;
	commandPath: string;
	commandSha256: string;
	schemaHash?: string;
	baseManifestHash: string;
	status: CompileJobStatus;
	revision: number;
	createdAt: string;
	updatedAt: string;
	delegationId?: string;
	candidateBatchId?: string;
	failureCode?: string;
}

export interface PublicationFile {
	/** Binary images are reviewed files, excluded from the Markdown acceptance ledger. */
	kind?: "image";
	mediaType?: string;
	sourceIds?: string[];
	operation: "create" | "update" | "delete";
	targetPath: string;
	expectedHashOrAbsent: string | null;
	candidateHash: string | null;
	blobRef: string | null;
}

export type PublicationBatchStatus = "candidate" | "pending_review" | "approved" | "publishing" | "published" | "partial" | "conflict" | "rejected" | "returned";
export interface PublicationBatch {
	id: string;
	revision: number;
	bindingId: string;
	manifestHash: string;
	rootIdentity: string;
	files: PublicationFile[];
	sourceSnapshots: string[];
	schemaHash?: string;
	/** null freezes absence of a contract; undefined means this compiler has no contract projection. */
	contractHash?: string | null;
	parentBatchId?: string;
	revisionFeedback?: string;
	bindingRevision: number;
	trustRevision: number;
	dependencyGroups: string[][];
	validationReceipt: string;
	compilerVersion: string;
	status: PublicationBatchStatus;
}

export interface ReviewDecision {
	id: string;
	batchId: string;
	revision: number;
	manifestHash: string;
	actorId: string;
	decidedAt: string;
	decision: "approve" | "reject";
	reviewedFiles: string[];
	expectedTargets: string[];
	policyRevision: number;
}

export interface PublishOperation {
	id: string;
	batchId: string;
	reviewId: string;
	idempotencyKey: string;
	journalRef: string;
	state: "queued" | "running" | "published" | "partial" | "conflict" | "unknown";
	results: Array<{ path: string; beforeHash: string | null; afterHash: string | null; status: string; receiptRef?: string }>;
}

interface CalendarEventBase {
	id: string;
	sourceId: string;
	title: string;
	description: string;
	location: string;
	kind: "event" | "focus";
	timeZone: string;
	busy: boolean;
	status: "confirmed" | "cancelled";
	noteRefs: NoteIdentity[];
	revision: number;
	operationId: string;
}
export type CalendarEvent = CalendarEventBase & (
	| { allDay: false; start: string; end: string; startDate?: never; endDateExclusive?: never }
	| { allDay: true; startDate: string; endDateExclusive: string; start?: never; end?: never }
);

export interface AcceptedProjection {
	bindingId: string;
	noteIdentity: NoteIdentity;
	acceptedHash: string;
	mappedFields: Record<string, unknown>;
	evidenceRefs: string[];
}

/** The review hash covers the exact target, bytes, basis and authority revisions. */
export function publicationManifestHash(batch: Omit<PublicationBatch, "manifestHash" | "status">): string {
	const payload = [batch.id, batch.revision, batch.bindingId, batch.rootIdentity, batch.files,
		batch.sourceSnapshots, batch.schemaHash ?? null, batch.bindingRevision, batch.trustRevision,
		batch.dependencyGroups, batch.validationReceipt, batch.compilerVersion];
	if (Object.hasOwn(batch, "contractHash")) payload.push(batch.contractHash ?? null);
	if (batch.parentBatchId !== undefined || batch.revisionFeedback !== undefined) payload.push(batch.parentBatchId ?? null, batch.revisionFeedback ?? null);
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Reject malformed publication plans before a manifest can enter review. */
export function assertPublicationBatchShape(batch: PublicationBatch): void {
	if ((batch.parentBatchId !== undefined || batch.revisionFeedback !== undefined) &&
		(!batch.parentBatchId || !batch.revisionFeedback?.trim() || batch.revisionFeedback.length > 20_000 || batch.parentBatchId === batch.id)) throw new Error("invalid revision lineage");
	if (!batch.id || !batch.bindingId || !batch.rootIdentity || !batch.validationReceipt || !batch.compilerVersion ||
		!Number.isSafeInteger(batch.revision) || batch.revision < 1 || !Number.isSafeInteger(batch.bindingRevision) ||
		!Number.isSafeInteger(batch.trustRevision) || batch.files.length === 0) {
		throw new Error("invalid publication batch header");
	}
	const targets = new Set<string>();
	for (const file of batch.files) {
		const parts = file.targetPath.split("/");
		if (!file.targetPath || file.targetPath.startsWith("/") || /^[A-Za-z]:/.test(file.targetPath) || file.targetPath.includes("\\") ||
			parts.some((part) => !part || part === "." || part === "..") || file.targetPath.includes("\0") ||
			targets.has(file.targetPath)) throw new Error("invalid or duplicate publication target");
		targets.add(file.targetPath);
		if (file.kind === "image") {
			const extension = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" } as Record<string, string>)[file.mediaType ?? ""];
			if (!extension || file.targetPath !== `assets/images/${file.candidateHash}.${extension}` || file.blobRef !== file.candidateHash || file.operation === "delete" ||
				(file.operation === "update" && file.expectedHashOrAbsent !== file.candidateHash) || !file.sourceIds?.length || new Set(file.sourceIds).size !== file.sourceIds.length) throw new Error("invalid image publication asset");
		} else if (file.targetPath.startsWith("assets/images/") || file.mediaType || file.sourceIds) throw new Error("image asset requires explicit metadata");
		if (file.operation === "create" && file.expectedHashOrAbsent !== null) throw new Error("create target must be absent");
		if (file.operation !== "create" && !isHash(file.expectedHashOrAbsent)) throw new Error("mutation requires an exact baseline hash");
		if (file.operation === "delete") {
			if (file.candidateHash !== null || file.blobRef !== null) throw new Error("delete must not carry candidate bytes");
		} else if (!isHash(file.candidateHash) || !file.blobRef) {
			throw new Error("candidate bytes and hash are required");
		}
	}
	const grouped = batch.dependencyGroups.flat();
	if (grouped.length !== targets.size || new Set(grouped).size !== grouped.length || grouped.some((target) => !targets.has(target))) {
		throw new Error("dependency groups must cover every target exactly once");
	}
}

function isHash(value: string | null): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** A structural precondition only. T33 must separately authenticate a human action. */
export function assertReviewMatchesBatch(batch: PublicationBatch, review: ReviewDecision): void {
	assertPublicationBatchShape(batch);
	if (review.decision !== "approve" || review.batchId !== batch.id || review.revision !== batch.revision ||
		review.manifestHash !== batch.manifestHash || batch.manifestHash !== publicationManifestHash(batch)) {
		throw new Error("review does not match the frozen publication batch");
	}
	const targets = batch.files.map((file) => file.targetPath);
	if (new Set(targets).size !== targets.length || !sameMembers(review.reviewedFiles, targets) ||
		!sameMembers(review.expectedTargets, targets)) {
		throw new Error("review does not cover every distinct target");
	}
}

function sameMembers(actual: string[], expected: string[]): boolean {
	return actual.length === expected.length && new Set(actual).size === actual.length &&
		actual.every((item) => expected.includes(item));
}
