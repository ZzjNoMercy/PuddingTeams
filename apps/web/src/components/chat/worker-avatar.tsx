"use client";

import { BrainIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const PALETTE = ["#F59E0B", "#10B981", "#3B82F6", "#8B5CF6", "#EF4444", "#EC4899", "#14B8A6", "#F97316"];

/** Stable color for a worker name (deterministic, no image assets). */
export function workerColor(name: string): string {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return PALETTE[h % PALETTE.length]!;
}

/** Avatar for a team worker: first letters on a stable color. */
export function WorkerAvatar({
	name,
	size = 24,
	className,
}: {
	name: string;
	size?: number;
	className?: string;
}) {
	return (
		<span
			className={cn("flex shrink-0 items-center justify-center rounded-full font-semibold text-white", className)}
			style={{ width: size, height: size, backgroundColor: workerColor(name), fontSize: size * 0.4 }}
			title={name}
		>
			{name.slice(0, 2).toUpperCase()}
		</span>
	);
}

/** Avatar for the pi manager, always present in every room. */
export function ManagerAvatar({ size = 24, className }: { size?: number; className?: string }) {
	return (
		<span
			className={cn(
				"flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
				className,
			)}
			style={{ width: size, height: size }}
			title="pi manager"
		>
			<BrainIcon style={{ width: size * 0.55, height: size * 0.55 }} />
		</span>
	);
}

/** Overlapping avatar stack for a group chat (up to 3 shown, +N overflow). */
export function MemberStack({
	members,
	size = 20,
	className,
}: {
	members: { name: string }[];
	size?: number;
	className?: string;
}) {
	const shown = members.slice(0, 3);
	return (
		<div className={cn("flex shrink-0 items-center", className)}>
			<div className="flex -space-x-1.5">
				{shown.map((m) => (
					<WorkerAvatar key={m.name} name={m.name} size={size} className="ring-2 ring-background" />
				))}
			</div>
			{members.length > 3 ? (
				<span
					className="ml-1 flex items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground"
					style={{ width: size, height: size }}
				>
					+{members.length - 3}
				</span>
			) : null}
		</div>
	);
}
