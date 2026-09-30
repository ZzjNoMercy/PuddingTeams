export function filterResources<T extends { name: string; description: string; argumentHint?: string }>(rows: readonly T[], query: string): T[] {
	const search = query.trim().toLocaleLowerCase();
	return rows.filter((row) => `${row.name} ${row.description} ${row.argumentHint ?? ""}`.toLocaleLowerCase().includes(search));
}
