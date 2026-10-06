/** Focus ownership and visible keyboard focus are different concerns. */
const discreteControls = 'button, a[href], select, summary, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], input:is([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="range"], [type="color"], [type="file"])';

export function isKeyboardInteraction(event: {
	key: string; isComposing?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean;
}): boolean {
	return !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey
		&& !["Shift", "Control", "Alt", "Meta", "CapsLock", "Unidentified"].includes(event.key);
}

/** Delegation covers native selects, dynamically mounted controls and Radix portals.
 * Never blur: returning focus to a menu trigger remains useful for keyboard users.
 * Text editors are intentionally excluded: their editing focus stays visible.
 */
export function installFocusModality(doc: Document): () => void {
	let pointer = false;
	let marked: Element | null = null;
	const clear = () => {
		marked?.removeAttribute("data-pointer-focus");
		marked = null;
	};
	const sync = () => {
		clear();
		const active = doc.activeElement;
		if (pointer && active?.matches(discreteControls)) {
			active.setAttribute("data-pointer-focus", "true");
			marked = active;
		}
	};
	const onPointer = () => { pointer = true; sync(); };
	const onKey = (event: KeyboardEvent) => {
		if (isKeyboardInteraction(event)) { pointer = false; sync(); }
	};
	doc.addEventListener("pointerdown", onPointer, true);
	doc.addEventListener("keydown", onKey, true);
	doc.addEventListener("focusin", sync, true);
	doc.addEventListener("focusout", clear, true);
	return () => {
		clear();
		doc.removeEventListener("pointerdown", onPointer, true);
		doc.removeEventListener("keydown", onKey, true);
		doc.removeEventListener("focusin", sync, true);
		doc.removeEventListener("focusout", clear, true);
	};
}
