/** Executed once per Bash invocation, not once per Worker lifetime. Tokens are
 * passed only in the official CLI's invocation-scoped credential environment. */
export const CLI_BRIDGE_SOURCE = String.raw`const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const value = flag => {
 const inline = args.find(a => a.startsWith(flag + '='));
 if (inline) return inline.slice(flag.length + 1);
 const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1];
};
const values = flag => args.flatMap((a, i) => a === flag ? [args[i + 1] || ''] : a.startsWith(flag+'=') ? [a.slice(flag.length+1)] : []).flatMap(a => a.split(',')).filter(Boolean);
async function request(route, body, method = body === undefined ? 'GET' : 'POST') {
 const base = new URL(process.env.PUDDING_LARK_BROKER_URL || '');
 if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') throw new Error('飞书凭证服务地址无效');
 const response = await fetch(new URL(route, base), {method, redirect:'error', signal:AbortSignal.timeout(12000), headers:{Authorization:'Bearer '+process.env.PUDDING_LARK_BROKER_KEY, 'Content-Type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
 const data = await response.json();
 if (!response.ok) throw new Error(data.error || '共享飞书凭证服务不可用');
 return data;
}
function print(data) { process.stdout.write(JSON.stringify(data)+'\n'); }
async function wait(id) {
 for (;;) {
  const session = await request('/authorizations/'+encodeURIComponent(id));
  if (session.state === 'completed') { print({ok:true,identity:'user',data:{message:session.message}}); return; }
  if (session.state !== 'pending') throw new Error(session.message || '授权未完成');
  await new Promise(resolve => setTimeout(resolve,1500));
 }
}
function execute(env) {
 const child = spawn(process.env.PUDDING_LARK_REAL_CLI,args,{env,stdio:'inherit',shell:process.platform==='win32'&&/\.(cmd|bat)$/i.test(process.env.PUDDING_LARK_REAL_CLI)});
 for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
 child.on('error',()=>{process.stderr.write('无法启动飞书官方 CLI\n');process.exitCode=1;});
 child.on('exit',(code,signal)=>{process.exitCode=code ?? (signal==='SIGINT'?130:1);});
}
async function main() {
 if (!process.env.PUDDING_LARK_REAL_CLI) throw new Error('尚未配置飞书 CLI 执行路径');
 const help = args.includes('--help') || args.includes('-h');
 if (!args.length || args[0]==='--version' || args[0]==='skills' || args[0]==='update' || help || (args[0]==='auth' && args[1]==='qrcode')) {execute(process.env);return;}
 if (value('--profile') || args.includes('--profile')) throw new Error('平台 CLI 绑定共享默认应用，不能切换独立 profile');
 if (args[0]==='auth') {
  if (args[1]==='login') {
   if (value('--device-code')) {await wait(value('--device-code'));return;}
   const session = await request('/authorizations',{scope:value('--scope'),domains:values('--domain'),exclude:values('--exclude'),recommend:args.includes('--recommend')});
   if (args.includes('--no-wait')) {print({verification_url:session.verificationUrl,qr_code:session.qrCodeDataUrl,device_code:session.id,expires_in:Math.max(0,Math.floor((Date.parse(session.expiresAt)-Date.now())/1000)),hint:'完成授权后执行 lark-cli auth login --device-code '+session.id+'；平台与 CLI 共用此授权'});return;}
   print({event:'device_authorization',verification_uri_complete:session.verificationUrl,qr_code:session.qrCodeDataUrl});
   await wait(session.id);return;
  }
  if (args[1]==='status' || args[1]==='list' || args[1]==='check') {
   const status = await request('/status');
   if (args[1]==='check') {
    const required=(value('--scope')||'').split(/[\s,]+/).filter(Boolean);
    const granted=(status.scope||'').split(' ');
    const ok=status.userAuthorization==='authorized'&&required.every(s=>granted.includes(s));
    print({ok,identity:'user',data:{authorized:ok}}); if(!ok)process.exitCode=1;return;
   }
   print({ok:true,verified:status.state==='connected',identity:status.userAuthorization==='authorized'?'user':'bot',identities:{user:{status:status.userAuthorization==='authorized'?'active':'missing',tokenStatus:status.userAuthorization==='authorized'?'valid':status.userAuthorization,userName:status.accountName,scope:status.scope}},data:status});return;
  }
  if (args[1]==='refresh') {await request('/refresh',{identity:value('--as')==='bot'?'bot':'user'});print({ok:true,data:{message:'共享凭证已刷新'}});return;}
  if (args[1]==='logout') {await request('/logout',{});print({ok:true,loggedOut:true,message:'平台与 CLI 的共享用户凭证已清除，不撤销飞书服务端授权'});return;}
  throw new Error('该认证命令不由共享凭证服务支持；请使用平台设置或 auth login/status/check/refresh/logout');
 }
 if (args[0]==='config') {
  if (args[1]==='show') {print(await request('/settings'));return;}
  if (args[1]==='init' && value('--app-id') && args.includes('--app-secret-stdin')) {
   let secret='';for await (const part of process.stdin) {secret+=part;if(secret.length>4096)throw new Error('应用密钥过长');}
   print(await request('/settings',{appId:value('--app-id'),appSecret:secret.trim(),confirmReplace:args.includes('--confirm-replace')}));return;
  }
  throw new Error('应用配置由平台与 CLI 共享；请在设置中修改，或使用 config init --app-id <ID> --app-secret-stdin');
 }
 const identity=value('--as')==='bot'?'bot':'user';
 if(value('--as')&&!['user','bot','auto'].includes(value('--as')))throw new Error('无效身份');
 const credential=await request('/credential',{identity});
 const env={...process.env};
 for(const key of Object.keys(env))if(key.startsWith('LARKSUITE_CLI_')||key.startsWith('PUDDING_LARK_BROKER_'))delete env[key];
 Object.assign(env,{LARKSUITE_CLI_APP_ID:credential.appId,LARKSUITE_CLI_BRAND:'feishu',LARKSUITE_CLI_DEFAULT_AS:identity,LARKSUITE_CLI_STRICT_MODE:identity,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'});
 env[identity==='bot'?'LARKSUITE_CLI_TENANT_ACCESS_TOKEN':'LARKSUITE_CLI_USER_ACCESS_TOKEN']=credential.accessToken;
 execute(env);
}
main().catch(error=>{process.stderr.write(JSON.stringify({ok:false,error:{message:error instanceof Error?error.message:'飞书调用失败'}})+'\n');process.exitCode=1;});
`;
