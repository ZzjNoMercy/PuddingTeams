import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';import https from 'node:https';import tls from 'node:tls';
import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {publicAddress,publicURL,resolvePublic,requestURL} from './network.mjs';
import {DEFAULT_CONFIG,searchRequest,routeRequest,search,fetchPage,normalizeResponse,testProvider} from './service.mjs';
const state=()=>({config:{...structuredClone(DEFAULT_CONFIG),enabled:true,providers:{tavily:{enabled:true,model:'',searchDepth:'basic'},deepseek:{enabled:true,model:'deepseek-v4-flash'},grok:{enabled:true,model:'grok-4.7',webEnabled:true,xEnabled:true}}},keys:{TAVILY_API_KEY:'test-tavily',DEEPSEEK_API_KEY:'test-deepseek',XAI_API_KEY:'test-grok'},tests:Object.fromEntries(['tavily','deepseek','grok'].map(p=>[p,{status:'ready'}]))});
const response=(json,status=200)=>({status,body:Buffer.from(JSON.stringify(json)),headers:{'content-type':'application/json'}});
const citations=(url='https://example.com/source')=>({output:[{type:'web_search_call',action:{sources:[{url,title:'Source'}]}},{type:'message',content:[{type:'output_text',text:'Evidence',annotations:[{type:'url_citation',url,title:'Source'}]}]}],usage:{input_tokens:12}});

test('private, metadata, mapped IPv6, NAT64, documentation and multicast targets are blocked',()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','100.64.1.1','192.168.1.1','0.0.0.0','198.18.1.1','224.0.0.1','::1','::ffff:127.0.0.1','64:ff9b::a00:1','2001:db8::1','2002:7f00:1::'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
 for(const url of ['file:///tmp/a','http://127.0.0.1','http://2130706433','http://0x7f000001','https://[::1]','https://user:pw@example.com','https://example.com:8888'])assert.throws(()=>publicURL(url));
});
test('DNS cannot mix public and private addresses, and only hostname HTTPS trusts Fake-IP',async()=>{
 const resolve=async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}];await assert.rejects(resolvePublic(publicURL('https://example.com'),resolve),/非公网/);
 const fake=async()=>[{address:'198.18.0.4',family:4}];await resolvePublic(publicURL('https://example.com'),fake);await assert.rejects(resolvePublic(publicURL('http://example.com'),fake));assert.throws(()=>publicURL('https://198.18.0.4'));
});
async function mockedRequests(responses, action) {
 const oldHttp=http.request,oldHttps=https.request;const requests=[];
 const mock=(url,options,cb)=>{requests.push({url,options});const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{const item=responses.shift();const res=new PassThrough();res.statusCode=item.status??200;res.headers=item.headers??{};cb(res);res.end(item.body??'ok');});return req;};
 http.request=mock;https.request=mock;try{await action(requests);}finally{http.request=oldHttp;https.request=oldHttps;}
}
test('Fake-IP hostname HTTPS supports TUN directly with pinned DNS and full origin TLS verification',async()=>{
 await mockedRequests([{body:'public page'}],async(requests)=>{
  const res=await requestURL('https://example.com',{resolve:async()=>[{address:'198.18.0.4',family:4}]});
  assert.equal(res.status,200);assert.equal(res.body.toString(),'public page');assert.equal(requests.length,1);
  const options=requests[0].options;assert.equal(options.agent,false);assert.equal(options.rejectUnauthorized,true);assert.equal(options.servername,'example.com');
  options.lookup('example.com',{},(err,address)=>{assert.equal(err,null);assert.equal(address,'198.18.0.4');});
  assert.equal(options.checkServerIdentity('198.18.0.4',{subjectaltname:'DNS:example.com'}),undefined);
  assert.equal(options.checkServerIdentity('example.com',{subjectaltname:'DNS:internal.example.com'}).code,'ERR_TLS_CERT_ALTNAME_INVALID');
 });
});
test('explicit Fake-IP proxy tunnels the hostname and verifies the origin TLS identity',async()=>{
 const oldHttp=http.request,oldTls=tls.connect;let authority,tlsOptions;
 const socket=new PassThrough();
 http.request=(_url,options)=>{authority=options.path;const req=new EventEmitter();req.end=()=>queueMicrotask(()=>req.emit('connect',{statusCode:200},socket,Buffer.alloc(0)));return req;};
 tls.connect=options=>{tlsOptions=options;return socket;};
 try {
  const oldHttps=https.request;
  https.request=(_url,options,cb)=>{options.agent.createConnection();const req=new EventEmitter();req.end=()=>queueMicrotask(()=>{const res=new PassThrough();res.statusCode=200;res.headers={};cb(res);res.end('ok');});return req;};
  try {await requestURL('https://example.com',{proxy:'http://127.0.0.1:7890',resolve:async()=>[{address:'198.18.0.4',family:4}]});}
  finally {https.request=oldHttps;}
  assert.equal(authority,'example.com:443');assert.equal(tlsOptions.rejectUnauthorized,true);assert.equal(tlsOptions.servername,'example.com');
  assert.equal(tlsOptions.checkServerIdentity('198.18.0.4',{subjectaltname:'DNS:example.com'}),undefined);
  assert.equal(tlsOptions.checkServerIdentity('example.com',{subjectaltname:'DNS:wrong.example.com'}).code,'ERR_TLS_CERT_ALTNAME_INVALID');
 }finally{http.request=oldHttp;tls.connect=oldTls;socket.destroy();}
});
test('Fake-IP remains forbidden for HTTP, literals and mixed private DNS before any request',async()=>{
 await mockedRequests([],async(requests)=>{
  await assert.rejects(requestURL('http://example.com',{resolve:async()=>[{address:'198.18.0.4',family:4}]}),/非公网/);
  await assert.rejects(requestURL('https://198.18.0.4'),/非公网/);
  await assert.rejects(requestURL('https://example.com',{resolve:async()=>[{address:'198.18.0.4',family:4},{address:'127.0.0.1',family:4}]}),/非公网/);
  assert.equal(requests.length,0);
 });
});
test('redirects revalidate DNS and pin actual lookup, including rebinding',async()=>{
 let calls=0;
 await mockedRequests([{status:302,headers:{location:'https://second.example.com'}}],async(requests)=>{
  await assert.rejects(requestURL('https://first.example.com',{resolve:async()=>[{address:++calls===1?'8.8.8.8':'127.0.0.1',family:4}]}),/非公网/);
  assert.equal(requests.length,1);requests[0].options.lookup('first.example.com',{},(err,address)=>assert.equal(address,'8.8.8.8'));
 });
});
test('provider redirects never forward credentials',async()=>{
 await mockedRequests([{status:307,headers:{location:'https://evil.example'}}],async(requests)=>{
  await assert.rejects(requestURL('https://api.example.com',{method:'POST',headers:{Authorization:'secret'},resolve:async()=>[{address:'8.8.8.8',family:4}]}),/拒绝转发凭据/);assert.equal(requests.length,1);
 });
});
test('response byte caps and non-text pages are rejected',async()=>{
 await mockedRequests([{headers:{'content-length':'6000000'}}],async()=>{await assert.rejects(requestURL('https://example.com',{resolve:async()=>[{address:'8.8.8.8',family:4}]}),/大小上限/);});
 await assert.rejects(fetchPage({url:'https://example.com'},state(),undefined,async()=>({status:200,headers:{'content-type':'application/pdf'},body:Buffer.from('pdf')})),/二进制/);
});
test('routing selects domestic and global providers and restricts X/media to Grok',()=>{
 assert.equal(routeRequest(searchRequest({query:'国内政务消息'}),DEFAULT_CONFIG).order[0],'deepseek');
 assert.equal(routeRequest(searchRequest({query:'what is new on X.com'}),DEFAULT_CONFIG).source,'x');
 assert.throws(()=>routeRequest(searchRequest({query:'x',source:'x',provider:'tavily'}),DEFAULT_CONFIG),/Grok/);
 assert.throws(()=>routeRequest(searchRequest({query:'x',enable_video_understanding:true}),DEFAULT_CONFIG),/视频/);
});
test('search parameters enforce bounds, dates and exclusive filters',()=>{
 for(const raw of [{query:''},{query:'x',max_results:11},{query:'x',from_date:'2026-02-30'},{query:'x',from_date:'2026-10-01',to_date:'2026-09-30'},{query:'x',include_domains:['example.com'],exclude_domains:['test.com']},{query:'x',allowed_x_handles:['a'],excluded_x_handles:['b']},{query:'x',cross_check:'yes'}]) assert.throws(()=>searchRequest(raw));
});
test('DeepSeek uses PuddingClaw model, Responses endpoint and forced web_search',async()=>{
 let captured;
 const result=await testProvider('deepseek',state(),undefined,async(url,opts)=>{captured={url,body:JSON.parse(opts.body)};return response(citations());});
 assert.equal(captured.url,'https://api.deepseek.com/responses');assert.equal(captured.body.model,'deepseek-v4-flash');assert.deepEqual(captured.body.tools,[{type:'web_search'}]);assert.deepEqual(captured.body.tool_choice,{type:'web_search'});assert.deepEqual(captured.body.reasoning,{effort:'none'});assert.equal(result.sources.length,1);
});
test('ordinary model prose and invented links cannot satisfy search readiness',()=>{
 assert.throws(()=>normalizeResponse({output:[{type:'message',content:[{type:'output_text',text:'See https://example.com',annotations:[]}]}]},'deepseek'),/真实搜索/);
 assert.throws(()=>normalizeResponse({output:[{type:'web_search_call'}]},'deepseek'),/来源/);
});
test('authentication failures fall back and explicit provider never switches',async()=>{
 const s=state();let count=0;
 const transport=async(url)=>{count++;if(url.includes('x.ai'))return response({},401);return response({results:[{url:'https://example.com/source',title:'Source',content:'Quote'}]});};
 const result=await search({query:'latest info'},s,undefined,transport);assert.equal(result.selected_provider,'tavily');assert.equal(count,2);assert.equal(result.attempts[0].category,'authentication');
 count=0;await assert.rejects(search({query:'latest',provider:'grok'},s,undefined,transport));assert.equal(count,1);
});
test('untested, disabled, and missing credential providers are excluded',async()=>{
 const s=state();s.tests={};await assert.rejects(search({query:'hi'},s));s.tests={grok:{status:'ready'}};s.config.providers.grok.enabled=false;await assert.rejects(search({query:'hi'},s));
});
test('two-provider cross-check deduplicates sources and reports partial verification',async()=>{
 const s=state();s.config.crossCheckEnabled=true;
 const result=await search({query:'info',cross_check:true},s,undefined,async(url)=>url.includes('tavily')?response({results:[{url:'https://example.com/source',title:'Source'},{url:'https://example.org/other',title:'Other'}]}):response(citations()));
 assert.equal(result.providers.length,2);assert.equal(result.sources.length,2);
 const partial=await search({query:'info',cross_check:true},s,undefined,async(url)=>url.includes('tavily')?response({},500):response(citations()));assert.equal(partial.providers.length,1);assert.equal(partial.warnings.length,1);
});
test('Grok media and X filters reach real server tool fields',async()=>{
 let body;
 await search({query:'x',provider:'grok',source:'both',include_domains:['example.com'],allowed_x_handles:['xai'],enable_image_search:true,enable_video_understanding:true,from_date:'2026-09-01'},state(),undefined,async(_url,opts)=>{body=JSON.parse(opts.body);return response(citations());});
 assert.deepEqual(body.tools[0].filters,{allowed_domains:['example.com']});assert.equal(body.tools[0].enable_image_search,true);assert.equal(body.tools[1].enable_video_understanding,true);assert.deepEqual(body.tools[1].allowed_x_handles,['xai']);
});
test('domain filters are enforced on returned citations',async()=>{
 await assert.rejects(search({query:'x',provider:'grok',include_domains:['other.org']},state(),undefined,async()=>response(citations())),/域名/);
});
test('HTML fetch removes scripts, retains links and truthfully marks truncation',async()=>{
 const result=await fetchPage({url:'https://example.com'},state(),undefined,async()=>({status:200,url:'https://example.com/final',headers:{'content-type':'text/html; charset=utf-8'},body:Buffer.from('<title>Title</title><script>evil()</script><main><h1>Heading</h1><a href="/docs">Docs</a><p>'+('a'.repeat(60000))+'</p></main>')}));
 assert.equal(result.uri,'https://example.com/final');assert.equal(result.title,'Title');assert.ok(result.content.includes('[Docs](https://example.com/docs)'));assert.ok(!result.content.includes('evil'));assert.equal(result.truncated,true);assert.equal(result.content.length,50000);
});
test('abort prevents fallback to another billable provider',async()=>{
 const controller=new AbortController();let calls=0;await assert.rejects(search({query:'x'},state(),controller.signal,async()=>{calls++;controller.abort();throw new Error('aborted');}));assert.equal(calls,1);
});
