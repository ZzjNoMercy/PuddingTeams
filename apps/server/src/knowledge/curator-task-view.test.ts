import assert from "node:assert/strict";
import { test } from "node:test";
import { curatorTaskView, inTaskGroup } from "./curator-task-view.js";
import type { CuratorJob } from "./curator-jobs.js";
import type { StoredReviewBatch } from "./wiki/review-store.js";
import type { StoredPublishOperation } from "./wiki/publish-journal.js";
const job = {id:"job",ownerId:"owner",targetBindingId:"vault",status:"pending_review",candidateBatchId:"batch",task:"【内部指令】不要作为标题",createdAt:"2026-10-01T00:00:00Z",updatedAt:"2026-10-01T00:01:00Z",sources:[{kind:"text",title:"联系资料",origin:{channel:"user_input"}}]} as CuratorJob;
const review = {ownerId:"owner",status:"pending_review",updatedAt:"2026-10-01T00:02:00Z",batch:{id:"batch",bindingId:"vault",manifestHash:"hash",files:[{targetPath:"wiki/People/联系人.md",operation:"create",candidateHash:"a"},{targetPath:"wiki/index.md",operation:"update",candidateHash:"b"},{targetPath:"wiki/assets/图.png",operation:"create",kind:"image",candidateHash:"c"}]}} as StoredReviewBatch;
const publication = {id:"pub",ownerId:"owner",bindingId:"vault",batchId:"batch",manifestHash:"hash",state:"published",updatedAt:"2026-10-01T00:03:00Z",files:[{targetPath:"wiki/People/联系人.md",candidateHash:"a",operation:"create",status:"applied"}]} as StoredPublishOperation;
test("same job follows actual review/publication rather than remaining pending forever", () => {
	assert.equal(curatorTaskView(job,review).displayStatus,"pending");
	assert.equal(curatorTaskView(job,{...review,status:"approved"}).displayStatus,"approved");
	assert.equal(curatorTaskView(job,{...review,status:"publishing"}).displayStatus,"publishing");
	const published = curatorTaskView(job,{...review,status:"published"},"人脉",publication);
	assert.equal(published.displayStatus,"published"); assert.equal(published.activityAt,publication.updatedAt);assert.equal(published.publication?.applied,1);
	assert.equal(curatorTaskView(job,{...review,status:"returned",returnRequest:{feedback:"请修改",jobId:"child"} as StoredReviewBatch["returnRequest"]}).review?.revisionJobId,"child");
	assert.equal(curatorTaskView(job,{...review,status:"conflict",conflictClosure:{} as StoredReviewBatch["conflictClosure"]}).displayStatus,"closed");
	assert.equal(curatorTaskView(job,{...review,status:"publishing"},"人脉",{...publication,state:"unknown"}).displayStatus,"unavailable");
});
test("cross owner/binding/batch and frozen manifest cannot leak review or publish results", () => {
	for (const r of [{...review,ownerId:"other"},{...review,batch:{...review.batch,bindingId:"other"}},{...review,batch:{...review.batch,id:"other"}}]) {const v=curatorTaskView(job,r);assert.equal(v.review,undefined);assert.equal(v.result,undefined);assert.equal(v.displayStatus,"unavailable");}
	assert.equal(curatorTaskView({...job,frozenCandidate:{manifestHash:"another"} as CuratorJob["frozenCandidate"]},review).review,undefined);
	for (const p of [{...publication,ownerId:"other"},{...publication,bindingId:"other"},{...publication,batchId:"other"},{...publication,manifestHash:"other"}]) assert.equal(curatorTaskView(job,review,"人脉",p).publication,undefined);
});
test("human title comes from material; page, directory and image counts are distinct", () => {
	const view=curatorTaskView(job,review);assert.equal(view.title,"联系资料");assert.deepEqual(view.result,{added:1,updated:0,deleted:0,directories:1,attachments:1});
	assert.doesNotMatch(curatorTaskView({...job,sources:[{...job.sources[0]!,origin:{channel:"agent_task"}}]},undefined,"人脉").title,/内部指令/);
	assert.equal(inTaskGroup("approved","active"),true);assert.equal(inTaskGroup("published","pending"),false);assert.equal(inTaskGroup("returned","failed"),true);
});
