/** Only content-addressed managed raster images are eligible for frozen snapshots. */
export function managedImageHash(path: string): string | null {
	return /^assets\/images\/([a-f0-9]{64})\.(?:png|jpg|gif|webp)$/.exec(path)?.[1] ?? null;
}

export function hasFrozenBatchImage(path: string, files: ReadonlyArray<{ kind?: string; targetPath: string; candidateHash: string | null; operation: string }>): boolean {
	const hash = managedImageHash(path);
	return hash !== null && files.some((file) => file.kind === "image" && file.targetPath === path && file.candidateHash === hash && file.operation !== "delete");
}
