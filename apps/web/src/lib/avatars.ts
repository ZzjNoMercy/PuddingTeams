"use client";

import { useEffect, useState } from "react";
import { agentAvatarUrl, listAgents } from "./api";

/**
 * Module-level registry of which agents have an uploaded avatar (§11). The
 * WorkerAvatar component is used in many places (agents cards, sidebar,
 * member popover, member message flow) and most call sites only know the
 * worker *name* — so instead of threading the avatar field through every
 * prop chain, this cache resolves name → avatar URL in one place.
 *
 * name/id 解耦后，同一注册表也缓存 name → displayName，供只有内部 id 的
 * 展示位（委托卡、审批卡、等待提示）渲染显示名。
 */

/** name -> per-agent cache-busting version (bumped on upload/delete). */
const versions = new Map<string, number>();
/** name -> uploaded avatar / connector-bundled avatar availability. */
const avatarKinds = new Map<string, { uploaded: boolean; bundled: boolean }>();
/** 内部 id（name）-> 显示名（displayName 缺省回退 name）。 */
const displayNames = new Map<string, string>();
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
				displayNames.set(a.name, a.displayName?.trim() || a.name);
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
	displayNames.delete(name);
	emit();
}

/** Record a display-name change so every id-only 展示位即时刷新。 */
export function agentRenamed(name: string, displayName?: string): void {
	displayNames.set(name, displayName?.trim() || name);
	emit();
}

/** 显示名快照（同步读取；首次渲染可能回退 id，ensureLoaded 完成后经 hook 刷新）。 */
export function agentLabel(name: string): string {
	return displayNames.get(name) ?? name;
}

/** 内部 id → 显示名的响应式 hook（委托卡/审批卡等只有 id 的展示位用）。 */
export function useAgentLabel(name: string): string {
	const [label, setLabel] = useState<string>(() => agentLabel(name));
	useEffect(() => {
		ensureLoaded();
		const update = () => setLabel(agentLabel(name));
		listeners.add(update);
		update();
		return () => {
			listeners.delete(update);
		};
	}, [name]);
	return label;
}

/** 全量 id → 显示名映射（列表类场景一次取用，避免变长 hook）。 */
export function useAgentLabels(): Record<string, string> {
	const [labels, setLabels] = useState<Record<string, string>>(() => Object.fromEntries(displayNames));
	useEffect(() => {
		ensureLoaded();
		const update = () => setLabels(Object.fromEntries(displayNames));
		listeners.add(update);
		update();
		return () => {
			listeners.delete(update);
		};
	}, []);
	return labels;
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
