import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
const cli=process.argv[2],mode=process.argv[3]??'verify';
if(!cli||!path.isAbsolute(cli)||!['verify','browser-hold'].includes(mode))throw new Error('Usage: node scripts/verify-installed-native-conversation.mjs /absolute/cli [verify|browser-hold]');
const run=promisify(execFile),home=await mkdtemp('/private/tmp/puddingteams-p3-native-');
const env={...process.env,PATH:'/opt/homebrew/bin:/usr/bin:/bin',HOME:home,PUDDINGTEAMS_HOME:home,PI_CODING_AGENT_DIR:path.join(home,'agent'),PI_OFFLINE:'1'};
const requests=[],mcpCalls=[],sockets=new Set();let mcpGets=0,fixture;
const release=path.join(home,'release-slow');
const mock=createServer(async(req,res)=>{
 if(req.url==='/__fixture/release'&&req.method==='POST'){await writeFile(release,'go');res.writeHead(200,{'content-type':'application/json'}).end('{}');return;}
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
 if(req.url?.startsWith('/mcp-')){
  if(req.method==='GET'){mcpGets++;res.writeHead(404).end();return;}
  if(body.id===undefined){res.writeHead(202).end();return;}
  const name=req.url==='/mcp-worker'?'worker_ping':'manager_secret';if(body.method==='tools/call')mcpCalls.push(name);
  const result=body.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name,version:'1'}}:body.method==='tools/list'?{tools:[{name,description:name,inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:'worker-pong'}]};
  res.writeHead(200,{'content-type':'text/event-stream'}).end(`event: message\r\ndata: ${JSON.stringify({jsonrpc:'2.0',id:body.id,result})}\r\n\r\n`);return;
 }
 if(req.url!=='/v1/chat/completions'){res.writeHead(404).end();return;}
 const tools=(body.tools??[]).map(tool=>tool.function.name),text=JSON.stringify(body.messages),last=JSON.stringify([...body.messages].reverse().find(message=>message.role==='user'&&!JSON.stringify(message.content).includes('[PuddingTeams 当前工作上下文]'))?.content??'');
 requests.push({model:body.model,tools,last});const id=`fixture-${requests.length}`;
 const send=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id,object:'chat.completion.chunk',created:1780000000,model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
 res.writeHead(200,{'content-type':'text/event-stream'});
 let tool;
 if(tools.includes('write')&&last.includes('P3-MANAGER-PROOF')&&!text.includes('native write completed'))tool={name:'write',arguments:{path:'native-proof.txt',content:'native write completed'}};
 else if(tools.some(name=>name.endsWith('worker_ping'))&&last.includes('Continue independently')&&!text.includes('worker-pong'))tool={name:tools.find(name=>name.endsWith('worker_ping'))??'missing_mcp',arguments:{}};
 else if(tools.includes('bash')&&last.includes('P3-SLOW')&&!text.includes('slow-finished'))tool={name:'bash',arguments:{command:`until [ -f '${release}' ]; do sleep 0.05; done; printf slow-finished`}};
 if(tool){send({role:'assistant',tool_calls:[{index:0,id:`call-${requests.length}`,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.arguments)}}]});send({},'tool_calls');}
 else {send({role:'assistant',content:'P3 native reply completed. '+(last.includes('history')?'这段历史用于验证阅读位置。'.repeat(12):'')});send({},'stop');}
 res.end('data: [DONE]\n\n');
});
mock.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));const mockPort=mock.address().port;
const reserve=createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
const base=`http://127.0.0.1:${port}`;
const request=async(method,url,body,key=randomUUID())=>{const response=await fetch(base+url,{method,headers:{'content-type':'application/json','idempotency-key':key},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});return{status:response.status,body:await response.json()};};
const ok=async(method,url,body,key)=>{const result=await request(method,url,body,key);assert.equal(result.status,200,JSON.stringify(result));return result.body;};
const wait=async(fn)=>{const deadline=Date.now()+20000;while(Date.now()<deadline){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,50));}throw new Error('fixture wait timed out');};
const history=id=>ok('GET',`/api/sessions/${id}/messages`);
const settled=id=>wait(async()=>{const data=await history(id);return !data.running&&data.messages.some(message=>message.role==='assistant'&&JSON.stringify(message.content).includes('P3 native reply completed.'))?data:false;});
let started=false;
try{
 await mkdir(path.join(home,'state'),{recursive:true});await writeFile(path.join(home,'state','worker-input-queue.json'),'obsolete queue: must not parse or replay');
 await run(cli,['start','--port',String(port)],{env,timeout:30000});started=true;
 assert.equal((await ok('GET','/api/diagnostics/legacy-data')).files.length,1);
 assert.equal(await readFile(path.join(home,'state','worker-input-queue.json'),'utf8'),'obsolete queue: must not parse or replay');
 const catalog=await ok('GET','/api/providers/custom');await ok('PUT','/api/providers/custom/fixture',{expectedRevision:catalog.revision,name:'Fixture',baseUrl:`http://127.0.0.1:${mockPort}/v1`,api:'openai-completions',models:[{id:'manager-model'},{id:'worker-model'}]});await ok('POST','/api/providers/fixture/key',{apiKey:'fixture-only'});
 const worker=(await ok('GET','/api/agents')).agents.find(agent=>agent.name==='pi-b');await ok('PUT','/api/agents/pi-b/connector',{...worker.connector,config:{model:'fixture/worker-model'},expectedRevision:worker.extensionRevision});
 for(const owner of ['worker','manager']){const id=`${owner}-docs`,created=await request('POST','/api/extensions/mcp/servers',{id,displayName:id,definition:{url:`http://127.0.0.1:${mockPort}/mcp-${owner}`}});assert.equal(created.status,201,JSON.stringify(created));const agent=owner==='worker'?'pi-b':'manager',choice=await ok('GET',`/api/agents/${agent}/mcp`);await ok('PUT',`/api/agents/${agent}/mcp`,{serverIds:[id],expectedRevision:choice.revision});}
 const source=(await ok('GET','/api/rooms')).rooms.find(room=>room.type==='solo');
 for(const field of ['workerSessions','activeWorkerView','workerBindings'])assert.equal(Object.hasOwn(source,field),false);
 assert.equal((await request('GET',`/api/rooms/${source.id}/input-queue`)).status,404);
 assert.equal((await request('DELETE',`/api/rooms/${source.id}/input-queue/old`,{})).status,404);await ok('POST',`/api/sessions/${source.activeSession}/model`,{model:'fixture/manager-model'});
 await ok('POST',`/api/sessions/${source.activeSession}/messages`,{content:'P3-MANAGER-PROOF',attachments:[{filename:'snapshot-proof.txt',data:Buffer.from('frozen attachment proof').toString('base64')}]});await settled(source.activeSession);
 const sourceHistory=await history(source.activeSession),callsBefore=requests.length,key=randomUUID();
 assert(sourceHistory.messages.some(message=>message.role==='toolResult'),JSON.stringify({roles:sourceHistory.messages.map(message=>message.role),requests}));
 const fork=await ok('POST',`/api/sessions/${source.activeSession}/forks`,{workerId:'pi-b',expectedSourceLeafEntryId:sourceHistory.leafEntryId},key);
 assert.equal(requests.length,callsBefore);assert.notEqual(fork.sessionId,source.activeSession);assert.deepEqual(await ok('POST',`/api/sessions/${source.activeSession}/forks`,{workerId:'pi-b',expectedSourceLeafEntryId:sourceHistory.leafEntryId},key),fork);
 const target=await history(fork.sessionId);assert.equal(target.ownerAgentId,'pi-b');assert.equal(target.nativePi,true);assert.equal(target.sourceSnapshotId,fork.snapshotId);assert(target.messages.some(message=>message.role==='toolResult'));
 await ok('POST',`/api/sessions/${fork.sessionId}/messages`,{content:'Continue independently'});await settled(fork.sessionId);assert.deepEqual(mcpCalls,['worker_ping']);assert.equal(mcpGets,0);
 const surfaces=requests.slice(callsBefore).filter(row=>row.tools.length);assert(surfaces.every(row=>row.model==='worker-model'&&!row.tools.includes('delegation')&&!row.tools.some(name=>name.includes('manager_secret'))));
 const windows=JSON.parse(await readFile(path.join(home,'state','windows.json'),'utf8'));assert.equal(windows.version,3);assert.equal(windows.sessionRefs[fork.sessionId].provider.providerSessionHandle,fork.sessionId);
 const wiki=(await ok('GET','/api/agents')).agents.find(agent=>agent.name==='wiki');await ok('PUT','/api/agents/wiki/connector',{...wiki.connector,config:{model:'fixture/worker-model'},expectedRevision:wiki.extensionRevision});
 const wikiRoom=(await ok('POST','/api/rooms',{type:'direct',members:['wiki']})).room,profileStart=requests.length;
 await ok('POST',`/api/sessions/${wikiRoom.activeSession}/messages`,{content:'Native Wiki profile probe'});await settled(wikiRoom.activeSession);
 const wikiSurfaces=requests.slice(profileStart).filter(row=>row.tools.length);assert(wikiSurfaces.some(row=>row.tools.includes('knowledge_prepare_candidate')&&row.tools.includes('knowledge_submit_candidate')),JSON.stringify(wikiSurfaces));assert(wikiSurfaces.every(row=>!row.tools.some(name=>['bash','edit','write','mcp','delegation','create_session_goal'].includes(name)||name.includes('manager_secret'))));
 const origin=(await ok('GET',`/api/sessions/${fork.sessionId}/snapshot-origin`)).origin;assert.equal(origin.sourceSessionId,source.activeSession);assert.equal(origin.sourceExists,true);
 if(mode==='browser-hold'){
  for(let i=0;i<12;i++){await ok('POST',`/api/sessions/${fork.sessionId}/messages`,{content:`history ${i} 阅读位置验证`});await settled(fork.sessionId);}
  fixture={base,mockBase:`http://127.0.0.1:${mockPort}`,home,sourceId:source.activeSession,workerSessionId:fork.sessionId,workerRoomId:fork.roomId};console.log(JSON.stringify({fixture}));
  await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
 }else{
  await ok('POST',`/api/sessions/${fork.sessionId}/messages`,{content:'P3-SLOW'});await wait(async()=>(await history(fork.sessionId)).messages.some(message=>message.role==='assistant'&&message.content?.some?.(block=>block.type==='toolCall'&&block.name==='bash')));
  const followKey=randomUUID(),follow=await request('POST',`/api/sessions/${fork.sessionId}/messages`,{content:'follow proof',delivery:'followUp'},followKey);assert.equal(follow.status,202,JSON.stringify(follow));assert.equal(follow.body.persistence,'pending');const pending=(await history(fork.sessionId)).pendingMessageCount;
  await ok('POST',`/api/sessions/${fork.sessionId}/messages`,{content:'follow proof',delivery:'followUp'},followKey);assert.equal((await history(fork.sessionId)).pendingMessageCount,pending);
  const listed=await wait(async()=>{const items=(await history(fork.sessionId)).queuedInputs??[];return items.some(item=>item.text==='follow proof')?items:false;});
  const cancelRes=await request('POST',`/api/sessions/${fork.sessionId}/messages`,{content:'cancel proof',delivery:'followUp'});assert.equal(cancelRes.status,202,JSON.stringify(cancelRes));
  const cancelItem=await wait(async()=>((await history(fork.sessionId)).queuedInputs??[]).find(item=>item.text==='cancel proof'));
  const drop=await request('POST',`/api/sessions/${fork.sessionId}/queued-inputs/${cancelItem.key}`,{action:'cancel'});assert.equal(drop.status,200,JSON.stringify(drop));
  assert(!(await history(fork.sessionId)).queuedInputs?.some(item=>item.text==='cancel proof'));
  assert.equal((await request('POST',`/api/sessions/${fork.sessionId}/queued-inputs/${cancelItem.key}`,{action:'cancel'})).status,404);
  const promote=await request('POST',`/api/sessions/${fork.sessionId}/queued-inputs/${listed.find(item=>item.text==='follow proof').key}`,{action:'steer'});assert.equal(promote.status,200,JSON.stringify(promote));
  assert.equal((await history(fork.sessionId)).queuedInputs?.find(item=>item.text==='follow proof')?.delivery,'steer');
  const steer=await request('POST',`/api/sessions/${fork.sessionId}/messages`,{content:'steer proof',delivery:'steer'});assert.equal(steer.status,202);assert.equal(steer.body.delivery,'steer');
  assert.equal((await request('POST',`/api/sessions/${fork.sessionId}/model`,{model:'fixture/worker-model'})).status,409);
  await writeFile(release,'go');await wait(async()=>{const data=await history(fork.sessionId);return !data.running&&data.pendingMessageCount===0&&!data.unconfirmedInput;});
  const ids=(await history(fork.sessionId)).messages.filter(message=>['user','assistant','toolResult'].includes(message.role)).map(message=>message.puddingMessageId);
  await run(cli,['stop'],{env,timeout:20000});started=false;await run(cli,['start','--port',String(port)],{env,timeout:30000});started=true;
  assert.deepEqual((await history(fork.sessionId)).messages.filter(message=>['user','assistant','toolResult'].includes(message.role)).map(message=>message.puddingMessageId),ids);
  console.log(JSON.stringify({result:'passed',base,home,fork,mcpCalls,mcpGets,workerNative:true,followUp:true,steer:true,coldIds:true}));
 }
}finally{if(started)await run(cli,['stop'],{env,timeout:20000}).catch(()=>{});for(const socket of sockets)socket.destroy();await new Promise(resolve=>mock.close(resolve));}
