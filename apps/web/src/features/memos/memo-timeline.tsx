"use client";

import type { Memo } from "@/lib/memos";
import { groupMemosByDay } from "@/lib/memo-presentation";
import { MemoCard } from "./memo-card";

export function MemoTimeline({
	memos,
	selected,
	onSelect,
	onSave,
	onDelete,
	onPromote,
}: {
	memos: Memo[];
	selected: ReadonlySet<string>;
	onSelect: (id: string) => void;
	onSave: (memo: Memo, text: string) => Promise<void>;
	onDelete: (memo: Memo) => void;
	onPromote: (memo: Memo) => void;
}) {
	return (
		<div className="memo-timeline">
			{groupMemosByDay(memos).map((group) => (
				<section key={group.key} className="memo-day" aria-label={group.label}>
					<header className="memo-day-head">
						<h2>{group.label}</h2>
						<span>{group.items.length} 条</span>
					</header>
					<div className="memo-cards">
						{group.items.map((memo) => (
							<MemoCard
								key={memo.id}
								memo={memo}
								selected={selected.has(memo.id)}
								onSelect={onSelect}
								onSave={onSave}
								onDelete={onDelete}
								onPromote={onPromote}
							/>
						))}
					</div>
				</section>
			))}
		</div>
	);
}
