export interface DelimitedPreview {
	rows: string[][];
	truncatedRows: boolean;
	truncatedColumns: boolean;
}

/** Bounded CSV/TSV rendering; callers must label any omitted rows or columns. */
export function parseDelimitedPreview(content: string, delimiter: string): DelimitedPreview {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	let truncatedColumns = false;
	let index = 0;
	const pushRow = () => {
		row.push(cell);
		if (row.length > 30) truncatedColumns = true;
		rows.push(row.slice(0, 30));
		row = [];
		cell = "";
	};
	for (; index < content.length && rows.length < 200; index += 1) {
		const char = content[index]!;
		if (char === '"') {
			if (quoted && content[index + 1] === '"') { cell += '"'; index += 1; }
			else quoted = !quoted;
		} else if (char === delimiter && !quoted) {
			row.push(cell); cell = "";
		} else if ((char === "\n" || char === "\r") && !quoted) {
			if (char === "\r" && content[index + 1] === "\n") index += 1;
			pushRow();
		} else cell += char;
	}
	if ((cell || row.length) && rows.length < 200) pushRow();
	return { rows, truncatedRows: index < content.length, truncatedColumns };
}
