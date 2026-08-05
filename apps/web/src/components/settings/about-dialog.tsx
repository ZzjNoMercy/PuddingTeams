"use client";

import { useEffect, useState } from "react";
import { GithubIcon } from "@/components/github-icon";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { getHealth } from "@/lib/api";
import pkg from "../../../package.json";

const GITHUB_URL = "https://github.com/ZzjNoMercy/PuddingTeams";

export function AboutDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	// pi SDK version lives on the backend; hide the row when unreachable.
	const [piVersion, setPiVersion] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		getHealth()
			.then((h) => {
				if (!cancelled) setPiVersion(h.piVersion ?? null);
			})
			.catch(() => {
				if (!cancelled) setPiVersion(null);
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>PuddingTeams</DialogTitle>
					<DialogDescription>基于 pi 的 agent teams 平台</DialogDescription>
				</DialogHeader>
				<dl className="space-y-1.5 text-sm">
					<div className="flex justify-between">
						<dt className="text-muted-foreground">版本</dt>
						<dd>{pkg.version}</dd>
					</div>
					{piVersion !== null && (
						<div className="flex justify-between">
							<dt className="text-muted-foreground">pi SDK</dt>
							<dd>{piVersion}</dd>
						</div>
					)}
				</dl>
				<a
					href={GITHUB_URL}
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
				>
					<GithubIcon className="size-4" />
					GitHub
				</a>
			</DialogContent>
		</Dialog>
	);
}
