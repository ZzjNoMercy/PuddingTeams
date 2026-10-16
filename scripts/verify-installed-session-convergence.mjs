import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
const cli=process.argv[2], output=process.argv[3];
assert(cli&&path.isAbsolute(cli)&&output&&path.isAbsolute(output),'Usage: node scripts/verify-installed-session-convergence.mjs /absolute/cli /absolute/output');
const run=promisify(execFile),root=path.resolve(import.meta.dirname,'..');
await mkdir(output,{recursive:true});
const cases=[["agent-config-revision", "scripts/verify-installed-agent-config-revision.mjs", "verify"], ["agent-enable-revision", "scripts/verify-installed-agent-enable-revision.mjs"], ["connector-revision", "scripts/verify-installed-connector-revision.mjs"], ["direct-background-activity", "scripts/verify-installed-direct-background-activity.mjs"], ["extension-gate", "scripts/verify-installed-extension-gate.mjs"], ["extension-sigkill", "scripts/verify-installed-extension-sigkill.mjs"], ["first-work-crash", "scripts/verify-installed-first-work-recovery.mjs", "crash"], ["first-work-drop", "scripts/verify-installed-first-work-recovery.mjs", "drop"], ["first-work-corrupt", "scripts/verify-installed-first-work-recovery.mjs", "corrupt"], ["first-work-postaccept", "scripts/verify-installed-first-work-recovery.mjs", "postaccept"], ["group-create-replay", "scripts/verify-installed-group-create-replay.mjs"], ["harness-settings", "scripts/verify-installed-harness-settings.mjs"], ["interrupted-model", "scripts/verify-installed-interrupted-model.mjs"], ["interrupted-tool-after", "scripts/verify-installed-interrupted-tool-turn.mjs", "after-tool"], ["interrupted-tool-during", "scripts/verify-installed-interrupted-tool-turn.mjs", "during-tool"], ["delegation-approve", "scripts/verify-installed-manager-delegation.mjs", "approve"], ["delegation-approve-large", "scripts/verify-installed-manager-delegation.mjs", "approve-large"], ["delegation-large-recovery", "scripts/verify-installed-manager-delegation.mjs", "approve-large-recovery"], ["delegation-pending-switch", "scripts/verify-installed-manager-delegation.mjs", "pending-switch"], ["delegation-single-use", "scripts/verify-installed-delegation-single-use.mjs"], ["delegation-single-use-large", "scripts/verify-installed-delegation-single-use.mjs", "large"], ["manager-native-tools", "scripts/verify-installed-manager-native-tools.mjs"], ["manager-resources-revision", "scripts/verify-installed-manager-resources-revision.mjs"], ["mcp-revision", "scripts/verify-installed-mcp-revision.mjs", "verify"], ["mcp-secret-sigkill", "scripts/verify-installed-mcp-secret-sigkill.mjs"], ["admission-after-user", "scripts/verify-installed-message-admission-crash.mjs", "after_user"], ["admission-after-admission", "scripts/verify-installed-message-admission-crash.mjs", "after_admission"], ["pi-worker-mcp", "scripts/verify-installed-pi-worker-mcp.mjs", "verify"], ["provider-discovery-limit", "scripts/verify-installed-provider-discovery-limit.mjs"], ["provider-structure", "scripts/verify-installed-provider-structure.mjs"], ["room-activity-stream", "scripts/verify-installed-room-activity-stream.mjs", "verify"], ["stale-room-selection", "scripts/verify-installed-stale-room-selection.mjs"], ["native-conversation", "scripts/verify-installed-native-conversation.mjs", "verify"]];
const results=[];
let next=0;
async function runner(){
 while(next<cases.length){
  const [name,script,...args]=cases[next++];const started=Date.now();let ok=true,stdout='',stderr='';
  try{({stdout,stderr}=await run(process.execPath,[path.join(root,script),cli,...args],{cwd:root,timeout:180000,maxBuffer:8*1024*1024}));}
  catch(error){ok=false;stdout=error.stdout??'';stderr=(error.stderr??'')+'\n'+String(error);}
  await writeFile(path.join(output,`${name}.log`),stdout+stderr);
  results.push({name,ok,elapsedMs:Date.now()-started,log:path.join(output,`${name}.log`)});
  console.log(`${ok?'PASS':'FAIL'} ${name}`);
  await writeFile(path.join(output,'summary.json'),JSON.stringify({cli,passed:results.filter(row=>row.ok).length,total:cases.length,results},null,2));
 }
}
await Promise.all([runner(),runner()]);
console.log(JSON.stringify({passed:results.filter(row=>row.ok).length,total:cases.length}));
if(results.some(row=>!row.ok))process.exitCode=1;
