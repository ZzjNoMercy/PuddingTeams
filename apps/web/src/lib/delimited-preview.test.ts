import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDelimitedPreview } from "./delimited-preview.js";

test("CSV preview preserves quoted newlines while marking omitted rows and columns", () => {
	const quoted = parseDelimitedPreview('name,notes\nA,"first\nsecond"\n', ",");
	assert.deepEqual(quoted.rows, [["name", "notes"], ["A", "first\nsecond"]]);
	assert.equal(quoted.truncatedRows, false);
	assert.equal(quoted.truncatedColumns, false);

	const manyRows = parseDelimitedPreview(Array.from({ length: 201 }, (_, index) => `row-${index}`).join("\n"), ",");
	assert.equal(manyRows.rows.length, 200);
	assert.equal(manyRows.truncatedRows, true);

	const manyColumns = parseDelimitedPreview(Array.from({ length: 31 }, (_, index) => `column-${index}`).join(","), ",");
	assert.equal(manyColumns.rows[0]?.length, 30);
	assert.equal(manyColumns.truncatedColumns, true);
});
