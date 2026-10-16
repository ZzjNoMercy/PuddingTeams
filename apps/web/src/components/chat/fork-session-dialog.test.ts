import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const dialog = read("fork-session-dialog.tsx");

test("Fork dialog uses a labelled full-width selector and separate footer actions", () => {
 assert.match(dialog, /const workerFieldId=useId\(\)/);
 assert.match(dialog, /<label htmlFor=\{workerFieldId\}>目标 Worker<\/label>/);
 assert.match(dialog, /<SelectTrigger id=\{workerFieldId\}/);
 assert.match(dialog, /<DialogFooter className=\{styles.footer\}>/);
 assert.match(dialog, /variant="ghost" disabled=\{busy\} onClick=\{\(\)=>onOpenChange\(false\)\}>取消/);
});

test("Fork presentation preserves receipt identity and blocks dismissal during submission", () => {
 assert.match(dialog, /showCloseButton=\{!busy\}/);
 assert.match(dialog, /onEscapeKeyDown=\{event=>\{if\(busy\)event.preventDefault\(\);\}\}/);
 assert.match(dialog, /onPointerDownOutside=\{event=>\{if\(busy\)event.preventDefault\(\);\}\}/);
 assert.match(dialog, /mode==="snapshot"&&\(Boolean\(intent\)\|\|!data\?\.targets.length\)/);
 assert.match(dialog, /"idempotency-key":operation.key/);
 assert.match(dialog, /expectedSourceLeafEntryId:operation.expectedSourceLeafEntryId/);
 assert.match(dialog, /sessionStorage.setItem\(storageKey,JSON.stringify\(operation\)\)/);
 assert.match(dialog, /setResetAllowed\(body.canStartNewIntent===true\)/);
 assert.match(dialog, /role="alert"/);
});

test("Fork dialog offers a reference-only mode that copies the deep link without snapshotting", () => {
 assert.match(dialog, /type Mode = "snapshot" \| "reference"/);
 assert.match(dialog, /仅引用链接/);
 assert.match(dialog, /sessionShareLink\(roomId,sourceId\)/);
 assert.match(dialog, /navigator\.clipboard\.writeText\(link\)/);
 assert.match(dialog, /room\.type==="direct"&&room\.members\.some\(member=>member\.name===worker\)/);
 assert.match(dialog, /listRoomsWithContext\(\)/);
});

test("Fork errors speak plainly and distinguish pointless retries", () => {
 assert.match(dialog, /snapshot_too_large:"这段对话超出了目标 Worker 能导入的大小上限，无法创建快照对话"/);
 assert.match(dialog, /errorCode==="snapshot_too_large"\?"重试不会改变结果，请换一段更短的对话。"/);
 assert.match(dialog, /intent\?"重试上一次 Fork":"创建快照对话"/);
});

test("Fork layout is viewport-bounded with a scrollable body and stable footer", () => {
 const css = read("fork-session-dialog.module.css");
 assert.match(css, /width:440px;max-width:calc\(100vw - 32px\)/);
 assert.match(css, /max-height:calc\(100dvh - 32px\)/);
 assert.match(css, /\.body\{[^}]*min-height:0;overflow-y:auto/);
 assert.match(css, /\.field \.select\{width:100%;height:40px/);
 assert.match(css, /\.footer\{display:flex;flex-direction:row;justify-content:flex-end;gap:8px;flex-shrink:0/);
 assert.match(css, /background:var\(--popover\)/);
});
