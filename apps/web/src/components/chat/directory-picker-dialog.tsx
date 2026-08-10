"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeftIcon, FolderIcon, FolderOpenIcon, LoaderIcon } from "lucide-react";
import { browseWorkspaceDirectories, pickWorkspaceDirectory } from "@/lib/api";
import type { WorkspaceDirectoryListing } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

export function DirectoryPickerDialog({
	open,
	initialPath,
	onOpenChange,
	onSelect,
}: {
	open: boolean;
	initialPath: string;
	onOpenChange: (open: boolean) => void;
	onSelect: (path: string) => void;
}) {
	const [listing, setListing] = useState<WorkspaceDirectoryListing | null>(null);
	const [loading, setLoading] = useState(false);
	const [systemPicking, setSystemPicking] = useState(false);
	const [error, setError] = useState("");

	const browse = useCallback(async (path: string) => {
		setLoading(true);
		setError("");
		try {
			setListing(await browseWorkspaceDirectories(path));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!open || !initialPath) return;
		let cancelled = false;
		browseWorkspaceDirectories(initialPath)
			.then((next) => {
				if (cancelled) return;
				setListing(next);
				setError("");
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, initialPath]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>选择项目文件夹</DialogTitle>
					<DialogDescription>进入目标文件夹，然后选择“使用此文件夹”。</DialogDescription>
				</DialogHeader>

				<div className="flex min-w-0 items-center gap-2">
					<Button
						type="button"
						variant="outline"
						size="icon"
						disabled={!listing || listing.parent === listing.path || loading}
						onClick={() => listing && void browse(listing.parent)}
						aria-label="返回上一级"
						title="返回上一级"
					>
						<ArrowLeftIcon className="size-4" />
					</Button>
					<div className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs" title={listing?.path}>
						{listing?.path ?? initialPath}
					</div>
					<Button
						type="button"
						variant="outline"
						size="icon"
						disabled={!listing || loading || systemPicking}
						onClick={() => {
							if (!listing) return;
							setSystemPicking(true);
							setError("");
							void pickWorkspaceDirectory(listing.path)
								.then((selected) => {
									if (!selected) return;
									onSelect(selected);
									onOpenChange(false);
								})
								.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
								.finally(() => setSystemPicking(false));
						}}
						aria-label="用系统文件管理器选择文件夹"
						title="用 Finder 或 Windows 资源管理器选择"
					>
						{systemPicking ? <LoaderIcon className="size-4 animate-spin" /> : <FolderOpenIcon className="size-4" />}
					</Button>
				</div>

				<div className="overflow-hidden rounded-md border">
					<ScrollArea className="h-72">
						{loading && !listing ? (
							<div className="flex h-72 items-center justify-center gap-2 text-sm text-muted-foreground">
								<LoaderIcon className="size-4 animate-spin" />
								读取文件夹…
							</div>
						) : error ? (
							<div className="flex h-72 items-center justify-center px-6 text-center text-sm text-destructive">{error}</div>
						) : listing?.directories.length ? (
							<div className="p-1">
								{listing.directories.map((directory) => (
									<button
										type="button"
										key={directory.path}
										onClick={() => void browse(directory.path)}
										className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
									>
										<FolderIcon className="size-4 shrink-0 text-muted-foreground" />
										<span className="truncate">{directory.name}</span>
									</button>
								))}
							</div>
						) : (
							<div className="flex h-72 items-center justify-center text-sm text-muted-foreground">这个文件夹中没有子文件夹</div>
						)}
					</ScrollArea>
				</div>

				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
					<Button
						type="button"
						disabled={!listing || loading || Boolean(error)}
						onClick={() => {
							if (!listing) return;
							onSelect(listing.path);
							onOpenChange(false);
						}}
					>
						使用此文件夹
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
