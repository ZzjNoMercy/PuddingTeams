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
/** name -> uploaded avatar / connector-bundled avatar availability. */
const avatarKinds = new Map<string, { uploaded: boolean; bundled: boolean }>();
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

function emit(): void {
	for (const fn of listeners) fn();
}

function ensureLoaded(): void {
	loading ??= listAgents()
		.then((agents) => {
			for (const a of agents) {
				// GET avatar 路由会上传优先、回退包内资源；这里分别记录两种来源，
				// 让 Manager 能保留用户上传，同时使用产品头像覆盖 Pi 品牌回退。
				avatarKinds.set(a.name, {
					uploaded: Boolean(a.avatar),
					bundled: Boolean(a.hasDefaultAvatar),
				});
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
	const current = avatarKinds.get(name);
	avatarKinds.set(name, { uploaded, bundled: current?.bundled ?? false });
	versions.set(name, (versions.get(name) ?? 0) + 1);
	emit();
}

/** Drop a removed agent from the registry. */
export function agentRemoved(name: string): void {
	avatarKinds.delete(name);
	versions.delete(name);
	emit();
}

function currentUrl(name: string, uploadedOnly = false): string | null {
	const kind = avatarKinds.get(name);
	if (!kind || (uploadedOnly ? !kind.uploaded : !kind.uploaded && !kind.bundled)) return null;
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

/** 只返回用户上传头像；用于具有产品级默认头像的固定角色。 */
export function useUploadedAgentAvatar(name: string): string | null {
	const [url, setUrl] = useState<string | null>(() => currentUrl(name, true));
	useEffect(() => {
		ensureLoaded();
		const update = () => setUrl(currentUrl(name, true));
		listeners.add(update);
		update();
		return () => {
			listeners.delete(update);
		};
	}, [name]);
	return url;
}
