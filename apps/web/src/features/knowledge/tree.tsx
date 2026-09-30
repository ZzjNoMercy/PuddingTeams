"use client";

import { FolderIcon } from "lucide-react";
import type { KnowledgeTreeNode } from "@/lib/api";

/** 目录树：保留展开行为，文件节点直接反映当前目录。 */
export function KnowledgeTree({ nodes, selected, onSelect }: {
	nodes: KnowledgeTreeNode[];
	selected: string | null;
	onSelect: (path: string) => void;
}) {
	return (
		<ul className="space-y-0.5">
			{nodes.map((node) => {
				if (node.type === "directory") {
					return (
						<li key={node.path}>
							<details open={selected?.startsWith(`${node.path}/`) ? true : undefined}>
								<summary className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted">
									<FolderIcon size={15} />{node.name}
								</summary>
								<div className="ml-3 border-l border-border pl-2">
									<KnowledgeTree nodes={node.children ?? []} selected={selected} onSelect={onSelect} />
								</div>
							</details>
						</li>
					);
				}
				return (
					<li key={node.path}>
						<button
							type="button"
							aria-current={node.path === selected ? "page" : undefined}
							onClick={() => onSelect(node.path)}
							className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm hover:bg-muted ${node.path === selected ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`}
						>
							<span className="min-w-0 flex-1 truncate">{node.name}</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}
