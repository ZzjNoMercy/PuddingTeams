import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { contactNameInitial, contactNameKey, groupContactsByName } from "./contact-name-index";

test("Chinese names and polyphonic surnames use surname pronunciation", () => {
	for (const [name, initial] of [["刘大强", "L"], ["周泽宇", "Z"], ["曾小贤", "Z"], ["单田芳", "S"], ["解晓东", "X"], ["区先生", "O"]]) {
		assert.equal(contactNameInitial(name), initial, name);
	}
	assert.equal(contactNameKey("单田芳"), "shantianfang");
});

test("Latin names normalize case, accents, full-width characters and outer spaces", () => {
	for (const [name, initial] of [[" Ada", "A"], ["bob", "B"], ["Émile", "E"], [" Ｚoe ", "Z"]]) assert.equal(contactNameInitial(name), initial);
});

test("empty, numeric and symbol-led names stay in a visible final bucket", () => {
	for (const name of ["", "123", "😀小明", "·李雷"]) assert.equal(contactNameInitial(name), "#");
	assert.deepEqual(groupContactsByName([{ id: "n", name: "123" }, { id: "l", name: "刘大强" }]).map(group => group.initial), ["L", "#"]);
});

test("grouping is deterministic, preserves identity and never mutates input", () => {
	const input = Object.freeze([
		Object.freeze({ id: "z", name: "周泽宇" }), Object.freeze({ id: "lb", name: "刘波" }),
		Object.freeze({ id: "a", name: "Ada" }), Object.freeze({ id: "la", name: "刘安" }),
	]);
	const groups = groupContactsByName(input);
	assert.deepEqual(groups.map(group => group.initial), ["A", "L", "Z"]);
	assert.deepEqual(groups[1].people.map(person => person.id), ["la", "lb"]);
	assert.equal(groups[0].people[0], input[2]);
	assert.deepEqual(input.map(person => person.id), ["z", "lb", "a", "la"]);
	assert.deepEqual(groupContactsByName([{ id: "b", name: "李雷" }, { id: "a", name: "李雷" }])[0].people.map(person => person.id), ["a", "b"]);
});

test("index contains only present filtered groups and supports an empty list", () => {
	assert.deepEqual(groupContactsByName([{ id: "l", name: "刘大强" }]).map(group => group.initial), ["L"]);
	assert.deepEqual(groupContactsByName([]), []);
});

test("compact list only renders avatar and name, with accessible internal-scroll index", () => {
	const source = readFileSync(new URL("../features/contacts/contact-name-list.tsx", import.meta.url), "utf8");
	assert.doesNotMatch(source, /person\.(company|role|topics)|未记录|ChevronRight/);
	assert.match(source, /aria-label=\{person\.name\}/);
	assert.match(source, /aria-pressed=\{activeId === person\.id\}/);
	assert.match(source, /aria-label="姓名首字母索引"/);
	assert.match(source, /list\.scrollTo/);
	assert.doesNotMatch(source, /scrollIntoView/);
	const css = readFileSync(new URL("../features/contacts/contacts.module.css", import.meta.url), "utf8");
	assert.match(css, /\.person\{[^}]*height:52px/);
	assert.match(css, /\.person strong\{[^}]*text-overflow:ellipsis/);
});
