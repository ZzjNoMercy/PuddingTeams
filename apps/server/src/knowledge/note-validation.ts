import type { SchemaField, TeamsSchemaPreset } from "./schema-presets.js";

/** Teams-owned structured notes only; existing Wiki formats use their own parser. */
export function validateTeamsNote(schema: TeamsSchemaPreset, note: Record<string, unknown>): string[] {
	const errors: string[] = [];
	const type = note.type;
	const entity = schema.entities.find((item) => item.type === type);
	if (!entity) return ["unknown_type"];
	for (const field of entity.fields) {
		const value = note[field.name];
		const present = value !== undefined && value !== null && value !== "" && (!field.required || !Array.isArray(value) || value.length > 0);
		if (!present) {
			if (field.required) errors.push(`missing:${field.name}`);
			continue;
		}
		if (!validValue(field, value)) errors.push(`invalid:${field.name}`);
		if (field.requiresSourceField) {
			const source = note[field.requiresSourceField];
			if (!Array.isArray(source) || source.length === 0 || !source.every(validSourceRef)) errors.push(`missing_source:${field.name}`);
		}
	}
	// Deliberately leave unknown fields untouched. Rewriting must preserve them.
	return errors;
}

function validValue(field: SchemaField, value: unknown): boolean {
	switch (field.type) {
		case "text": return typeof value === "string" && value.trim().length > 0;
		case "date": return validDate(value);
		case "datetime": return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
		case "text_list": return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
		case "source_refs": return Array.isArray(value) && value.every(validSourceRef);
		case "note_refs": return Array.isArray(value) && value.every(validNoteRef);
		case "enum": return typeof value === "string" && Boolean(field.values?.includes(value));
	}
}

function validDate(value: unknown): boolean {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function validSourceRef(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const ref = value as Record<string, unknown>;
	return typeof ref.sourceId === "string" && ref.sourceId.length > 0 && typeof ref.snapshotPath === "string" && ref.snapshotPath.length > 0;
}

function validNoteRef(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const ref = value as Record<string, unknown>;
	return typeof ref.bindingId === "string" && ref.bindingId.length > 0 &&
		((typeof ref.declaredNoteId === "string" && ref.declaredNoteId.length > 0) !==
		(typeof ref.normalizedRelativePath === "string" && ref.normalizedRelativePath.length > 0));
}
