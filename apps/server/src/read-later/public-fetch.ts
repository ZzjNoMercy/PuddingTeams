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
          Accept:
            "text/html,application/xhtml+xml,text/plain,image/avif,image/webp,image/*;q=0.8",
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
export function decodeArticle(bytes: Buffer, contentType: string): string {
  const declared = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1];
  const htmlCharset = /charset\s*=\s*["']?([^\s;"'/>]+)/i.exec(
    bytes.subarray(0, 4096).toString("ascii"),
  )?.[1];
  try {
    return new TextDecoder(declared || htmlCharset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
