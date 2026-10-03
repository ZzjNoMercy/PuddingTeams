import assert from "node:assert/strict";
import { test } from "node:test";
import { curatorJobRetryLabel, taskResultLabel, taskStatusMessage } from "./curator-job-presentation.js";
test("registration recovery keeps frozen changes distinct from regeneration",()=>{
 assert.deepEqual(taskStatusMessage({displayStatus:"failed",canRetryRegistration:true}),["修改已保留，尚未送达审核","继续提交即可，无需重新整理资料。"]);
 assert.equal(curatorJobRetryLabel({status:"cancelled",executionMode:"background"}),"重试解析与整理");
 assert.equal(curatorJobRetryLabel({status:"cancelled",executionMode:"worker"}),null);
});
test("missing review, uncertain publication and no changes do not invent completion or duplicates",()=>{
 assert.match(taskStatusMessage({displayStatus:"unavailable",publication:{state:"unknown"}})[0],/更新结果待核对/);
 assert.match(taskStatusMessage({displayStatus:"unavailable"})[0],/审核记录暂不可用/);
 assert.doesNotMatch(taskStatusMessage({displayStatus:"nochanges"}).join(""),/已有|重复|发布/);
 assert.match(taskStatusMessage({displayStatus:"approved"})[1],/尚未完成发布/);
 assert.doesNotMatch(taskStatusMessage({displayStatus:"failed",failureCode:"provider-secret-trace"}).join(""),/provider-secret-trace/);
});
test("results separate pages, indexes, attachments and unknown quantities",()=>{
 assert.equal(taskResultLabel(),"—");
 assert.equal(taskResultLabel({added:1,updated:2,deleted:0,directories:2,attachments:1}),"新增 1 篇 · 更新 2 篇 · 目录 2 项 · 附件 1 个");
});
