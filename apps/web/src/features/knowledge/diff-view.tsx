import type { KnowledgeDiffHunk } from "@/lib/api";

/** 已同步快照 vs 磁盘当前版本的行级 diff（+/- 绿红、上下文原色）。 */
export function KnowledgeDiffView({ hunks, truncated, label = "已同步版本与磁盘版本的差异", onlyChanges = false }: { hunks: KnowledgeDiffHunk[]; truncated: boolean; label?: string; onlyChanges?: boolean }) {
	if (hunks.length === 0 && !truncated) {
		return <p className="text-xs text-muted-foreground">两个版本内容一致。</p>;
	}
	return (
		<div className="knowledge-diff" role="region" aria-label={label}>
			{hunks.map((hunk, index) => (
				<div key={index}>
					<div className="knowledge-diff-hunk">@@ -{hunk.aStart},{hunk.aLines} +{hunk.bStart},{hunk.bLines} @@</div>
					{hunk.lines.filter((line) => !onlyChanges || line.kind !== "same").map((line, lineIndex) => (
						<div key={lineIndex} className={`knowledge-diff-line is-${line.kind}`}>
							<span className="knowledge-diff-sign">{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</span>
							<span className="min-w-0 flex-1">{line.text || " "}</span>
						</div>
					))}
				</div>
			))}
			{truncated ? <p className="knowledge-diff-truncated">差异过大已截断，请直接查看原文。</p> : null}
		</div>
	);
}
