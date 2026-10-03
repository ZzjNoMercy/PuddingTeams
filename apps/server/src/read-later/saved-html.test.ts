import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { ReadLaterStore } from "./store.js";
import { ReadLaterCaptureService } from "./capture-service.js";
import { importSavedHtml } from "./saved-html.js";
import { registerReadLaterRoutes } from "../routes/read-later.js";
import { localViewerIdentity } from "../routes/identity.js";
import type { ReadLaterPromoter } from "./promote.js";

const url = "https://mp.weixin.qq.com/s/saved-example";
const body = "公众号正文介绍采集、持久化以及人工审核，结构与笔记保持独立。".repeat(8);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");
const html = `<meta property="og:url" content="${url}"><h1 id="activity-name">已保存的公众号文章</h1><span id="js_name">测试公众号</span><nav>页面导航</nav><div id="js_content"><h2>正文小节</h2><p>${body}</p><img data-src="https://mmbiz.qpic.cn/original.png" src="文章_files/原图.png" alt="正文示意图"><script>window.bad = '不能执行';</script></div>`;
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pt-saved-html-"));
  const store = new ReadLaterStore(root);
  const owner = localViewerIdentity().user.id;
  const item = store.create(owner, { operationId: "save", url, note: "私人笔记", tags: ["技术"] }).item;
  return { root, store, owner, item, input: { operationId: "import", expectedRevision: item.revision, filename: "文章.html", html, images: [{ path: "原图.png", base64: png.toString("base64") }] }, close: () => rm(root, { recursive: true, force: true }) };
}
test("微信保存页正文与本地图片离线归档，持久化标签/笔记/来源与幂等回执", async () => {
  const f = await fixture();
  try {
    const stale = f.store.claim("old-worker")!;
    const imported = await importSavedHtml(f.store, f.owner, f.item.id, f.input);
    assert.equal(imported.item.parseStatus, "ready");
    assert.equal(imported.item.title, "已保存的公众号文章");
    assert.equal(imported.item.author, "测试公众号");
    assert.equal(imported.item.note, "私人笔记");
    assert.deepEqual(imported.item.tags, ["技术"]);
    assert.equal(imported.item.readingStatus, "unread");
    assert.equal(f.store.job(f.owner, stale.id).status, "cancelled");
    assert.equal(f.store.complete(stale, { error: "迟到的采集" }), false);
    const version = f.store.version(f.owner, f.item.id)!;
    assert.equal(version.captureMethod, "saved_html");
    assert.equal(version.sourceFilename, "文章.html");
    assert.equal(version.assets.length, 1);
    assert.match(version.content, /## 正文小节/);
    assert.doesNotMatch(version.content, /不能执行|window.bad|页面导航|read-later-image:/);
    assert.match(version.content, /assets\/[a-f0-9]+\.png/);
    assert.equal(version.assets[0]!.sourceUrl, "saved-page:文章_files/原图.png");
    assert.deepEqual(await readFile(path.join(f.root, "assets", f.item.id, version.id, version.assets[0]!.path)), png);
    const again = await importSavedHtml(f.store, f.owner, f.item.id, f.input);
    assert.equal(again.replayed, true);
    assert.equal(again.item.activeVersionId, version.id);
    assert.deepEqual(await readdir(path.join(f.root, "assets", f.item.id)), [version.id]);
    assert.equal(new ReadLaterStore(f.root).version(f.owner, f.item.id)!.content, version.content);
    await assert.rejects(importSavedHtml(f.store, f.owner, f.item.id, { ...f.input, html: html.replace(body, body + "改变") }), /不同内容/);
  } finally { await f.close(); }
});
test("验证页、正文太短、错误来源、越权、过期revision与非法图片不能污染原收藏", async () => {
  const f = await fixture();
  try {
    const bad = [
      { ...f.input, html: `<h2>环境异常</h2><a id="js_verify">去验证</a><p>${body}</p>` },
      { ...f.input, html: "<div id='js_content'>太短</div>" },
      { ...f.input, html: `<body><p>${body}</p></body>` },
      { ...f.input, html: html.replace(url, "https://mp.weixin.qq.com/s/another") },
      { ...f.input, images: [{ path: "../private.png", base64: png.toString("base64") }] },
      { ...f.input, images: [{ path: "x.png", base64: Buffer.from("不是图片").toString("base64") }] },
      { ...f.input, html: "x".repeat(5 * 1024 * 1024 + 1) },
    ];
    for (const input of bad) await assert.rejects(importSavedHtml(f.store, f.owner, f.item.id, input));
    await assert.rejects(importSavedHtml(f.store, "other", f.item.id, f.input), /不存在/);
    f.store.update(f.owner, f.item.id, { expectedRevision: 1, note: "并发新笔记" });
    await assert.rejects(importSavedHtml(f.store, f.owner, f.item.id, f.input), /已变化/);
    assert.equal(f.store.version(f.owner, f.item.id), undefined);
    assert.equal(f.store.get(f.owner, f.item.id).note, "并发新笔记");
    assert.deepEqual(await readdir(path.join(f.root, "assets", f.item.id)), []);
  } finally { await f.close(); }
});
test("内嵌图片去重，不访问缺失的远程图片，微信长短链接差异明确提示", async () => {
  const f = await fixture();
  try {
    const encoded = `data:image/png;base64,${png.toString("base64")}`;
    const importedHtml = html.replace(url, "http://mp.weixin.qq.com/s?__biz=test&amp;mid=1&amp;idx=1&amp;sn=test")
      .replace('src="文章_files/原图.png"', `src="${encoded}"`)
      .replace("</div>", `<img src="${encoded}"><img src="https://example.com/missing.png"></div>`);
    await importSavedHtml(f.store, f.owner, f.item.id, { ...f.input, html: importedHtml, images: [] });
    const version = f.store.version(f.owner, f.item.id)!;
    assert.equal(version.assets.length, 1);
    assert.match(version.assets[0]!.sourceUrl, /^saved-page:embedded\/[a-f0-9]+$/);
    assert(version.warnings.some(w => w.includes("无法离线核对")));
    assert(version.warnings.some(w => w.includes("1 张图片未导入")));
    assert.match(version.content, /图片未导入/);
    assert(!version.assets.some(asset => asset.sourceUrl.startsWith("https:")));
  } finally { await f.close(); }
});
test("HTML导入替换正文但保留用户标题和阅读状态，拒绝删除后的请求", async () => {
  const f = await fixture();
  try {
    const changed = f.store.update(f.owner, f.item.id, { expectedRevision: 1, title: "我的标题", readingStatus: "archived" });
    const imported = await importSavedHtml(f.store, f.owner, f.item.id, { ...f.input, expectedRevision: changed.revision });
    assert.equal(imported.item.title, "我的标题"); assert.equal(imported.item.readingStatus, "archived");
    const old = f.store.version(f.owner, f.item.id)!;
    const next = await importSavedHtml(f.store, f.owner, f.item.id, { ...f.input, operationId: "next", expectedRevision: imported.item.revision, html: html.replace(body, body + "新增内容") });
    assert.notEqual(next.item.activeVersionId, old.id);
    assert.equal(f.store.version(f.owner, f.item.id, old.id)!.content, old.content);
    f.store.remove(f.owner, f.item.id, next.item.revision);
    await assert.rejects(importSavedHtml(f.store, f.owner, f.item.id, { ...f.input, operationId: "deleted", expectedRevision: next.item.revision }), /不存在/);
  } finally { await f.close(); }
});
test("真实HTML导入路由支持超过默认1MB的文件，验证失败400、CAS冲突409、越权404", async () => {
  const f = await fixture(), app = Fastify();
  const capture = new ReadLaterCaptureService(f.store, async () => { throw new Error("导入不能访问网络"); });
  registerReadLaterRoutes(app, { store: f.store, capture, promoter: {} as ReadLaterPromoter });
  try {
    const route = `/api/read-later/${f.item.id}/import-html`;
    const bad = await app.inject({ method: "POST", url: route, payload: { ...f.input, html: "短文" } });
    assert.equal(bad.statusCode, 400);
    const payload = { ...f.input, html: html + `<!--${"x".repeat(1100000)}-->` };
    const good = await app.inject({ method: "POST", url: route, payload });
    assert.equal(good.statusCode, 200); assert.equal(good.json().item.parseStatus, "ready");
    assert(!JSON.stringify(good.json()).includes("ownerId"));
    assert.equal((await app.inject({ method: "POST", url: route, payload: { ...f.input, operationId: "stale" } })).statusCode, 409);
    const foreign = f.store.create("other", { operationId: "foreign", url: "https://example.com/foreign" }).item;
    assert.equal((await app.inject({ method: "POST", url: `/api/read-later/${foreign.id}/import-html`, payload: f.input })).statusCode, 404);
  } finally { await app.close(); await capture.close(); await f.close(); }
});
