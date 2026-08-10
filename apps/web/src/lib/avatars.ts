"use client";

import { useEffect, useState } from "react";
import { agentAvatarUrl, listAgents } from "./api";

/**
 * Module-level registry of which agents have an uploaded avatar (§11). The
 * WorkerAvatar component is used in many places (agents cards, sidebar,
 * member popover, member message flow) and most call sites only know the
 * worker *name* — so instead of threading the avatar field through every
 * prop chain, this cache resolves name → avatar URL in one place.
 */

/** name -> per-agent cache-busting version (bumped on upload/delete). */
const versions = new Map<string, number>();
/** name -> has an uploaded avatar (null = unknown yet). */
const hasAvatar = new Map<string, boolean>();
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function emit(): void {
	for (const fn of listeners) fn();
}

function ensureLoaded(): void {
	loading ??= listAgents()
		.then((agents) => {
			for (const a of agents) {
				// 上传头像或 connector 包内默认头像（hasDefaultAvatar）都走 avatar URL；
				// GET avatar 路由会上传优先、回退包内资源。
				hasAvatar.set(a.name, Boolean(a.avatar || a.hasDefaultAvatar));
				if (!versions.has(a.name)) versions.set(a.name, 0);
			}
			emit();
		})
		.catch(() => {
			// Do not latch a failure: retry on the next component mount.
			loading = null;
		});
}

/** Record an avatar change (upload/delete) so every WorkerAvatar refreshes. */
export function agentAvatarChanged(name: string, uploaded: boolean): void {
	hasAvatar.set(name, uploaded);
	versions.set(name, (versions.get(name) ?? 0) + 1);
	emit();
}

/** Drop a removed agent from the registry. */
export function agentRemoved(name: string): void {
	hasAvatar.delete(name);
	versions.delete(name);
	emit();
}

function currentUrl(name: string): string | null {
	if (!hasAvatar.get(name)) return null;
	return agentAvatarUrl(name, versions.get(name) ?? 0);
}

/** Avatar URL for a worker name, or null when the default should be shown. */
export function useAgentAvatar(name: string): string | null {
	const [url, setUrl] = useState<string | null>(() => currentUrl(name));
	useEffect(() => {
		ensureLoaded();
		const update = () => setUrl(currentUrl(name));
		listeners.add(update);
		update();
		return () => {
			listeners.delete(update);
		};
	}, [name]);
	return url;
}
