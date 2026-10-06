import { pinyin } from "pinyin-pro";

export interface ContactNameEntry { id: string; name: string }
export interface ContactNameGroup<T extends ContactNameEntry> { initial: string; people: T[] }
const names = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const keys = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Use surname pronunciation, not a Han-character range approximation. */
export function contactNameKey(name: string): string {
	const normalized = name.trim().normalize("NFKC");
	return pinyin(normalized, { surname: "head", toneType: "none", nonZh: "consecutive", separator: "", v: true })
		.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function contactNameInitial(name: string): string {
	const initial = Array.from(contactNameKey(name))[0]?.toUpperCase() ?? "";
	return /^[A-Z]$/.test(initial) ? initial : "#";
}

/** Group only the authorized, filtered people supplied by the caller. Never mutate API data. */
export function groupContactsByName<T extends ContactNameEntry>(people: readonly T[]): ContactNameGroup<T>[] {
	const indexed = people.map(person => {
		const key = contactNameKey(person.name);
		const first = Array.from(key)[0]?.toUpperCase() ?? "";
		return { person, key, initial: /^[A-Z]$/.test(first) ? first : "#" };
	});
	indexed.sort((a, b) => {
		const aGroup = a.initial === "#" ? "[" : a.initial;
		const bGroup = b.initial === "#" ? "[" : b.initial;
		return (aGroup < bGroup ? -1 : aGroup > bGroup ? 1 : 0)
			|| keys.compare(a.key, b.key) || names.compare(a.person.name, b.person.name) || a.person.id.localeCompare(b.person.id);
	});
	const groups: ContactNameGroup<T>[] = [];
	for (const item of indexed) {
		let group = groups[groups.length - 1];
		if (group?.initial !== item.initial) {
			group = { initial: item.initial, people: [] };
			groups.push(group);
		}
		group.people.push(item.person);
	}
	return groups;
}
