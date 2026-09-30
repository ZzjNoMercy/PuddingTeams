import type { HarnessSettings } from "./api";
import type { ViewerIdentity } from "./types";

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface HarnessSettingsDraft {
	baseline: HarnessSettings;
	value: HarnessSettings;
}

const volatileDrafts = new Map<string, HarnessSettingsDraft | null>();

export function harnessSettingsDraftKey(identity: ViewerIdentity): string {
	return `puddingteams:harness-settings-draft:${encodeURIComponent(identity.tenant.id)}:${encodeURIComponent(identity.user.id)}`;
}

function matchesShape(reference: unknown, candidate: unknown): boolean {
	if (reference === null || candidate === null) return reference === candidate;
	if (typeof reference !== typeof candidate) return false;
	if (typeof reference !== "object") return true;
	if (Array.isArray(reference) || Array.isArray(candidate)) {
		return Array.isArray(reference) && Array.isArray(candidate) && reference.length === candidate.length && reference.every((item, index) => matchesShape(item, candidate[index]));
	}
	const base = reference as Record<string, unknown>;
	const next = candidate as Record<string, unknown>;
	const keys = Object.keys(base);
	return keys.length === Object.keys(next).length && keys.every((key) => Object.hasOwn(next, key) && matchesShape(base[key], next[key]));
}

/** Reject malformed or obsolete drafts before they can populate controlled settings fields. */
export function loadHarnessSettingsDraft(key: string, storage: () => DraftStorage): HarnessSettingsDraft | null {
	let parsed: unknown;
	if (volatileDrafts.has(key)) parsed = volatileDrafts.get(key);
	else {
		try { parsed = JSON.parse(storage().getItem(key) ?? "null") as unknown; }
		catch { return null; }
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	if (!record.baseline || typeof record.baseline !== "object" || Array.isArray(record.baseline) || !matchesShape(record.baseline, record.value)) return null;
	const draft = { baseline: record.baseline as HarnessSettings, value: record.value as HarnessSettings };
	volatileDrafts.set(key, draft);
	return draft;
}

export function saveHarnessSettingsDraft(key: string, draft: HarnessSettingsDraft, storage: () => DraftStorage): void {
	volatileDrafts.set(key, draft);
	try { storage().setItem(key, JSON.stringify(draft)); }
	catch { /* The in-memory draft still survives same-tab route changes. */ }
}

export function clearHarnessSettingsDraft(key: string, storage: () => DraftStorage): void {
	volatileDrafts.set(key, null);
	try { storage().removeItem(key); }
	catch { /* Do not resurrect a submitted draft after storage deletion fails. */ }
}

export function harnessDraftMatchesServer(draft: HarnessSettingsDraft, current: HarnessSettings): boolean {
	return matchesShape(current, draft.value) && JSON.stringify(draft.baseline) === JSON.stringify(current);
}

/** Merge independent field edits; never choose a winner for the same changed leaf. */
export function mergeHarnessSettingsDraft(draft: HarnessSettingsDraft, current: HarnessSettings): { value: HarnessSettings; conflicts: string[] } | null {
	if (!matchesShape(current, draft.baseline) || !matchesShape(current, draft.value)) return null;
	const conflicts: string[] = [];
	const merge = (baseline: unknown, local: unknown, remote: unknown, path: string): unknown => {
		if (baseline !== null && typeof baseline === "object" && !Array.isArray(baseline)) {
			return Object.fromEntries(Object.keys(baseline).map((key) => [key, merge(
				(baseline as Record<string, unknown>)[key],
				(local as Record<string, unknown>)[key],
				(remote as Record<string, unknown>)[key],
				path ? `${path}.${key}` : key,
			)]));
		}
		const same = (left: unknown, right: unknown) => Array.isArray(left) && Array.isArray(right) ? JSON.stringify(left) === JSON.stringify(right) : Object.is(left, right);
		if (same(local, baseline)) return remote;
		if (same(remote, baseline) || same(local, remote)) return local;
		conflicts.push(path);
		return remote;
	};
	return { value: merge(draft.baseline, draft.value, current, "") as HarnessSettings, conflicts };
}
