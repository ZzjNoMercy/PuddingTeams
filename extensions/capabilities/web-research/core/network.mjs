import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) blocked.addSubnet(ip, prefix, 'ipv4');
for (const [ip,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) blocked.addSubnet(ip,prefix,'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::',3,'ipv6');
const fakeIPs = new BlockList(); fakeIPs.addSubnet('198.18.0.0',15,'ipv4');
export function publicAddress(address) {
  const kind = isIP(address);
  if (kind === 4) return !blocked.check(address, 'ipv4');
  if (kind === 6) return globalV6.check(address,'ipv6') && !blocked.check(address,'ipv6');
  return false;
}
export function publicURL(raw) {
  let url; try { url = new URL(raw); } catch { throw new Error('网页 URL 无效'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || !url.hostname || (url.port && url.port !== (url.protocol === 'https:' ? '443':'80'))) throw new Error('仅允许标准端口上的公开 HTTP(S) URL，不允许 URL 凭据');
  const host = url.hostname.replace(/^\[|\]$/g,'');
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|invalid)$/.test(host)) throw new Error('禁止访问本机或内部域名');
  if (isIP(host) && !publicAddress(host)) throw new Error('禁止访问非公网地址');
  url.hash = ''; return url;
}
export async function resolvePublic(url, resolve = lookup) {
  const host = url.hostname.replace(/^\[|\]$/g,'');
  const addresses = isIP(host) ? [{address:host,family:isIP(host)}] : await resolve(host,{all:true,verbatim:true});
  // Clash/sing-box synthetic DNS: only hostname-based HTTPS with normal TLS verification.
  const trustedFake = (address) => url.protocol === 'https:' && !isIP(host) && fakeIPs.check(address,'ipv4');
  if (!addresses.length || addresses.some((item) => !publicAddress(item.address) && !trustedFake(item.address))) throw new Error('目标 DNS 包含非公网地址，已拒绝访问');
  return addresses[0];
}
export function proxyURL(raw) {
  if (!raw) return undefined;
  let url; try { url = new URL(raw); } catch { throw new Error('代理 URL 无效'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new Error('代理只支持不带凭据的 HTTP(S) 地址');
  return url;
}
function tunnel(proxy, address, port, signal) {
  return new Promise((resolve, reject) => {
    const authority = `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
    const req = (proxy.protocol === 'https:' ? https : http).request(proxy,{method:'CONNECT',path:authority,headers:{Host:authority},signal});
    req.on('error',reject);
    req.on('connect',(res,socket,head) => {
      if (res.statusCode !== 200 || head.length) { socket.destroy(); reject(new Error('代理隧道连接失败')); return; }
      resolve(socket);
    });
    req.on('response',(res) => {res.destroy(); reject(new Error('代理不支持 CONNECT'));});
    req.end();
  });
}
async function requestOnce(url, options, signal) {
  // DNS resolution is bounded by the same cancellation/deadline as the socket.
  const address = await new Promise((resolve,reject) => {
    const aborted=()=>reject(new Error('联网请求已取消或超时'));
    signal.addEventListener('abort',aborted,{once:true});
    if(signal.aborted) aborted();
    else resolvePublic(url,options.resolve).then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
  });
  signal.throwIfAborted();
  const host = url.hostname.replace(/^\[|\]$/g,'');
  const proxy = proxyURL(options.proxy);
  const synthetic = !publicAddress(address.address);
  let agent, tunnelSocket;
  if (proxy) {
    // A trusted synthetic HTTPS address is a proxy DNS token, not the origin IP.
    // Public destinations still tunnel the validated IP to prevent DNS rebinding.
    tunnelSocket = await tunnel(proxy,synthetic ? host : address.address,url.protocol === 'https:' ? 443:80,signal);
    agent = url.protocol === 'https:' ? new https.Agent() : new http.Agent();
    agent.createConnection = () => url.protocol === 'https:' ? tls.connect({socket:tunnelSocket,servername:isIP(host) ? undefined : host,rejectUnauthorized:true,checkServerIdentity:(_name,cert) => tls.checkServerIdentity(host,cert)}) : tunnelSocket;
  }
  try {
    return await new Promise((resolve,reject) => {
      const req = (url.protocol === 'https:' ? https : http).request(url,{
        method:options.method ?? 'GET', signal, agent:agent ?? false,
        // Hostname HTTPS may traverse a local TUN through its pinned Fake-IP.
        // Verify the origin hostname, including when the socket uses CONNECT.
        ...(url.protocol === 'https:' ? {rejectUnauthorized:true,servername:isIP(host) ? undefined : host,checkServerIdentity:(_name,cert)=>tls.checkServerIdentity(host,cert)} : {}),
        lookup:(_host,opts,cb) => opts?.all ? cb(null,[address]) : cb(null,address.address,address.family),
        headers:{'User-Agent':'PuddingTeams-WebResearch/1.0','Accept':'text/html,application/json,text/plain,application/xhtml+xml','Accept-Encoding':'gzip, deflate, br',...options.headers},
      },(res) => {
        const maxBytes = options.maxBytes ?? 5*1024*1024;
        if (Number(res.headers['content-length']) > maxBytes) { res.destroy(); reject(new Error('响应超过大小上限')); return; }
        let size=0; const chunks=[];
        res.on('data',(chunk) => {size+=chunk.length; if(size>maxBytes) {res.destroy(new Error('响应超过大小上限'));} else chunks.push(chunk);});
        res.on('error',reject);
        res.on('end',() => {
          try {
            let body=Buffer.concat(chunks);
            const encoding=res.headers['content-encoding']; const limits={maxOutputLength:maxBytes};
            if (encoding === 'gzip') body=gunzipSync(body,limits);
            else if (encoding === 'deflate') body=inflateSync(body,limits);
            else if (encoding === 'br') body=brotliDecompressSync(body,limits);
            else if (encoding && encoding !== 'identity') throw new Error('不支持的响应压缩格式');
            resolve({status:res.statusCode ?? 0,headers:res.headers,body,url:url.href});
          } catch { reject(new Error('响应解码失败或超过大小上限')); }
        });
      });
      req.on('error',() => reject(new Error(signal.aborted ? '联网请求已取消或超时':'联网连接失败')));
      req.end(options.body);
    });
  } finally { agent?.destroy(); tunnelSocket?.destroy(); }
}
export async function requestURL(raw, options={}) {
  const signal=options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(options.timeoutMs ?? 60000)]) : AbortSignal.timeout(options.timeoutMs ?? 60000);
  let url=publicURL(raw);
  for(let redirects=0;redirects<=5;redirects++) {
    signal.throwIfAborted();
    const res=await requestOnce(url,options,signal);
    if([301,302,303,307,308].includes(res.status)) {
      // Provider POSTs never follow redirects, so their credentials cannot move hosts.
      if(options.method && options.method !== 'GET') throw new Error('搜索供应商返回重定向，已拒绝转发凭据');
      if(!res.headers.location || redirects===5) throw new Error('网页重定向次数超限或缺少地址');
      url=publicURL(new URL(res.headers.location,url).href); continue;
    }
    return res;
  }
  throw new Error('网页重定向次数超限');
}
