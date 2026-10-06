"use client";

import { useEffect, useId, useMemo, useRef } from "react";
import { groupContactsByName } from "@/lib/contact-name-index";
import type { ContactSummary } from "@/lib/contacts";
import { ContactAvatar } from "./contact-avatar";
import styles from "./contacts.module.css";

export function ContactNameList({ vault, people, activeId, alphabetical, resetKey, truncated, onSelect, onClear }: {
	vault: string;
	people: ContactSummary[];
	activeId: string;
	alphabetical: boolean;
	resetKey: string;
	truncated: boolean;
	onSelect: (id: string) => void;
	onClear: () => void;
}) {
	const id = useId();
	const scroll = useRef<HTMLDivElement>(null);
	const sections = useRef(new Map<string, HTMLElement>());
	const groups = useMemo(() => alphabetical ? groupContactsByName(people) : [{ initial: "", people }], [people, alphabetical]);
	useEffect(() => { scroll.current?.scrollTo({ top: 0 }); }, [resetKey]);
	const jump = (initial: string) => {
		const list = scroll.current, section = sections.current.get(initial);
		if (list && section) list.scrollTo({ top: Math.max(0, list.scrollTop + section.getBoundingClientRect().top - list.getBoundingClientRect().top) });
	};
	return <div className={styles.listBody}>
		<div className={styles.listScroll} ref={scroll} id={`${id}-list`} aria-label="联系人列表">
			{groups.map(({ initial, people: entries }) => <section key={initial} ref={element => { if (element) sections.current.set(initial, element); else sections.current.delete(initial); }} aria-labelledby={initial ? `${id}-${initial}` : undefined}>
				{initial && <h3 className={styles.initialHeading} id={`${id}-${initial}`}>{initial}</h3>}
				<ul className={styles.personRows}>{entries.map(person => <li key={person.id}>
					<button type="button" className={`${styles.person} ${activeId === person.id ? styles.active : ""}`} aria-label={person.name} title={person.name} aria-pressed={activeId === person.id} onClick={() => onSelect(person.id)}>
						<ContactAvatar vault={vault} person={person} /><strong>{person.name}</strong>
					</button>
				</li>)}</ul>
			</section>)}
			{!people.length && <div className={styles.noResult}><h3>没有匹配的联系人</h3><button type="button" onClick={onClear}>清除筛选</button></div>}
			{truncated && <p className={styles.listLimit}>仅显示前 1000 位，请缩小筛选范围。</p>}
		</div>
		{alphabetical && people.length > 0 && <nav className={styles.alphabetIndex} aria-label="姓名首字母索引">
			{groups.map(({ initial }) => <button type="button" key={initial} aria-label={`跳转到 ${initial} 开头的联系人`} aria-controls={`${id}-list`} onClick={() => jump(initial)}>{initial}</button>)}
		</nav>}
	</div>;
}
