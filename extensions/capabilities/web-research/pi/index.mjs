import { readFile } from 'node:fs/promises';
import { createTools } from '../core/tools.mjs';
import { DEFAULT_CONFIG, PROVIDERS, PROVIDER_KEYS, testProvider } from '../core/service.mjs';
// Pi's facade only consumes ExtensionAPI. The core has no Teams/Driver dependencies.
export default function webResearch(pi) {
  const tests={};
  const stateFor=async()=>{
    const raw=process.env.PUDDING_WEB_RESEARCH_CONFIG?JSON.parse(await readFile(process.env.PUDDING_WEB_RESEARCH_CONFIG,'utf8')):{};
    const keys=Object.fromEntries(PROVIDERS.flatMap(p=>process.env[PROVIDER_KEYS[p]]?[[PROVIDER_KEYS[p],process.env[PROVIDER_KEYS[p]]]]:[]));
    const config={...structuredClone(DEFAULT_CONFIG),enabled:Object.keys(keys).length>0,...raw};
    config.providers=Object.fromEntries(PROVIDERS.map(p=>[p,{...DEFAULT_CONFIG.providers[p],enabled:Boolean(keys[PROVIDER_KEYS[p]]),...raw.providers?.[p]}]));
    const fingerprints=JSON.stringify({config,keys});
    return {config,keys,tests:Object.fromEntries(PROVIDERS.flatMap(p=>tests[p]?.fingerprint===fingerprints?[[p,tests[p]]]:[]))};
  };
  pi.registerCommand('web-research-test',{description:'真实测试联网搜索供应商：tavily / deepseek / grok',handler:async(args,ctx)=>{
    const provider=args.trim();if(!PROVIDERS.includes(provider)){ctx.ui.notify('用法：/web-research-test tavily|deepseek|grok','warning');return;}
    try{const state=await stateFor();const response=await testProvider(provider,state);tests[provider]={status:'ready',fingerprint:JSON.stringify({config:state.config,keys:state.keys})};ctx.ui.notify(`${provider} 搜索测试成功：${response.sources.length} 条来源`,'info');}
    catch{delete tests[provider];ctx.ui.notify(`${provider} 搜索测试失败，请检查凭据、网络及服务端搜索支持`,'warning');}
  }});
  for(const tool of createTools({stateFor})) pi.registerTool(tool);
}
