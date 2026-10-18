import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

test("person and relationship previews share a viewport-bounded modal with focus restoration", () => {
 for (const file of ["person-detail-surface.tsx", "interaction-panel.tsx"]) assert.match(read(file), /<ContactPreviewDialog/);
 const source = read("contact-preview-dialog.tsx"), css = read("contact-preview.module.css");
 assert.match(source, /<Dialog open onOpenChange=/);
 assert.match(source, /<DialogTitle/); assert.match(source, /<DialogDescription/);
 assert.match(source, /onCloseAutoFocus/); assert.match(source, /target\?\.isConnected/);
 assert.match(source, /focus\(\{ preventScroll: true \}\)/);
 assert.match(css, /width:min\(1100px,calc\(100vw - 32px\)\)/);
 assert.match(css, /height:min\(780px,85dvh\)/);
 assert.match(css, /@media\(max-width:600px\)/);
});

test("profile preview fixes the identity and tabs while only its body scrolls, keeping list mode inline", () => {
 const source = read("person-detail-surface.tsx"), css = read("contact-preview.module.css");
 assert.match(source, /if \(!modal\) return <article className=\{styles.detail\}>/);
 assert.match(source, /if \(!open\) return null/);
 assert.ok(source.indexOf("</header>") < source.indexOf("<article className={preview.profileBody}>"));
 assert.match(css, /\.profileHeader\{flex-shrink:0/);
 assert.match(css, /\.profileBody\{flex:1;min-height:0;overflow-y:auto/);
 assert.match(css, /scrollbar-gutter:stable/);
});

test("graph stays mounted and full width when a person or edge preview opens", () => {
 const css = read("contacts.module.css"), graph = read("contacts-graph.tsx");
 assert.doesNotMatch(css, /\.layout\[data-view=graph\]\[data-person-open=true\]>section\{display:none/);
 assert.doesNotMatch(css, /flex:0 0 355px/);
 assert.match(graph, /event.currentTarget.focus\(\); setEdgeId\(item.id\)/);
 assert.match(graph, /event.currentTarget.focus\(\); start\(event, person.id\)/);
 assert.match(read("contacts-app.tsx"), /<ContactsGraph key=\{vault\}/);
});

test("interaction selection is scoped to the response key and does not navigate for each record", () => {
 const source = read("interaction-panel.tsx");
 assert.match(source, /selection\?\.key === key && items.find/);
 assert.match(source, /onClick=\{\(\) => setSelection\(\{ key, id: item.id \}\)\}/);
 assert.match(source, /current = result\?\.key === key \? result : null/);
 assert.match(source, /if \(active\) setResult/);
 assert.match(source, /setStatus\(value as keyof typeof statuses\); setOffset\(0\)/);
 assert.match(source, /setOffset\(current.data!.nextOffset!\)/);
 assert.match(source, /打开原始记录/);
 assert.match(source, /人物关系与引用/);
 assert.match(source, /setRetry\(value => value \+ 1\)/);
});

test("interaction list, details and pagination have separate stable scroll boundaries", () => {
 const css = read("interaction-panel.module.css");
 assert.match(css, /\.workspace\{display:grid;[^}]*min-height:0;flex:1;overflow:hidden/);
 for (const name of ["list", "detail"]) assert.match(css, new RegExp(`\\.${name}\\{[^}]*overflow-y:auto;[^}]*scrollbar-gutter:stable`));
 assert.match(css, /\.pages\{[^}]*flex-shrink:0/);
 assert.match(css, /grid-template-rows:minmax\(120px,38%\) minmax\(0,1fr\)/);
});
