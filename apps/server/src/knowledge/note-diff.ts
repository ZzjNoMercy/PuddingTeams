export interface DiffLine {
	kind: "same" | "add" | "del";
	text: string;
}

export interface DiffHunk {
	aStart: number;
	aLines: number;
	bStart: number;
	bLines: number;
	lines: DiffLine[];
}

export interface NoteDiff {
	hunks: DiffHunk[];
	truncated: boolean;
}

export class KnowledgeDiffError extends Error {
	constructor(readonly code: "too_large", message: string) {
		super(message);
	}
}

export const MAX_DIFF_BYTES = 512 * 1024;
const MAX_HUNKS = 200;
const CONTEXT_LINES = 3;
const MAX_EDIT_DISTANCE = 2000;
const MAX_EMITTED_LINES = 5000;

/** Myers O(ND) 中间段 diff；编辑距离超上限时回退为整段 del+add，保证有界。 */
function myersMiddle(a: string[], b: string[]): DiffLine[] {
	const n = a.length;
	const m = b.length;
	const width = 2 * (MAX_EDIT_DISTANCE + 1) + 1;
	const offset = MAX_EDIT_DISTANCE + 1;
	let v = new Int32Array(width);
	const trace: Int32Array[] = [];
	let found = -1;
	outer: for (let d = 0; d <= Math.min(n + m, MAX_EDIT_DISTANCE); d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)) {
				x = v[k + 1 + offset]!;
			} else {
				x = v[k - 1 + offset]! + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[k + offset] = x;
			if (x >= n && y >= m) {
				found = d;
				break outer;
			}
		}
	}
	if (found < 0) {
		return [
			...a.map((text): DiffLine => ({ kind: "del", text })),
			...b.map((text): DiffLine => ({ kind: "add", text })),
		];
	}
	const ops: DiffLine[] = [];
	let x = n;
	let y = m;
	for (let d = found; d >= 0; d--) {
		const snapshot = trace[d]!;
		const k = x - y;
		const prevK = (k === -d || (k !== d && snapshot[k - 1 + offset]! < snapshot[k + 1 + offset]!)) ? k + 1 : k - 1;
		const prevX = snapshot[prevK + offset]!;
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			ops.push({ kind: "same", text: a[x - 1]! });
			x--;
			y--;
		}
		if (d === 0) break;
		if (x === prevX) {
			ops.push({ kind: "add", text: b[prevY]! });
		} else {
			ops.push({ kind: "del", text: a[prevX]! });
		}
		x = prevX;
		y = prevY;
	}
	return ops.reverse();
}

function diffOps(a: string[], b: string[]): DiffLine[] {
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
	const middle = myersMiddle(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix));
	return [
		...a.slice(0, prefix).map((text): DiffLine => ({ kind: "same", text })),
		...middle,
		...a.slice(a.length - suffix).map((text): DiffLine => ({ kind: "same", text })),
	];
}

function buildHunks(ops: DiffLine[]): DiffHunk[] {
	const aPos = new Array<number>(ops.length + 1).fill(1);
	const bPos = new Array<number>(ops.length + 1).fill(1);
	for (let index = 0; index < ops.length; index++) {
		const op = ops[index]!;
		aPos[index + 1] = aPos[index]! + (op.kind === "add" ? 0 : 1);
		bPos[index + 1] = bPos[index]! + (op.kind === "del" ? 0 : 1);
	}
	const changeIndices = ops.map((op, index) => (op.kind === "same" ? -1 : index)).filter((index) => index >= 0);
	if (changeIndices.length === 0) return [];
	const groups: Array<[number, number]> = [];
	let groupStart = changeIndices[0]!;
	let previous = changeIndices[0]!;
	for (const index of changeIndices.slice(1)) {
		if (index - previous > CONTEXT_LINES * 2) {
			groups.push([groupStart, previous]);
			groupStart = index;
		}
		previous = index;
	}
	groups.push([groupStart, previous]);
	return groups.map(([start, end]) => {
		const from = Math.max(0, start - CONTEXT_LINES);
		const to = Math.min(ops.length - 1, end + CONTEXT_LINES);
		const lines = ops.slice(from, to + 1);
		return {
			aStart: aPos[from]!,
			aLines: lines.filter((op) => op.kind !== "add").length,
			bStart: bPos[from]!,
			bLines: lines.filter((op) => op.kind !== "del").length,
			lines,
		};
	});
}

/** accepted 快照 vs 当前磁盘的有界行 diff；任一侧超 512KiB 抛 too_large。 */
export function diffNoteContent(accepted: string, observed: string): NoteDiff {
	if (Buffer.byteLength(accepted) > MAX_DIFF_BYTES || Buffer.byteLength(observed) > MAX_DIFF_BYTES) {
		throw new KnowledgeDiffError("too_large", "diff 输入超过 512 KiB 上限");
	}
	const hunks = buildHunks(diffOps(accepted.split("\n"), observed.split("\n")));
	let truncated = false;
	let emitted = 0;
	const bounded: DiffHunk[] = [];
	for (const hunk of hunks) {
		if (bounded.length >= MAX_HUNKS || emitted + hunk.lines.length > MAX_EMITTED_LINES) {
			truncated = true;
			break;
		}
		bounded.push(hunk);
		emitted += hunk.lines.length;
	}
	return { hunks: bounded, truncated };
}
