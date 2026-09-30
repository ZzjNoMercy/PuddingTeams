import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { clearManagerWorkDraft, loadManagerWorkDraft, managerWorkStorage, managerWorkSubmissionDecision, pendingManagerWorkMatches, saveManagerWorkDraft } from "./manager-work-draft.js";

test("an attempted Manager work keeps its original operation while the visible draft changes", () => {
	const key = `work-${randomUUID()}`;
	const items = new Map<string, string>();
	const storage = () => ({
		getItem: (item: string) => items.get(item) ?? null,
		setItem: (item: string, value: string) => { items.set(item, value); },
		removeItem: (item: string) => { items.delete(item); },
	});
	const pendingSubmission = { operationId: "work-op-pending-0001", content: "原工作", modelRef: "model-a", thinkingLevel: "high", attachmentCount: 1 };
	saveManagerWorkDraft(key, { content: "原工作", modelRef: "model-a", thinkingLevel: "high", attachmentCount: 1, operationId: pendingSubmission.operationId, pendingSubmission }, storage);
	saveManagerWorkDraft(key, { content: "编辑后的工作", modelRef: "model-a", thinkingLevel: "high", attachmentCount: 1, operationId: "", pendingSubmission }, storage);
	const restored = loadManagerWorkDraft(key, storage);
	assert.deepEqual(restored.pendingSubmission, pendingSubmission);
	assert.equal(pendingManagerWorkMatches(restored, pendingSubmission), false);
	assert.equal(pendingManagerWorkMatches({ content: "原工作", modelRef: "model-a", thinkingLevel: "high", attachmentCount: 1 }, pendingSubmission), true);
	assert.equal(pendingManagerWorkMatches({ content: "原工作", modelRef: "model-b", attachmentCount: 1 }, pendingSubmission), false);
	assert.equal(pendingManagerWorkMatches({ content: "原工作", modelRef: "model-a", attachmentCount: 0 }, pendingSubmission), false);
	assert.equal(managerWorkSubmissionDecision(restored, pendingSubmission, { forceNewKey: false, historyReviewed: false, originalDeleted: false, sameAttachments: true }), "review_required");
	assert.equal(managerWorkSubmissionDecision({ content: "原工作", modelRef: "model-a", thinkingLevel: "high", attachmentCount: 1 }, pendingSubmission, { forceNewKey: false, historyReviewed: false, originalDeleted: false, sameAttachments: true }), "retry");
	assert.equal(managerWorkSubmissionDecision({ content: "原工作", modelRef: "model-a", thinkingLevel: "high", attachmentCount: 1 }, pendingSubmission, { forceNewKey: false, historyReviewed: false, originalDeleted: false, sameAttachments: false }), "review_required", "same-count replacement attachment is not the original request");
	assert.equal(managerWorkSubmissionDecision(restored, pendingSubmission, { forceNewKey: true, historyReviewed: false, originalDeleted: false, sameAttachments: true }), "review_required");
	assert.equal(managerWorkSubmissionDecision(restored, pendingSubmission, { forceNewKey: true, historyReviewed: true, originalDeleted: false, sameAttachments: true }), "new");
	assert.equal(managerWorkSubmissionDecision({ content: "原工作", modelRef: "model-a", thinkingLevel: "high", attachmentCount: 1 }, pendingSubmission, { forceNewKey: false, historyReviewed: true, originalDeleted: true, sameAttachments: true }), "review_required");
	assert.equal(clearManagerWorkDraft(key, storage, { content: "原工作", modelRef: "model-a", attachmentCount: 1, operationId: pendingSubmission.operationId, pendingSubmission }), false);
	assert.deepEqual(loadManagerWorkDraft(key, storage), restored);
});

test("reload preserves a pending Manager operation when edited attachments are no longer available", () => {
	const key = `work-${randomUUID()}`;
	const pendingSubmission = { operationId: "work-op-reload-0001", content: "带附件的原工作", modelRef: "model-a", thinkingLevel: "", attachmentCount: 2 };
	let saved = JSON.stringify({ content: "带附件的原工作", operationId: "", modelRef: "model-a", attachmentCount: 0, pendingSubmission });
	const storage = () => ({
		getItem: () => saved,
		setItem: (_item: string, value: string) => { saved = value; },
		removeItem: () => { saved = ""; },
	});
	const restored = loadManagerWorkDraft(key, storage);
	assert.deepEqual(restored.pendingSubmission, pendingSubmission);
	assert.equal(managerWorkSubmissionDecision(restored, restored.pendingSubmission!, { forceNewKey: false, historyReviewed: false, originalDeleted: false, sameAttachments: false }), "review_required");
});

test("reload retains only validated attachment fingerprints with the pending operation", () => {
	const key = `work-${randomUUID()}`;
	const fingerprint = "a".repeat(64);
	let saved = JSON.stringify({ content: "带附件", operationId: "same-op", attachmentCount: 1, pendingSubmission: { operationId: "same-op", content: "带附件", modelRef: "", thinkingLevel: "", attachmentCount: 1, attachmentFingerprints: [fingerprint] } });
	const storage = () => ({ getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; }, removeItem: () => { saved = ""; } });
	assert.deepEqual(loadManagerWorkDraft(key, storage).pendingSubmission?.attachmentFingerprints, [fingerprint]);
	saved = JSON.stringify({ content: "带附件", operationId: "same-op", attachmentCount: 1, pendingSubmission: { operationId: "same-op", content: "带附件", modelRef: "", thinkingLevel: "", attachmentCount: 1, attachmentFingerprints: [`fnv64-${"a".repeat(16)}`] } });
	assert.deepEqual(loadManagerWorkDraft(key, storage).pendingSubmission?.attachmentFingerprints, [`fnv64-${"a".repeat(16)}`]);
	saved = JSON.stringify({ content: "带附件", operationId: "same-op", attachmentCount: 1, pendingSubmission: { operationId: "same-op", content: "带附件", modelRef: "", attachmentCount: 1, attachmentFingerprints: ["bad"] } });
	assert.equal(loadManagerWorkDraft(key, storage).pendingSubmission?.attachmentFingerprints, undefined);
});

test("new work drafts use tab-scoped browser storage", () => {
	const previousSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
	const previousLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	const session = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } as unknown as Storage;
	const local = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined } as unknown as Storage;
	Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: session });
	Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
	try { assert.equal(managerWorkStorage(), session); }
	finally {
		if (previousSession) Object.defineProperty(globalThis, "sessionStorage", previousSession);
		else Reflect.deleteProperty(globalThis, "sessionStorage");
		if (previousLocal) Object.defineProperty(globalThis, "localStorage", previousLocal);
		else Reflect.deleteProperty(globalThis, "localStorage");
	}
});

test("same-tab Manager drafts and operation IDs survive context switches when storage is denied", () => {
	const a = `work-a-${randomUUID()}`;
	const b = `work-b-${randomUUID()}`;
	const denied = () => { throw new Error("storage denied"); };
	saveManagerWorkDraft(a, { content: "A 项目草稿", operationId: "work-op-a-0001" }, denied);
	saveManagerWorkDraft(b, { content: "B 项目草稿", operationId: "work-op-b-0001" }, denied);
	assert.deepEqual(loadManagerWorkDraft(a, denied), { content: "A 项目草稿", operationId: "work-op-a-0001" });
	assert.deepEqual(loadManagerWorkDraft(b, denied), { content: "B 项目草稿", operationId: "work-op-b-0001" });
	clearManagerWorkDraft(a, denied);
	assert.deepEqual(loadManagerWorkDraft(a, denied), { content: "", operationId: "" });
	assert.deepEqual(loadManagerWorkDraft(b, denied), { content: "B 项目草稿", operationId: "work-op-b-0001" });
});

test("failed storage deletion cannot resurrect a sent draft during same-tab navigation", () => {
	const key = `work-${randomUUID()}`;
	let saved = "";
	const storage = () => ({
		getItem: () => saved,
		setItem: (_key: string, value: string) => { saved = value; },
		removeItem: () => { throw new Error("remove denied"); },
	});
	saveManagerWorkDraft(key, { content: "已提交", operationId: "work-op-0001" }, storage);
	clearManagerWorkDraft(key, storage);
	assert.match(saved, /已提交/, "browser copy still exists after failed deletion");
	assert.deepEqual(loadManagerWorkDraft(key, storage), { content: "", operationId: "" });
});

test("late send confirmation only clears the draft version it submitted", () => {
	const key = `work-${randomUUID()}`;
	const items = new Map<string, string>();
	const storage = () => ({
		getItem: (item: string) => items.get(item) ?? null,
		setItem: (item: string, value: string) => { items.set(item, value); },
		removeItem: (item: string) => { items.delete(item); },
	});
	const submitted = { content: "最初的工作", operationId: "work-op-0001" };
	saveManagerWorkDraft(key, submitted, storage);
	saveManagerWorkDraft(key, { content: "等待期间的新草稿", operationId: "" }, storage);
	assert.equal(clearManagerWorkDraft(key, storage, submitted), false);
	assert.deepEqual(loadManagerWorkDraft(key, storage), { content: "等待期间的新草稿", operationId: "" });
	saveManagerWorkDraft(key, { content: submitted.content, operationId: "work-op-0002" }, storage);
	assert.equal(clearManagerWorkDraft(key, storage, submitted), false, "same text with a newer operation must survive");
	assert.deepEqual(loadManagerWorkDraft(key, storage), { content: submitted.content, operationId: "work-op-0002" });
	saveManagerWorkDraft(key, { content: "等待期间的新草稿", operationId: "" }, storage);
	assert.equal(clearManagerWorkDraft(key, storage, { content: "等待期间的新草稿", operationId: "" }), true);
	assert.deepEqual(loadManagerWorkDraft(key, storage), { content: "", operationId: "" });
});

test("changing a new work's model preserves its draft and invalidates the old send confirmation", () => {
	const key = `work-${randomUUID()}`;
	const denied = () => { throw new Error("storage denied"); };
	const submitted = { content: "检查项目", operationId: "work-model-0001", modelRef: "openai/first" };
	saveManagerWorkDraft(key, submitted, denied);
	saveManagerWorkDraft(key, { content: submitted.content, operationId: "", modelRef: "openai/second" }, denied);
	assert.equal(clearManagerWorkDraft(key, denied, submitted), false);
	assert.deepEqual(loadManagerWorkDraft(key, denied), { content: "检查项目", operationId: "", modelRef: "openai/second" });
});

test("late send confirmation does not remove a newer draft written by another tab", () => {
	const key = `work-${randomUUID()}`;
	const items = new Map<string, string>();
	const storage = () => ({
		getItem: (item: string) => items.get(item) ?? null,
		setItem: (item: string, value: string) => { items.set(item, value); },
		removeItem: (item: string) => { items.delete(item); },
	});
	const submitted = { content: "已提交的工作", operationId: "work-op-0001" };
	saveManagerWorkDraft(key, submitted, storage);
	const newer = { content: "另一个标签页的新工作", operationId: "work-op-0002" };
	items.set(key, JSON.stringify(newer));
	assert.equal(clearManagerWorkDraft(key, storage, submitted), false);
	assert.equal(items.get(key), JSON.stringify(newer));
	assert.deepEqual(loadManagerWorkDraft(key, storage), newer);
});

test("completed send tombstone survives failed removal but accepts a later cross-tab draft", () => {
	const key = `work-${randomUUID()}`;
	let saved: string | null = null;
	const storage = () => ({
		getItem: () => saved,
		setItem: (_key: string, value: string) => { saved = value; },
		removeItem: () => { throw new Error("remove denied"); },
	});
	const submitted = { content: "已完成", operationId: "work-op-0001" };
	saveManagerWorkDraft(key, submitted, storage);
	assert.equal(clearManagerWorkDraft(key, storage, submitted), true);
	assert.deepEqual(loadManagerWorkDraft(key, storage), { content: "", operationId: "" });
	const newer = { content: "另一标签页后来新写", operationId: "work-op-0002" };
	saved = JSON.stringify(newer);
	assert.deepEqual(loadManagerWorkDraft(key, storage), newer);
});

test("storage write failure retains this tab's newer unsaved draft", () => {
	const key = `work-${randomUUID()}`;
	let saved: string | null = null;
	let failWrite = false;
	const storage = () => ({
		getItem: () => saved,
		setItem: (_key: string, value: string) => { if (failWrite) throw new Error("write denied"); saved = value; },
		removeItem: () => { saved = null; },
	});
	saveManagerWorkDraft(key, { content: "旧草稿", operationId: "work-op-0001" }, storage);
	failWrite = true;
	const newer = { content: "未能持久写入的新草稿", operationId: "work-op-0002" };
	saveManagerWorkDraft(key, newer, storage);
	assert.deepEqual(loadManagerWorkDraft(key, storage), newer);
	assert.match(saved ?? "", /旧草稿/);
});
