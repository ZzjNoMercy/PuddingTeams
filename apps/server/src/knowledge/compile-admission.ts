import type { AgentDriver } from "../agent-runtime/types.js";
import type { CompileAdmission } from "../agent-runtime/runtime.js";
import type { ExtensionRegistry } from "../agent-runtime/extension-registry.js";
import { agentRunConfigRevision, type TeamsStore } from "../store/teams.js";
import type { KnowledgeAcceptanceStore } from "./acceptance.js";
import type { KnowledgeBindingRegistry } from "./bindings.js";
import { createCandidateValidator } from "./candidate.js";
import type { CompileJob } from "./contracts.js";
import type { CompileJobStore } from "./compile-jobs.js";
import type { KnowledgeObjectStore } from "./objects.js";
import type { KnowledgeObservationService } from "./observation.js";
import { inspectCompileSnapshot } from "./compile-snapshot.js";
import { effectiveSchemaHash } from "./schema-impact.js";
import path from "node:path";

interface CompileAdmissionStores {
	jobs: CompileJobStore;
	bindings: Pick<KnowledgeBindingRegistry, "requireUsable">;
	acceptance: Pick<KnowledgeAcceptanceStore, "getSnapshot">;
	observation: Pick<KnowledgeObservationService, "scan">;
	objects: Pick<KnowledgeObjectStore, "put">;
	teams: Pick<TeamsStore, "getAgent">;
	extensions: Pick<ExtensionRegistry, "attestBundledDriver">;
}

/** Host authority for the protected Runtime path. Every check reads current
 * platform state; a completed Worker result grants no candidate authority. */
export function createCompileAdmission(stores: CompileAdmissionStores): CompileAdmission {
	return {
		jobs: stores.jobs,
		attestCompilerDriver: (job: CompileJob, driver: AgentDriver) =>
			stores.extensions.attestBundledDriver("codex", driver),
		authorizeJob: async (job: CompileJob) => {
			const binding = await stores.bindings.requireUsable(job.ownerId, job.targetBindingId);
			if (binding.bindingRevision !== job.bindingRevision || binding.trustRevision !== job.trustRevision ||
				binding.rootIdentity !== job.rootIdentity || await effectiveSchemaHash(binding) !== job.schemaHash) {
				throw new Error("CompileJob binding authority changed");
			}
			const agent = await stores.teams.getAgent(job.agentId);
			if (!agent || agent.enabled === false || agent.connector?.connectorId !== "codex" ||
				agent.connector.transport !== "spawn" || agentRunConfigRevision(agent) !== job.agentRevision) {
				throw new Error("CompileJob Agent authority changed");
			}
			const ledger = await stores.acceptance.getSnapshot(binding.id);
			const observation = await stores.observation.scan(binding);
			if (!job.sourceAcceptanceIds.length || job.sourceAcceptanceIds.length !== job.sourceSnapshotRefs.length) {
				throw new Error("CompileJob source identities are incomplete");
			}
			const expectedFiles = new Map<string, string>();
			for (let index = 0; index < job.sourceAcceptanceIds.length; index++) {
				const id = job.sourceAcceptanceIds[index];
				const ref = job.sourceSnapshotRefs[index];
				const matches = Object.values(ledger.entries).filter((entry) => entry.acceptanceId === id);
				if (matches.length !== 1) throw new Error("CompileJob accepted source identity changed");
				const entry = matches[0]!;
				if (entry.availability !== "current" || entry.noteIdentity.bindingId !== binding.id ||
					entry.contentHash !== ref) {
					throw new Error("CompileJob accepted source authority changed");
				}
				const live = entry.noteIdentity.declaredNoteId
					? [...observation.files.values()].find((file) => file.declaredId === entry.noteIdentity.declaredNoteId)
					: observation.files.get(entry.relativePath);
				if (!live || live.state !== "current" || live.hash !== ref || live.path !== entry.relativePath ||
					(!entry.noteIdentity.declaredNoteId && live.declaredId)) {
					throw new Error("CompileJob source is no longer current in the bound Wiki");
				}
				if (expectedFiles.has(entry.relativePath)) throw new Error("CompileJob source paths collide");
				expectedFiles.set(entry.relativePath, ref);
			}
			const snapshot = await inspectCompileSnapshot(job.sourceSnapshotRoot);
			const files = snapshot.entries.filter((entry) => entry[0] === "file");
			if (snapshot.hash !== job.sourceSnapshotHash || files.length !== expectedFiles.size ||
				files.some(([, relative, digest]) => expectedFiles.get(relative) !== digest)) {
				throw new Error("CompileJob source snapshot does not match accepted objects");
			}
			const expectedDirectories = new Set<string>();
			for (const relative of expectedFiles.keys()) {
				for (let directory = path.posix.dirname(relative); directory !== "."; directory = path.posix.dirname(directory)) {
					expectedDirectories.add(directory);
				}
			}
			if (snapshot.entries.some(([kind, relative]) => kind === "directory" && !expectedDirectories.has(relative))) {
				throw new Error("CompileJob source snapshot contains an unaccepted directory");
			}
			// A scan can outlive a re-adoption or binding/Agent edit. Re-read the
			// authorities after it before allowing Runtime to cross the start gate.
			const [latestLedger, latestBinding, latestAgent] = await Promise.all([
				stores.acceptance.getSnapshot(binding.id),
				stores.bindings.requireUsable(job.ownerId, job.targetBindingId),
				stores.teams.getAgent(job.agentId),
			]);
			if (latestLedger.acceptanceRevision !== ledger.acceptanceRevision ||
				latestBinding.bindingRevision !== binding.bindingRevision || latestBinding.trustRevision !== binding.trustRevision ||
				latestBinding.rootIdentity !== binding.rootIdentity || await effectiveSchemaHash(latestBinding) !== job.schemaHash ||
				!latestAgent || latestAgent.enabled === false || latestAgent.connector?.connectorId !== "codex" ||
				latestAgent.connector.transport !== "spawn" || agentRunConfigRevision(latestAgent) !== job.agentRevision) {
				throw new Error("CompileJob authority changed during source observation");
			}
		},
		validateCandidate: createCandidateValidator({
			bindings: stores.bindings,
			acceptance: stores.acceptance,
			objects: stores.objects,
		}),
	};
}
