import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { decodeArticle, fetchArticle } from "./public-fetch.js";

test("正文编码保留声明、BOM 和 UTF-8，未声明的旧 HTML 回退 Windows-1252", () => {
  const legacy = Buffer.from("<p>Prot\xe9g\xe9 \xb7 \x93ontology\x94</p>", "latin1");
  assert.equal(decodeArticle(legacy, "text/html"), "<p>Protégé · “ontology”</p>");
  assert.equal(decodeArticle(legacy, "text/html; charset=iso-8859-1"), "<p>Protégé · “ontology”</p>");
  const utf8 = "<p>中文 · Protégé 🧠</p>";
  assert.equal(decodeArticle(Buffer.from(utf8), "text/html"), utf8);
  const meta = Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=windows-1252">'), legacy]);
  assert.match(decodeArticle(meta, "text/html"), /Protégé · “ontology”/);
  assert.match(decodeArticle(legacy, "text/html; charset=utf-8"), /\uFFFD/);
  assert.match(decodeArticle(legacy, "text/plain"), /\uFFFD/);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(utf8)]);
  assert.equal(decodeArticle(bom, "text/html; charset=windows-1252"), utf8);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf8, "utf16le")]);
  assert.equal(decodeArticle(utf16, "text/html; charset=utf-8"), utf8);
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(utf8, "utf16le").swap16()]);
  assert.equal(decodeArticle(utf16be, "text/html"), utf8);
});

test("稍后读沿用Claw请求头：重定向逐跳保留、gzip可解码、私网仍被拒绝", async (t) => {
  const originalProxy = process.env.PUDDINGTEAMS_HTTPS_PROXY;
  process.env.PUDDINGTEAMS_HTTPS_PROXY = "";
  t.after(() => {
    if (originalProxy === undefined) delete process.env.PUDDINGTEAMS_HTTPS_PROXY;
    else process.env.PUDDINGTEAMS_HTTPS_PROXY = originalProxy;
  });
  const requests: { url: string; options: https.RequestOptions }[] = [];
  const body = Buffer.from("<article>离线测试正文，不访问外部网站。</article>");
  t.mock.method(
    https,
    "request",
    ((
      url: URL,
      options: https.RequestOptions,
      respond: (response: IncomingMessage) => void,
    ) => {
      requests.push({ url: url.href, options });
      const first = requests.length === 1;
      const response = Object.assign(new PassThrough(), {
        statusCode: first ? 302 : 200,
        headers: first
          ? { location: "https://1.1.1.1/article" }
          : {
              "content-type": "text/html; charset=utf-8",
              "content-encoding": "gzip",
            },
      });
      return Object.assign(new EventEmitter(), {
        end() {
          queueMicrotask(() => {
            respond(response as unknown as IncomingMessage);
            response.end(first ? Buffer.alloc(0) : gzipSync(body));
          });
        },
      });
    }) as unknown as typeof https.request,
  );

  const result = await fetchArticle(
    "https://8.8.8.8/start",
    new AbortController().signal,
  );
  assert.deepEqual(requests.map((request) => request.url), [
    "https://8.8.8.8/start",
    "https://1.1.1.1/article",
  ]);
  for (const { options } of requests) {
    const headers = options.headers as Record<string, string>;
    assert.equal(
      headers["User-Agent"],
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    );
    assert.equal(headers["Accept-Language"], "zh-CN,zh;q=0.9,en;q=0.8");
    assert.equal(
      headers.Accept,
      "text/html,application/json,text/plain,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1",
    );
    assert.equal(headers["Accept-Encoding"], "gzip, deflate");
    assert.equal(headers.Connection, "close");
    assert.equal(headers.Host, undefined); // Node supplies the current URL's Host.
    assert.equal(options.rejectUnauthorized, true);
  }
  assert.deepEqual(result.body, body);
  assert.equal(result.status, 200);
  await assert.rejects(
    fetchArticle("https://127.0.0.1/article", new AbortController().signal),
    /非公网/,
  );
  assert.equal(requests.length, 2);
});
