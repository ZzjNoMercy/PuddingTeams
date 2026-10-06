import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  publicURL,
  requestURL,
  type NetworkResponse,
} from "../../../../extensions/capabilities/web-research/core/network.mjs";
import { ReadLaterError } from "./contracts.js";
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export type ArticleFetch = (
  url: string,
  signal: AbortSignal,
) => Promise<NetworkResponse>;
const trackers = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "spm",
  "from",
]);
export function canonicalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = publicURL(raw.trim());
  } catch (error) {
    throw new ReadLaterError(
      "invalid_input",
      error instanceof Error ? error.message : "链接无效",
    );
  }
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  for (const key of [...url.searchParams.keys()])
    if (key.toLowerCase().startsWith("utm_") || trackers.has(key.toLowerCase()))
      url.searchParams.delete(key);
  const sorted = [...url.searchParams.entries()].sort(
    ([a, av], [b, bv]) =>
      a.localeCompare(b, "en") || av.localeCompare(bv, "en"),
  );
  url.search = new URLSearchParams(sorted).toString();
  if (Buffer.byteLength(url.href) > 1800)
    throw new ReadLaterError("invalid_input", "链接过长，请使用原始文章地址");
  return url.href;
}
let proxyCache:
  | {
      expires: number;
      url: string;
    }
  | undefined;
export async function configuredArticleProxy(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const explicit =
    env.PUDDINGTEAMS_HTTPS_PROXY ??
    env.HTTPS_PROXY ??
    env.https_proxy ??
    env.ALL_PROXY ??
    env.all_proxy;
  if (explicit !== undefined) return explicit.trim();
  if (process.platform !== "darwin") return "";
  if (proxyCache && proxyCache.expires > Date.now()) return proxyCache.url;
  let url = "";
  try {
    const { stdout } = await promisify(execFile)(
      "/usr/sbin/scutil",
      ["--proxy"],
      { timeout: 2000, maxBuffer: 16 * 1024 },
    );
    if (/HTTPSEnable\s*:\s*1/.test(stdout)) {
      const host = /HTTPSProxy\s*:\s*([^\s]+)/.exec(stdout)?.[1],
        port = /HTTPSPort\s*:\s*(\d+)/.exec(stdout)?.[1];
      if (host && port) url = `http://${host}:${port}`;
    }
  } catch {
    /* No configured system proxy. */
  }
  proxyCache = { expires: Date.now() + 5000, url };
  return url;
}
export const fetchArticle: ArticleFetch = async (url, signal) => {
  canonicalizeUrl(url); // Same public-host policy for page and every discovered image.
  const proxy = await configuredArticleProxy();
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    try {
      return await requestURL(url, {
        signal,
        proxy,
        maxBytes: MAX_RESPONSE_BYTES,
        timeoutMs: 25000,
        headers: {
          // Preserve PuddingClaw's read-later request profile. Node derives Host
          // from each validated URL so redirects cannot retain the old host.
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/json,text/plain,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1",
          "Accept-Encoding": "gzip, deflate",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          Connection: "close",
        },
      });
    } catch (error) {
      last = error;
      if (
        signal.aborted ||
        /证书|certificate|非公网|禁止|无效|大小|超限|解码|重定向/.test(
          String(error),
        )
      )
        break;
      if (attempt < 2)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(done, 200 * (attempt + 1));
          function done() {
            signal.removeEventListener("abort", abort);
            resolve();
          }
          function abort() {
            clearTimeout(timer);
            reject(signal.reason);
          }
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
    }
  }
  throw last;
};
function decodeWithLabel(bytes: Buffer, label: string): string {
  const decoder = new TextDecoder(label);
  const decoded = decoder.decode(bytes);
  // Some Node builds expose Latin-1 C1 controls for Windows-1252 aliases.
  // Keep the browser's Windows-1252 mapping consistent across runtime versions.
  if (decoder.encoding !== "windows-1252") return decoded;
  const c1 = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";
  return decoded.replace(/[\u0080-\u009f]/g, (char) => c1[char.charCodeAt(0) - 0x80]!);
}
export function decodeArticle(bytes: Buffer, contentType: string): string {
  // A BOM takes precedence over HTTP/meta labels, as it does in a browser.
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
    return new TextDecoder("utf-8").decode(bytes);
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])))
    return new TextDecoder("utf-16le").decode(bytes);
  if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff])))
    return new TextDecoder("utf-16be").decode(bytes);
  const declared = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
  const isHtml = /^(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType);
  const htmlCharset = isHtml
    ? /<meta\b[^>]*\bcharset\s*=\s*["']?([^\s;"'/>]+)/i.exec(
        bytes.subarray(0, 4096).toString("latin1"),
      )?.[1]
    : undefined;
  const label = declared || htmlCharset;
  if (label) {
    try {
      return decodeWithLabel(bytes, label);
    } catch {
      /* Unsupported label: use the same fallback as an undeclared response. */
    }
  }
  // Keep modern unlabelled UTF-8 pages intact. Older Western HTML (including
  // Word exports) uses single-byte Windows-1252 without declaring a charset.
  // Decode strictly before falling back, so invalid bytes are not lost as U+FFFD.
  if (isHtml) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return decodeWithLabel(bytes, "windows-1252");
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}
