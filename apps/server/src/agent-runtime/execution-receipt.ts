import { createHash } from "node:crypto";
import type {
	ArtifactRef,
	DriverTransport,
	ExecutionReceiptPayload,
	FailedResult,
	CompletedResult,
} from "./types.js";

export type ExecutionState =
	| "admitted"
	| "running"
	| "waiting_input"
	| "reported_completed"
	| "reported_failed"
	| "cancel_requested"
	| "reconciling"
	| "cancelled"
	| "observation_lost";

export interface ExecutionRequirementResult {
	requirement: string;
	status: "provided" | "missing" | "unavailable";
	evidenceRefs: string[];
}

export interface ArtifactCaptureResult {
	reportedPath: string;
	artifactId?: string;
	contentHash?: string;
	status: "captured" | "rejected" | "missing" | "failed";
	issue?: string;
}

export interface ExecutionReceipt extends ExecutionReceiptPayload {
	id: string;
	delegationId: string;
	goalId?: string;
	workPlanId?: string;
	workItemId?: string;
	attempt?: number;
	goalRevision?: number;
	workItemRevision?: number;
	goalEpoch?: number;
	/** Harness-frozen business contract; contractHash below is the Runtime execution envelope. */
	taskContractHash?: string;
	contractHash: string;
	requirementResults: ExecutionRequirementResult[];
	artifactCapture: ArtifactCaptureResult[];
	collectionStatus: "complete" | "partial" | "failed";
	workspaceExecutionScopeId?: string;
	workspaceChangeSetId?: string;
	integrity: "clean" | "suspect" | "violation";
	issues: string[];
	sealedAt: string;
}

export interface ReceiptContractSnapshot {
	delegationId: string;
	operationId: string;
	/** Harness-frozen WorkItem contract hash; when present it is authoritative. */
	contractHash?: string;
	goalId?: string;
	workPlanId?: string;
	workItemId?: string;
	attempt?: number;
	goalRevision?: number;
	workItemRevision?: number;
	goalEpoch?: number;
	task?: string;
	intent?: string;
	expectedOutcome?: string;
	evidenceRequirements?: string[];
	completionBoundary?: string;
	workspaceId?: string;
	cwdSnapshot: string;
	agentId: string;
	agentRevision: number;
	createdAt: string;
	workspaceExecutionScopeId?: string;
	workspaceChangeSetId?: string;
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function executionContractHash(snapshot: ReceiptContractSnapshot): string {
	return `sha256:${createHash("sha256").update(stable({
		taskContractHash: snapshot.contractHash,
		goalId: snapshot.goalId,
		workPlanId: snapshot.workPlanId,
		workItemId: snapshot.workItemId,
		attempt: snapshot.attempt,
		goalRevision: snapshot.goalRevision,
		workItemRevision: snapshot.workItemRevision,
		goalEpoch: snapshot.goalEpoch,
		task: snapshot.task,
		intent: snapshot.intent,
		expectedOutcome: snapshot.expectedOutcome,
		evidenceRequirements: snapshot.evidenceRequirements ?? [],
		completionBoundary: snapshot.completionBoundary,
		workspaceId: snapshot.workspaceId,
		cwdSnapshot: snapshot.cwdSnapshot,
		agentId: snapshot.agentId,
		agentRevision: snapshot.agentRevision,
		workspaceExecutionScopeId: snapshot.workspaceExecutionScopeId,
	})).digest("hex")}`;
}

function unique(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function requirementResults(
	requirements: string[],
	reported: Array<{ requirement: string; evidenceRefs: string[] }>,
): ExecutionRequirementResult[] {
	return requirements.map((requirement) => {
		const exact = reported.find((item) => item.requirement.trim() === requirement.trim());
		if (!exact) return { requirement, status: "missing", evidenceRefs: [] };
		const evidenceRefs = unique(exact.evidenceRefs);
		return {
			requirement,
			status: evidenceRefs.length ? "provided" : "unavailable",
			evidenceRefs,
		};
	});
}

function collectionState(
	requirements: ExecutionRequirementResult[],
	artifacts: ArtifactRef[],
	captures: ArtifactCaptureResult[],
): "complete" | "partial" | "failed" {
	const missingRequirements = requirements.some((item) => item.status !== "provided");
	const failedCaptures = captures.filter((item) => item.status !== "captured");
	if (artifacts.length > 0 && captures.length === artifacts.length && failedCaptures.length === captures.length) return "failed";
	if (missingRequirements || failedCaptures.length > 0 || captures.length !== artifacts.length) return "partial";
	return "complete";
}

export function sealExecutionReceipt(input: {
	contract: ReceiptContractSnapshot;
	result: CompletedResult | FailedResult;
	artifactCapture: ArtifactCaptureResult[];
	connectorId: string;
	transport: DriverTransport;
	observedAt?: string;
}): ExecutionReceipt {
	const observedAt = input.observedAt ?? new Date().toISOString();
	const reportedEvidence = input.result.reportedEvidence ?? [];
	const reportedArtifacts = input.result.artifacts ?? [];
	const requirements = requirementResults(input.contract.evidenceRequirements ?? [], reportedEvidence);
	const issues = input.artifactCapture
		.filter((item) => item.status !== "captured")
		.map((item) => item.issue ?? `${item.reportedPath}: ${item.status}`);
	for (const item of requirements) {
		if (item.status !== "provided") issues.push(`证据要求未结算：${item.requirement}`);
	}
	const integrity = input.artifactCapture.some((item) => item.status === "rejected")
		? "violation"
		: issues.length
			? "suspect"
			: "clean";
	return {
		schemaVersion: 1,
		id: `receipt:${input.contract.delegationId}`,
		delegationId: input.contract.delegationId,
		operationId: input.contract.operationId,
		...(input.contract.goalId ? { goalId: input.contract.goalId } : {}),
		...(input.contract.workPlanId ? { workPlanId: input.contract.workPlanId } : {}),
		...(input.contract.workItemId ? { workItemId: input.contract.workItemId } : {}),
		...(input.contract.attempt !== undefined ? { attempt: input.contract.attempt } : {}),
		...(input.contract.goalRevision !== undefined ? { goalRevision: input.contract.goalRevision } : {}),
		...(input.contract.workItemRevision !== undefined ? { workItemRevision: input.contract.workItemRevision } : {}),
		...(input.contract.goalEpoch !== undefined ? { goalEpoch: input.contract.goalEpoch } : {}),
		...(input.contract.contractHash ? { taskContractHash: input.contract.contractHash } : {}),
		contractHash: executionContractHash(input.contract),
		reportedOutcome: input.result.status,
		upstream: {
			...(input.result.sessionHandle ? { sessionHandle: input.result.sessionHandle } : {}),
			...(input.result.runHandle ? { runHandle: input.result.runHandle } : {}),
		},
		reportedEvidence,
		reportedArtifacts,
		requirementResults: requirements,
		artifactCapture: input.artifactCapture,
		collectionStatus: collectionState(requirements, reportedArtifacts, input.artifactCapture),
		...(input.contract.workspaceExecutionScopeId ? { workspaceExecutionScopeId: input.contract.workspaceExecutionScopeId } : {}),
		...(input.contract.workspaceChangeSetId ? { workspaceChangeSetId: input.contract.workspaceChangeSetId } : {}),
		integrity,
		issues,
		startedAt: input.contract.createdAt,
		observedAt,
		observer: { connectorId: input.connectorId, transport: input.transport },
		sealedAt: observedAt,
	};
}
