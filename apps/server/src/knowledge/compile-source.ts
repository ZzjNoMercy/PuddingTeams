import { chmod, mkdir, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AcceptanceLedger, KnowledgeAcceptanceStore } from "./acceptance.js";
import type { KnowledgeBinding } from "./contracts.js";
import type { KnowledgeObjectStore } from "./objects.js";
import type { KnowledgeObservationService } from "./observation.js";
import { fingerprintCompileSnapshot } from "./compile-snapshot.js";

export interface MaterializedCompileSource {
	root: string;
	sourceAcceptanceIds: string[];
	sourceSnapshotRefs: string[];
	sourceSnapshotHash: string;
}

/** Materialize selected accepted versions from the platform object store. The
 * compiler never receives a live Wiki path, acceptance ledger, or object root. */
export async function materializeCompileSource(
	parentDir: string,
	ledger: AcceptanceLedger,
	acceptanceIds: readonly string[],
	objects: Pick<KnowledgeObjectStore, "get">,
	binding: KnowledgeBinding,
	observation: Pick<KnowledgeObservationService, "scan">,
	acceptance: Pick<KnowledgeAcceptanceStore, "getSnapshot">,
): Promise<MaterializedCompileSource> {
	if (!Array.isArray(acceptanceIds) || acceptanceIds.length === 0 || acceptanceIds.length > 1000 ||
		new Set(acceptanceIds).size !== acceptanceIds.length) throw new Error("invalid CompileJob accepted source selection");
	if (!path.isAbsolute(parentDir)) throw new Error("CompileJob source parent must be absolute");
	await mkdir(parentDir, { recursive: true, mode: 0o700 });
	if (await realpath(parentDir) !== parentDir) throw new Error("CompileJob source parent must be canonical");
	if (binding.id !== ledger.bindingId || binding.availability !== "available") throw new Error("CompileJob binding is not current");
	const parentStats = await stat(parentDir);
	if ((parentStats.mode & 0o077) !== 0 || (process.getuid && parentStats.uid !== process.getuid())) {
		throw new Error("CompileJob source parent must be server-owned and mode 0700");
	}
	const byId = new Map<string, (typeof ledger.entries)[string]>();
	for (const entry of Object.values(ledger.entries)) {
		if (byId.has(entry.acceptanceId)) throw new Error("CompileJob acceptance ledger has duplicate identities");
		byId.set(entry.acceptanceId, entry);
	}
	const observed = await observation.scan(binding);
	const selected = acceptanceIds.map((id) => {
		const entry = byId.get(id);
		if (!entry || entry.noteIdentity.bindingId !== ledger.bindingId || entry.availability !== "current" ||
			!/^([a-f0-9]{64})$/.test(entry.contentHash) || entry.snapshotRef !== entry.contentHash) {
			throw new Error("CompileJob source is not an accepted object for this binding");
		}
		const acceptedRelative = entry.relativePath.normalize("NFC");
		const acceptedParts = acceptedRelative.split("/");
		if (acceptedRelative !== entry.relativePath || !acceptedRelative.endsWith(".md") || acceptedRelative.startsWith("/") ||
			acceptedRelative.includes("\\") || acceptedRelative.includes("\0") || acceptedParts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) {
			throw new Error("CompileJob source has an invalid relative path");
		}
		const live = entry.noteIdentity.declaredNoteId
			? [...observed.files.values()].find((file) => file.declaredId === entry.noteIdentity.declaredNoteId)
			: observed.files.get(entry.relativePath);
		if (!live || live.state !== "current" || live.hash !== entry.contentHash) {
			throw new Error("CompileJob source is no longer current in the bound Wiki");
		}
		if (!entry.noteIdentity.declaredNoteId && live.declaredId) {
			throw new Error("CompileJob source identity changed since acceptance");
		}
		const relative = live.path.normalize("NFC");
		const parts = relative.split("/");
		if (relative !== entry.relativePath || !relative.endsWith(".md") || relative.startsWith("/") ||
			relative.includes("\\") || relative.includes("\0") || parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))) {
			throw new Error("CompileJob source has an invalid relative path");
		}
		return { id, entry, relative, collisionKey: relative.toLocaleLowerCase("en-US") };
	});
	if (new Set(selected.map((item) => item.collisionKey)).size !== selected.length) {
		throw new Error("CompileJob source paths collide on a case-insensitive file system");
	}
	const assertLatestAcceptance = async () => {
		const latest = await acceptance.getSnapshot(binding.id);
		if (latest.acceptanceRevision !== ledger.acceptanceRevision || selected.some(({ id, entry }) =>
			!Object.values(latest.entries).some((candidate) => candidate.acceptanceId === id &&
				candidate.contentHash === entry.contentHash && candidate.snapshotRef === entry.snapshotRef &&
				candidate.relativePath === entry.relativePath && candidate.availability === "current"))) {
			throw new Error("CompileJob accepted source authority changed");
		}
	};
	await assertLatestAcceptance();
	selected.sort((a, b) => a.relative.localeCompare(b.relative, "en-US"));
	const root = await mkdtemp(path.join(parentDir, "compile-source-"));
	const directories = new Set<string>([root]);
	try {
		let totalBytes = 0;
		for (const { entry, relative } of selected) {
			const content = await objects.get(entry.snapshotRef);
			totalBytes += content.byteLength;
			if (totalBytes > 64 * 1024 * 1024) throw new Error("CompileJob source exceeds 64 MiB");
			let directory = path.dirname(path.join(root, relative));
			await mkdir(directory, { recursive: true, mode: 0o700 });
			while (directory !== root) {
				directories.add(directory);
				directory = path.dirname(directory);
			}
			const handle = await open(path.join(root, relative), "wx", 0o400);
			try {
				await handle.writeFile(content);
				await handle.sync();
			} finally { await handle.close(); }
		}
		for (const directory of [...directories].sort((a, b) => b.length - a.length)) await chmod(directory, 0o500);
		await assertLatestAcceptance();
		return {
			root,
			sourceAcceptanceIds: selected.map(({ id }) => id),
			sourceSnapshotRefs: selected.map(({ entry }) => entry.snapshotRef),
			sourceSnapshotHash: await fingerprintCompileSnapshot(root),
		};
	} catch (error) {
		for (const directory of [...directories].sort((a, b) => a.length - b.length)) {
			await chmod(directory, 0o700).catch(() => undefined);
		}
		await rm(root, { recursive: true, force: true });
		throw error;
	}
}
