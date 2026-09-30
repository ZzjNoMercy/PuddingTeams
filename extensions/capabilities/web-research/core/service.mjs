import { requestURL, publicURL } from './network.mjs';
export const PROVIDERS=['tavily','deepseek','grok'];
export const DEFAULT_CONFIG={enabled:false,fetchEnabled:true,defaultScope:'global',fallbackEnabled:true,crossCheckEnabled:false,maxProviderAttempts:2,domesticOrder:['deepseek','tavily','grok'],globalOrder:['grok','tavily','deepseek'],proxyUrl:'',providers:{tavily:{enabled:false,model:'',searchDepth:'basic'},deepseek:{enabled:false,model:'deepseek-v4-flash'},grok:{enabled:false,model:'grok-4.7',webEnabled:true,xEnabled:true}}};
const KEYS={tavily:'TAVILY_API_KEY',deepseek:'DEEPSEEK_API_KEY',grok:'XAI_API_KEY'};
export const PROVIDER_KEYS=KEYS;
export class SearchError extends Error {constructor(message,category='provider_error'){super(message);this.category=category;}}
function choice(value,values,fallback,name) {if(value===undefined) return fallback; if(!values.includes(value)) throw new SearchError(`${name} 无效`,'invalid_request'); return value;}
function list(value,max,name,pattern) {if(value===undefined) return []; if(!Array.isArray(value)||value.length>max||value.some(v=>typeof v!=='string'||!pattern.test(v))) throw new SearchError(`${name} 无效或数量超限`,'invalid_request');return [...new Set(value.map(v=>v.toLowerCase()))];}
export function searchRequest(raw) {
  if(!raw || typeof raw.query!=='string'||!raw.query.trim()||raw.query.length>4000) throw new SearchError('query 必须是 1–4000 字符','invalid_request');
  const max=raw.max_results ?? 5; if(!Number.isInteger(max)||max<1||max>10) throw new SearchError('max_results 必须为 1–10','invalid_request');
  const req={query:raw.query.trim(),max_results:max,scope:choice(raw.scope,['auto','domestic','global'],'auto','scope'),source:choice(raw.source,['auto','web','x','both'],'auto','source'),provider:choice(raw.provider,['auto',...PROVIDERS],'auto','provider'),cross_check:raw.cross_check??false,
    include_domains:list(raw.include_domains,5,'include_domains',/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i),exclude_domains:list(raw.exclude_domains,5,'exclude_domains',/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i),
    allowed_x_handles:list(raw.allowed_x_handles,10,'allowed_x_handles',/^[a-z0-9_]{1,15}$/i),excluded_x_handles:list(raw.excluded_x_handles,10,'excluded_x_handles',/^[a-z0-9_]{1,15}$/i)};
  if(req.include_domains.length&&req.exclude_domains.length) throw new SearchError('包含域名与排除域名只能选择一项','invalid_request');
  if(req.allowed_x_handles.length&&req.excluded_x_handles.length) throw new SearchError('包含账号与排除账号只能选择一项','invalid_request');
  for(const key of ['cross_check','enable_image_understanding','enable_image_search','enable_video_understanding']) {if(raw[key]!==undefined&&typeof raw[key]!=='boolean') throw new SearchError(`${key} 必须为布尔值`,'invalid_request');req[key]=raw[key]??false;}
  if(raw.time_range!==undefined) req.time_range=choice(raw.time_range,['day','week','month','year'],undefined,'time_range');
  for(const key of ['from_date','to_date']) if(raw[key]!==undefined) {const value=raw[key]; if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value) throw new SearchError(`${key} 日期无效`,'invalid_request');req[key]=value;}
  if(req.from_date&&req.to_date&&req.from_date>req.to_date) throw new SearchError('起始日期晚于结束日期','invalid_request');
  return req;
}
export function routeRequest(req,config) {
  const q=req.query.toLowerCase();
  const scope=req.scope==='auto' ? /中国大陆|国内|工信部|政务|国务院|微信|公众号|知乎|微博|小红书|哔哩哔哩/.test(q) ? 'domestic' : /全球|海外|国外|英文资料|international|global|x\.com|twitter/.test(q) ? 'global':config.defaultScope : req.scope;
  const source=req.source==='auto' ? /网页和\s*x|网页与\s*x|web\s*(and|\+)\s*x/.test(q) ? 'both' : /x\.com|twitter|推特|推文|x\s*上|tweet|账号动态/.test(q) ? 'x':'web':req.source;
  const grokOnly=source!=='web'||req.enable_image_understanding||req.enable_image_search||req.enable_video_understanding;
  if(req.provider!=='auto'&&grokOnly&&req.provider!=='grok') throw new SearchError('X 与图片/视频搜索只能使用 Grok','invalid_route');
  if(req.enable_video_understanding&&source==='web') throw new SearchError('视频理解仅适用于 X Search','invalid_request');
  if(req.enable_image_search&&source==='x') throw new SearchError('图片搜索仅适用于 Web Search','invalid_request');
  return {...req,scope,source,order:req.provider!=='auto'?[req.provider]:grokOnly?['grok']:config[scope==='domestic'?'domesticOrder':'globalOrder']};
}
function validSource(raw,provider) {
  const url=raw?.url ?? raw?.uri; if(typeof url!=='string') return undefined;
  try { const normalized=publicURL(url).href; return {title:String(raw.title??raw.name??new URL(normalized).hostname).slice(0,500),uri:normalized,quote:String(raw.content??raw.snippet??raw.quote??'').slice(0,8000),source_type:/(^|\.)[xt](witter)?\.com$/.test(new URL(normalized).hostname)?'x':'web',provider}; } catch {return undefined;}
}
export function normalizeResponse(payload,provider) {
  let text=''; const rawSources=[]; let searched=false;
  if(provider==='tavily') {rawSources.push(...(Array.isArray(payload.results)?payload.results:[])); searched=true;}
  else {
    for(const item of payload.output??[]) {
      if(['web_search_call','x_search_call'].includes(item.type)) {searched=true;rawSources.push(...(item.action?.sources??[]));}
      if(item.type==='message') for(const part of item.content??[]) {
        if(part.type==='output_text') {text+=`${part.text??''}\n`;rawSources.push(...(part.annotations??[]).filter(a=>a.type==='url_citation').map(a=>a.url_citation??a));}
      }
    }
    const usage=payload.server_side_tool_usage??{};
    if(Object.entries(usage).some(([key,value]) => /web_search|x_search/i.test(key)&&Number(value)>0)) searched=true;
    for(const c of payload.citations??[]) rawSources.push(typeof c==='string'?{url:c}:c);
  }
  if(!searched) throw new SearchError(`${provider} 未返回真实搜索调用记录，无法证明联网（该账户/模型可能不支持服务端搜索）`,'unsupported_search');
  const seen=new Set(); const sources=rawSources.map(s=>validSource(s,provider)).filter(s=>s&&!seen.has(s.uri)&&seen.add(s.uri));
  if(!sources.length) throw new SearchError(`${provider} 未返回可引用来源`,'empty_sources');
  return {provider,sources,answer_context:text.trim().slice(0,30000),usage:payload.usage??{}};
}
function requestBody(provider,req,options) {
  if(provider==='tavily') return {query:req.query,max_results:req.max_results,search_depth:options.searchDepth??'basic',include_answer:false,include_raw_content:false,include_images:false,include_usage:true,...(req.include_domains.length?{include_domains:req.include_domains}:{}),...(req.exclude_domains.length?{exclude_domains:req.exclude_domains}:{}),...(req.time_range?{time_range:req.time_range}:{}),...(req.scope==='domestic'?{country:'china'}:{})};
  const tools=[];
  if(req.source!=='x') {
    if(provider==='grok'&&options.webEnabled===false) throw new SearchError('Grok 网页搜索未启用','capability_disabled');
    const web={type:'web_search'};
    if(provider==='grok') {
      if(req.include_domains.length) web.filters={allowed_domains:req.include_domains};
      if(req.exclude_domains.length) web.filters={excluded_domains:req.exclude_domains};
      if(req.enable_image_understanding) web.enable_image_understanding=true;
      if(req.enable_image_search) web.enable_image_search=true;
    }
    tools.push(web);
  }
  if(req.source!=='web') {
    if(options.xEnabled===false) throw new SearchError('Grok X 搜索未启用','capability_disabled');
    const x={type:'x_search'};
    if(req.allowed_x_handles.length) x.allowed_x_handles=req.allowed_x_handles;
    if(req.excluded_x_handles.length) x.excluded_x_handles=req.excluded_x_handles;
    const days={day:1,week:7,month:30,year:365}[req.time_range];const now=new Date();
    if(req.from_date||days) x.from_date=req.from_date??new Date(now.getTime()-days*86400000).toISOString().slice(0,10);
    if(req.to_date||days) x.to_date=req.to_date??now.toISOString().slice(0,10);
    if(req.enable_image_understanding) x.enable_image_understanding=true;
    if(req.enable_video_understanding) x.enable_video_understanding=true;
    tools.push(x);
  }
  const domains=req.include_domains.length?` Only cite these domains: ${req.include_domains.join(', ')}.`:req.exclude_domains.length?` Exclude these domains: ${req.exclude_domains.join(', ')}.`:'';
  return {model:options.model,input:`Use the enabled server-side search tools. Return concise evidence with source URLs. ${req.scope==='domestic'?'Prefer Chinese mainland public sources.':''}${domains}\n${req.query}`,tools,max_output_tokens:provider==='deepseek'?8192:1400,...(provider==='deepseek'?{tool_choice:{type:'web_search'},reasoning:{effort:'none'}}:{})};
}
export async function providerSearch(provider,req,key,config,signal,transport=requestURL) {
  const endpoint={tavily:'https://api.tavily.com/search',deepseek:'https://api.deepseek.com/responses',grok:'https://api.x.ai/v1/responses'}[provider];
  const body=requestBody(provider,req,config.providers[provider]);
  const res=await transport(endpoint,{method:'POST',body:JSON.stringify(body),headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},proxy:config.proxyUrl,signal,timeoutMs:provider==='grok'?60000:30000,maxBytes:2*1024*1024});
  if(res.status<200||res.status>=300) throw new SearchError(`${provider} HTTP ${res.status}`,res.status===401||res.status===403?'authentication':res.status===429?'rate_limit':'provider_http');
  let payload;try{payload=JSON.parse(res.body.toString('utf8'));}catch{throw new SearchError(`${provider} 响应不是 JSON`,'invalid_response');}
  if(payload.error||payload.status==='failed'||payload.status==='incomplete') throw new SearchError(`${provider} 搜索未完成${payload.incomplete_details?.reason==='max_output_tokens'?'（输出预算不足）':''}`,'provider_error');
  const result=normalizeResponse(payload,provider);
  const matches=(uri,domains)=>domains.some(d=>{const h=new URL(uri).hostname;return h===d||h.endsWith(`.${d}`);});
  result.sources=result.sources.filter(s=>(!req.include_domains.length||s.source_type==='x'||matches(s.uri,req.include_domains))&&!matches(s.uri,req.exclude_domains));
  if(!result.sources.length) throw new SearchError(`${provider} 没有满足域名约束的来源`,'empty_sources');
  return result;
}
export async function search(raw,state,signal,transport=requestURL) {
  const config=state.config;
  if(!config.enabled) throw new SearchError('联网搜索未启用，请在设置 → 联网配置','unavailable');
  const req=routeRequest(searchRequest(raw),config);
  const candidates=req.order.filter(p=>config.providers[p].enabled&&state.keys[KEYS[p]]&&state.tests?.[p]?.status==='ready');
  if(!candidates.length) throw new SearchError('所选路由没有已启用且通过连接测试的搜索供应商','unavailable');
  const cross=req.cross_check&&req.provider==='auto'&&req.source==='web'&&config.crossCheckEnabled;
  if(req.cross_check&&!config.crossCheckEnabled) throw new SearchError('多源核验未在联网设置中启用','capability_disabled');
  const limit=req.provider==='auto'&&req.source==='web'&&(config.fallbackEnabled||cross)?Math.max(cross?2:1,config.maxProviderAttempts):1;
  const attempts=[];const results=[];
  for(const provider of candidates.slice(0,limit)) {
    signal?.throwIfAborted();
    try {const result=await providerSearch(provider,req,state.keys[KEYS[provider]],config,signal,transport);results.push(result);attempts.push({provider,status:'success',sourceCount:result.sources.length});if(!cross||results.length===2) break;}
    catch(error) {if(signal?.aborted) throw error;attempts.push({provider,status:'error',category:error.category??'network',error:error instanceof SearchError?error.message:'联网连接失败'});}
  }
  if(!results.length) throw new SearchError(`联网搜索失败：${attempts.map(a=>a.error).join('；')}`,'search_failed');
  const seen=new Set();const sources=results.flatMap(r=>r.sources).filter(s=>!seen.has(s.uri)&&seen.add(s.uri)).slice(0,req.max_results);
  const warnings=cross&&results.length<2?['多源核验未完成：只有一个供应商返回有效来源']:[];
  return {selected_provider:results[0].provider,providers:results.map(r=>r.provider),resolved_scope:req.scope,resolved_source:req.source,sources,answer_context:results.map(r=>r.answer_context).filter(Boolean).join('\n\n'),attempts,warnings,usage:Object.fromEntries(results.map(r=>[r.provider,r.usage]))};
}
function entities(text) {return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,e)=>{if(e[0]==='#'){const n=parseInt(e.slice(e[1].toLowerCase()==='x'?2:1),e[1].toLowerCase()==='x'?16:10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[e.toLowerCase()]??'';});}
export function htmlToMarkdown(html,url) {
  const title=entities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]??new URL(url).hostname).trim();
  let body=html.replace(/<!--[^]*?-->/g,'').replace(/<(script|style|noscript|svg|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  body=body.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i)?.[1]??body;
  body=body.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,(_,href,label)=>{const text=entities(label.replace(/<[^>]+>/g,'')).trim();try{const target=publicURL(new URL(entities(href),url).href).href;return `[${text.replace(/[\[\]]/g,'')}](${target.replace(/\)/g,'%29')})`;}catch{return text;}})
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,(_,level,text)=>`\n\n${'#'.repeat(Number(level))} ${text}\n\n`)
    .replace(/<li\b[^>]*>/gi,'\n- ').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<\/(?:p|div|section|article|main|ul|ol|tr)>/gi,'\n\n').replace(/<[^>]+>/g,'');
  return {title,content:entities(body).replace(/[^\S\n]+/g,' ').replace(/\n\s*\n(?:\s*\n)+/g,'\n\n').trim()};
}
export async function fetchPage(raw,state,signal,transport=requestURL) {
  if(!state.config.fetchEnabled) throw new Error('网页抓取未启用，请在设置 → 联网启用');
  if(!raw||typeof raw.url!=='string'||raw.url.length>8192) throw new Error('url 无效');
  const url=publicURL(raw.url);const res=await transport(url.href,{proxy:state.config.proxyUrl,signal,timeoutMs:30000});
  if(res.status<200||res.status>=300) throw new Error(`网页 HTTP ${res.status}`);
  const type=String(res.headers['content-type']??'').toLowerCase();
  if(!/^(text\/|application\/(json|[^;]+\+json|xml|xhtml\+xml))/.test(type)) throw new Error('网页抓取仅支持 HTML、JSON、XML 与文本，请使用文件工具读取二进制资源');
  const charset=type.match(/charset\s*=\s*["']?([\w-]+)/)?.[1]??'utf-8';
  let decoded;try{decoded=new TextDecoder(charset).decode(res.body);}catch{throw new Error('网页字符编码不受支持');}
  const page=/html/.test(type)?htmlToMarkdown(decoded,res.url??url.href):{title:new URL(res.url??url.href).hostname,content:decoded};
  const max=50000;const truncated=page.content.length>max;
  return {uri:res.url??url.href,title:page.title,content:page.content.slice(0,max),truncated,content_type:type};
}
export async function testProvider(provider,state,signal,transport=requestURL) {
  if(!PROVIDERS.includes(provider)) throw new Error('未知搜索供应商');
  const key=state.keys[KEYS[provider]];if(!key) throw new Error('请先保存该供应商的 API Key');
  const req=routeRequest(searchRequest({query:provider==='deepseek'?'Use Web Search to find the official DeepSeek Responses API documentation with a source citation.':'Find the official Tavily and xAI documentation pages and provide source citations.',provider,source:provider==='grok'&&state.config.providers.grok.xEnabled?'both':'web',max_results:2}),state.config);
  return providerSearch(provider,req,key,state.config,signal,transport);
}
