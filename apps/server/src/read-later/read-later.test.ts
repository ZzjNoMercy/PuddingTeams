import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { canonicalizeUrl, decodeArticle } from "./public-fetch.js";
import { extractArticle } from "./extract.js";
import { ReadLaterStore, digest } from "./store.js";
import { DatabaseSync } from "node:sqlite";
import { ReadLaterCaptureService } from "./capture-service.js";
import { registerReadLaterRoutes } from "../routes/read-later.js";
import { localViewerIdentity } from "../routes/identity.js";
import type { ReadLaterPromoter } from "./promote.js";
const body =
  "这是一篇需要完整保存的技术文章，介绍 Agent 的工作流、状态持久化、任务恢复以及人工审核边界。".repeat(
    6,
  );
const png = Buffer.concat([
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=",
    "base64",
  ),
  Buffer.alloc(300),
]);
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pt-read-later-"));
  return {
    root,
    store: new ReadLaterStore(root),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
async function settled(store: ReadLaterStore, owner: string, id: string) {
  for (let i = 0; i < 300; i++) {
    const item = store.get(owner, id);
    if (!["queued", "processing"].includes(item.parseStatus)) return item;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("采集未结束");
}
test("URL公开边界、追踪去重和正文编码", () => {
  assert.equal(
    canonicalizeUrl("HTTPS://Example.com//article?utm_source=x&b=2&a=1#part"),
    "https://example.com/article?a=1&b=2",
  );
  for (const url of [
    "file:///tmp/x",
    "http://127.0.0.1",
    "http://2130706433",
    "https://[::1]",
    "https://user:pass@example.com",
    "https://198.18.1.1",
  ]) {
    assert.throws(() => canonicalizeUrl(url));
  }
  assert.equal(
    decodeArticle(Buffer.from("中文"), "text/html; charset=utf-8"),
    "中文",
  );
});
test("普通网页、微信、X Relay、纯文本保持正文与安全媒体", () => {
  const html = `<title>技术文章</title><meta property="og:image" content="https://img.example.com/cover.png"><nav>${"广告".repeat(200)}</nav><article><h2>段落标题</h2><p>${body}</p><img data-src="https://img.example.com/a.png" alt="原图"><a href="javascript:alert(1)">坏链接</a><table><tr><th>项</th><th>值</th></tr><tr><td>A</td><td>1</td></tr></table></article>`;
  const normal = extractArticle(html, "https://example.com/a");
  assert.match(normal.content, /## 段落标题/);
  assert.match(normal.content, /\| 项 \| 值 \|/);
  assert.doesNotMatch(normal.content, /广告|javascript:/);
  assert.equal(normal.images.length, 2);
  assert.deepEqual(normal.warnings, []);
  const wechat = extractArticle(
    `<h1 id="activity-name">微信标题</h1><span id="js_name">公众号</span><div id="js_content"><section>${body}</section><img data-src="https://mmbiz.qpic.cn/a.png"></div>`,
    "https://mp.weixin.qq.com/s?a=1",
  );
  assert.equal(wechat.author, "公众号");
  assert.equal(wechat.title, "微信标题");
  assert.match(wechat.content, /任务恢复/);
  const x = extractArticle(
    `<meta property="og:title" content="Alice (@alice) on X"><meta property="og:description" content="${body}"><script>{"original_img_url":"https:\\/\\/pbs.twimg.com\\/media\\/a.png"}</script>`,
    "https://x.com/alice/status/1",
  );
  assert.equal(x.author, "Alice");
  assert.equal(x.images[0]?.url, "https://pbs.twimg.com/media/a.png");
  assert.equal(
    extractArticle(body, "https://example.com", "text/plain").content,
    body,
  );
  assert(
    extractArticle("<article>太短</article>", "https://example.com").warnings
      .length,
  );
});
test("Word HTML 的 Symbol 项目符号转为列表，普通间隔点和代码保持原样", () => {
  const article = extractArticle(`<article><p>${body}</p>
    <p class="Bulletedlist"><span style="font-family:Symbol">·<span>&nbsp;&nbsp; </span></span>定义 <strong>classes</strong></p>
    <p class="Bulletedlist"><span style="font-family:Symbol">·<span>&nbsp;&nbsp; </span></span>安排 hierarchy</p>
    <p class="Bulletedlist"><span style="font-family:Symbol">· </span></p>
    <p>普通 · 间隔点</p><p class="Bulletedlist">无符号的段落</p>
    <p class="Bulletedlist"><span style="font-family:Arial">· </span>普通字体内容</p>
    <pre><code>· code</code></pre></article>`, "https://example.com/word");
  assert.match(article.content, /- 定义 \*\*classes\*\* *\n- 安排 hierarchy/);
  assert.doesNotMatch(article.content, /^-\s*$/m);
  assert.match(article.content, /普通 · 间隔点/);
  assert.match(article.content, /无符号的段落/);
  assert.match(article.content, /· 普通字体内容/);
  assert.match(article.content, /```\n· code\n```/);
});
test("微信初始隐藏正文可读取，但隐藏子块与其他页面仍过滤", () => {
  const html = `<h1 id="activity-name">微信标题</h1><div id="js_content" style="visibility: hidden; opacity: 0"><section>${body}</section><p style="visibility: hidden">隐藏子块</p><p style="display: none">隐藏广告</p><p hidden>隐藏属性</p><p aria-hidden="true">辅助隐藏</p></div>`;
  const article = extractArticle(html, "https://mp.weixin.qq.com/s/example");
  assert.match(article.content, /任务恢复/);
  assert.doesNotMatch(article.content, /隐藏子块|隐藏广告|隐藏属性|辅助隐藏/);
  assert.deepEqual(article.warnings, []);
  assert.equal(article.unavailableReason, undefined);
  assert.equal(extractArticle(html, "https://example.com/article").content, "");
  assert.equal(
    extractArticle(
      `<div id="js_content" style="display:none">${body}</div>`,
      "https://mp.weixin.qq.com/s/example",
    ).content,
    "",
  );
});
test("微信代码块保留逐行文本与空行，过滤行号空项而不损坏真实列表", () => {
  const article = extractArticle(
    `<div id="js_content"><p>${body}</p><div class="code-snippet"><ul class="code-snippet__line-index"><li>1</li><li>2</li><li></li></ul><pre><code><span class="code-snippet__line"><span>第一行</span><span>内容</span></span><span class="code-snippet__line"></span><span class="code-snippet__line"></span><span class="code-snippet__line">\t第四行</span></code></pre></div><ul><li></li><li><span> </span></li><li>真实列表项</li><li><img src="https://example.com/a.png"></li></ul><pre><code>甲<br>乙<br>\n丙\n\`\`\`</code></pre></div>`,
    "https://mp.weixin.qq.com/s/example",
  );
  assert.match(article.content, /```\n第一行内容\n\n\n\t第四行\n```/);
  assert.match(article.content, /````\n甲\n乙\n\n丙\n```\n````/);
  assert.match(article.content, /- 真实列表项/);
  assert.match(article.content, /- !\[\]\(read-later-image:0\)/);
  assert.doesNotMatch(article.content, /^-\s*$/m);
  assert.doesNotMatch(article.content, /^- [12]$/m);
  const nested = extractArticle(
    `<article><p>${body}</p><ul><li><pre>甲\n\n\n乙</pre></li></ul><blockquote><pre>丙\n丁</pre></blockquote></article>`,
    "https://example.com/code",
  );
  assert.match(nested.content, /- ```\n  甲\n  \n  \n  乙\n  ```/);
  assert.match(nested.content, /> ```\n> 丙\n> 丁\n> ```/);
});
test("微信验证页不是文章：重定向、长提示和相同URL均保留明确原因", () => {
  const challenge = `<h2>环境异常</h2><p>当前环境异常，完成验证后即可继续访问。</p><a id="js_verify">去验证</a><p>${body}</p><img src="https://img.example.com/challenge.png">`;
  for (const url of ["https://mp.weixin.qq.com/s/example", "https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=temporary"]) {
    const result = extractArticle(challenge, url);
    assert.match(result.unavailableReason!, /微信要求安全验证/);
    assert.equal(result.content, "");
    assert.deepEqual(result.images, []);
    assert.deepEqual(result.warnings, []);
  }
  assert.match(extractArticle("", "https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha").unavailableReason!, /安全验证/);
  const valid = extractArticle(`<h1 id="activity-name">验证技术介绍</h1><div id="js_content">环境异常，完成验证后即可继续访问。${body}<a id="js_verify">演示按钮</a></div>`, "https://mp.weixin.qq.com/s/example");
  assert.equal(valid.unavailableReason, undefined);
  assert.match(valid.content, /任务恢复/);
});
test("微信验证响应不生成正文或保存验证token，重抓保留旧版本和笔记", async () => {
  const f = await fixture();
  let blocked = true;
  const requests: string[] = [];
  const capture = new ReadLaterCaptureService(f.store, async url => {
    requests.push(url);
    return {
      status: 200, url: blocked ? "https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?poc_token=temporary" : url,
      headers: { "content-type": "text/html" },
      body: Buffer.from(blocked ? `<p>${body}</p><img src="https://img.example.com/challenge.png">` : `<h1 id="activity-name">真实文章</h1><div id="js_content">${body}</div>`),
    };
  });
  try {
    const initial = f.store.create("owner", { operationId: "wx", url: "https://mp.weixin.qq.com/s/example", note: "私人笔记", tags: ["技术"] }).item;
    capture.start();
    const onlyLink = await settled(f.store, "owner", initial.id);
    assert.equal(onlyLink.parseStatus, "link_only");
    assert.match(onlyLink.errorMessage!, /安全验证/);
    assert.equal(f.store.version("owner", initial.id), undefined);
    assert(!JSON.stringify(onlyLink).includes("poc_token"));
    assert.equal(requests.length, 1, "验证页图片不应发起采集");
    blocked = false;
    f.store.retry("owner", initial.id, onlyLink.revision, "allowed");
    await capture.tick();
    const ready = await settled(f.store, "owner", initial.id);
    const version = f.store.version("owner", initial.id)!;
    assert.equal(ready.title, "真实文章");
    blocked = true;
    f.store.retry("owner", initial.id, ready.revision, "blocked-again");
    await capture.tick();
    const retained = await settled(f.store, "owner", initial.id);
    assert.equal(retained.parseStatus, "ready");
    assert.equal(retained.activeVersionId, version.id);
    assert.equal(retained.title, "真实文章");
    assert.equal(retained.note, "私人笔记");
    assert.deepEqual(retained.tags, ["技术"]);
    assert.match(retained.errorMessage!, /安全验证/);
    assert(!JSON.stringify(retained).includes("poc_token"));
  } finally {
    await capture.close();
    await f.close();
  }
});
test("续租保留当前采集阶段与进度，过期worker不能重置新worker的进度", async () => {
  const f = await fixture();
  try {
    f.store.create("owner", { operationId: "heartbeat", url: "https://example.com/progress" });
    const stale = f.store.claim("stale", -1)!;
    const current = f.store.claim("current", 1)!;
    assert(f.store.progress(current, "归档正文与图片", 65));
    assert(f.store.progress(current));
    assert.equal(f.store.progress(stale, "正在采集", 20), false);
    const job = f.store.job("owner", current.id);
    assert.equal(job.step, "归档正文与图片");
    assert.equal(job.progress, 65);
    assert(Date.parse(job.leaseExpiresAt!) > Date.now() + 20000);
  } finally { await f.close(); }
});
test("X长文章优先完整正文，不把短OG标题或评论当正文", () => {
  const html = `<meta property="og:title" content="Alice (@alice) on X"><meta property="og:description" content="长文章标题"><main><article><div>登录 100 200</div><div itemscope itemtype="https://schema.org/Article"><h1>长文章标题</h1><div class="x-article-body break-words"><h2>正文小节</h2><p>${body}</p><a href="https://x.com/alice/article/123/media/1"><img src="https://pbs.twimg.com/media/body.png" alt="示意图"></a><script>不能执行</script></div></div></article><article>评论内容 ${body}</article></main>`;
  for (const host of ["x.com", "www.x.com", "twitter.com", "www.twitter.com"]) {
    const article = extractArticle(html, `https://${host}/alice/status/123`);
    assert.equal(article.title, "长文章标题");
    assert.match(article.content, /## 正文小节/);
    assert.match(article.content, /人工审核边界/);
    assert.doesNotMatch(article.content, /评论内容|登录|不能执行/);
    assert.doesNotMatch(article.content, /\[\n+!\[/);
    assert.equal(article.images[0]?.url, "https://pbs.twimg.com/media/body.png");
    assert.deepEqual(article.warnings, []);
  }
  const structured = extractArticle(html.replace('class="x-article-body break-words"', 'itemprop="articleBody"'), "https://x.com/alice/article/123");
  assert.match(structured.content, /正文小节/);
  const shortTweet = extractArticle('<meta property="og:description" content="短推文"><main>登录 Sign up</main>', 'https://x.com/alice/status/456');
  assert.equal(shortTweet.content, "短推文");
  assert(shortTweet.warnings.some(w => w.includes("不足 80")));
});
test("SQLite唯一收藏、操作幂等、CAS、正文搜索、分页与租约恢复", async () => {
  const f = await fixture();
  try {
    const first = f.store.create("a", {
      operationId: "one",
      url: "https://example.com/a?utm_source=x",
      note: "原笔记",
    });
    assert.equal(
      f.store.create("a", {
        operationId: "two",
        url: "https://example.com/a",
        note: "不能覆盖",
      }).item.note,
      "原笔记",
    );
    assert.equal(
      f.store.create("a", {
        operationId: "one",
        url: "https://example.com/a?utm_source=x",
        note: "原笔记",
      }).replayed,
      true,
    );
    assert.throws(
      () =>
        f.store.create("a", {
          operationId: "one",
          url: "https://example.com/b",
        }),
      /不同收藏/,
    );
    assert.throws(() => f.store.get("b", first.item.id));
    const changed = f.store.update("a", first.item.id, {
      expectedRevision: 1,
      readingStatus: "read",
      tags: ["设计"],
    });
    assert.equal(changed.revision, 2);
    assert.throws(
      () =>
        f.store.update("a", first.item.id, {
          expectedRevision: 1,
          note: "失效",
        }),
      /已变化/,
    );
    const job = f.store.claim("old", -1)!;
    const recovered = new ReadLaterStore(f.root).claim("new")!;
    assert.equal(recovered.id, job.id);
    assert.equal(f.store.complete(job, { error: "过期worker" }), false);
    assert.equal(
      f.store.complete(recovered, {
        metadata: { title: "抓取标题" },
        version: {
          id: "version",
          itemId: first.item.id,
          content: body,
          contentHash: "h",
          assets: [],
          warnings: [],
          capturedAt: new Date().toISOString(),
          extractorVersion: "test",
          captureMethod: "http",
        },
      }),
      true,
    );
    const latest = f.store.get("a", first.item.id);
    const manual = f.store.update("a", first.item.id, {
      expectedRevision: latest.revision,
      title: "我的标题",
    });
    assert.equal(
      f.store.update("a", first.item.id, {
        expectedRevision: manual.revision,
        title: "",
      }).title,
      "抓取标题",
    );
    assert.equal(f.store.list("a", { q: "人工审核" }).total, 1);
    f.store.create("a", { operationId: "three", url: "https://example.com/b" });
    const page = f.store.list("a", { limit: 1 });
    assert.equal(page.items.length, 1);
    assert.equal(
      f.store.list("a", { limit: 1, cursor: page.nextCursor! }).items.length,
      1,
    );
    assert.throws(() => f.store.list("a", { limit: NaN }));
  } finally {
    await f.close();
  }
});
test("采集版本与图片本地化、部分图片失败、重试保留旧版本与删除围栏", async () => {
  const f = await fixture();
  let short = false;
  const capture = new ReadLaterCaptureService(f.store, async (url) => ({
    status: 200,
    url,
    headers: {
      "content-type": url.includes("img.") ? "image/png" : "text/html",
    },
    body: url.includes("img.")
      ? png
      : Buffer.from(
          `<title>${short ? "登录后阅读" : "技术文章"}</title><article>${short ? "短文" : body}<img alt="图 [嵌套描述]" src="https://img.example.com/a.png"><img src="http://127.0.0.1/private.png"></article>`,
        ),
  }));
  try {
    const created = f.store.create("owner", {
      operationId: "capture",
      url: "https://example.com/a",
    });
    capture.start();
    const item = await settled(f.store, "owner", created.item.id),
      version = f.store.version("owner", item.id)!;
    assert.equal(item.parseStatus, "ready");
    assert.equal(version.assets.length, 1);
    assert.deepEqual(f.store.list("owner").items[0]?.thumbnail, {
      versionId: version.id,
      assetId: version.assets[0]!.id,
      alt: version.assets[0]!.alt,
    });
    assert.equal(f.store.list("other").items.length, 0);
    assert.match(version.content, /assets\/[a-f0-9]+\.png/);
    assert.doesNotMatch(version.content, /read-later-image:/);
    assert.deepEqual(
      (await capture.asset("owner", item.id, version.id, version.assets[0]!.id))
        .bytes,
      png,
    );
    await assert.rejects(
      capture.asset("other", item.id, version.id, version.assets[0]!.id),
    );
    short = true;
    f.store.retry("owner", item.id, item.revision, "retry1");
    await capture.tick();
    const retried = await settled(f.store, "owner", item.id);
    assert.equal(retried.parseStatus, "ready");
    assert.equal(retried.activeVersionId, version.id);
    assert.equal(f.store.list("owner").items[0]?.thumbnail?.versionId, version.id);
    assert.equal(retried.title, "技术文章", "失败的重抓不能污染旧正文的标题");
    assert.match(retried.errorMessage!, /不足/);
    const queued = f.store.retry("owner", item.id, retried.revision, "retry2");
    const stale = f.store.claim("stale")!;
    await capture.remove("owner", item.id, queued.item.revision);
    assert.equal(f.store.complete(stale, { error: "不能复活" }), false);
    assert.throws(() => f.store.get("owner", item.id));
    await assert.rejects(
      capture.asset("owner", item.id, version.id, version.assets[0]!.id),
    );
    assert.deepEqual(await readdir(path.join(f.root, "assets")), []);
  } finally {
    await capture.close();
    await f.close();
  }
});
test("任务服务端分页稳定且按全部任务统计筛选；越权和删除摘要保持边界", async () => {
  const f = await fixture(), capture = new ReadLaterCaptureService(f.store), app = Fastify();
  registerReadLaterRoutes(app, { store: f.store, capture, promoter: {} as ReadLaterPromoter });
  const owner = localViewerIdentity().user.id;
  try {
    const items = Array.from({ length: 45 }, (_, index) => f.store.create(owner, {
      operationId: `page-${index}`, url: `https://example.com/page/${index}`, title: `任务 ${index}`,
    }).item);
    f.store.create("other", { operationId: "foreign-page", url: "https://example.com/foreign-page" });
    const short = f.store.claim("fixture")!;
    f.store.complete(short, { error: "正文不足 80 字" });
    const failed = f.store.claim("fixture")!;
    f.store.complete(failed, { failed: true, error: "HTTP 403" });
    const removed = items.find(item => item.id !== short.itemId && item.id !== failed.itemId)!;
    f.store.remove(owner, removed.id, removed.revision);
    const pages = await Promise.all([1, 2, 3].map(async page => {
      const response = await app.inject(`/api/read-later/jobs?page=${page}`);
      assert.equal(response.statusCode, 200);
      return response.json();
    }));
    assert.deepEqual(pages.map(p => p.jobs.length), [20, 20, 5]);
    assert.deepEqual(pages[0].counts, { all: 45, active: 42, problem: 2 });
    assert.equal(pages[0].total, 45); assert.equal(pages[0].pages, 3);
    assert.equal(new Set(pages.flatMap(p => p.jobs.map((job: { id: string }) => job.id))).size, 45);
    assert.deepEqual((await app.inject('/api/read-later/jobs?page=1')).json().jobs.map((job: { id: string }) => job.id), pages[0].jobs.map((job: { id: string }) => job.id));
    const problem = (await app.inject('/api/read-later/jobs?filter=problem')).json();
    assert.equal(problem.total, 2); assert.equal(problem.jobs.length, 2);
    assert.deepEqual(problem.counts, pages[0].counts, "筛选计数属于全部任务而非当前页");
    assert.equal(problem.jobs.find((job: { id: string }) => job.id === short.id).errorMessage, "正文不足 80 字");
    const active = (await app.inject('/api/read-later/jobs?filter=active&page=3')).json();
    assert.equal(active.total, 42); assert.equal(active.jobs.length, 2);
    assert(active.jobs.every((job: { status: string }) => job.status === "queued"));
    const removedSummary = pages.flatMap(p => p.jobs).find(job => job.itemId === removed.id);
    assert.equal(removedSummary.title, removed.title); assert.equal(removedSummary.itemAvailable, false);
    assert.equal((await app.inject('/api/read-later/jobs?page=99')).json().page, 3);
    for (const query of ['page=0', 'page=no', 'page=1.5', 'limit=0', 'limit=101', 'filter=invalid']) {
      assert.equal((await app.inject(`/api/read-later/jobs?${query}`)).statusCode, 400);
    }
  } finally { await app.close(); await capture.close(); await f.close(); }
});

test("批量已读按归属原子执行，全部已读覆盖分页并保留归档与内容", async () => {
  const f = await fixture(), capture = new ReadLaterCaptureService(f.store), app = Fastify();
  registerReadLaterRoutes(app, { store: f.store, capture, promoter: {} as ReadLaterPromoter });
  const owner = localViewerIdentity().user.id;
  const save = (index: number, user = owner) => f.store.create(user, {
    operationId: `bulk-${index}`, url: `https://example.com/bulk/${index}`,
    note: "我的笔记", tags: ["测试"],
  }).item;
  const post = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/read-later/mark-read", payload });
  try {
    const first = save(0), second = save(1), foreign = save(2, "other");
    assert.equal((await post({ scope: "selected", items: [
      { id: first.id, expectedRevision: first.revision },
      { id: foreign.id, expectedRevision: foreign.revision },
    ] })).statusCode, 404);
    assert.equal(f.store.get(owner, first.id).readingStatus, "unread", "越权不能造成部分成功");
    const edited = f.store.update(owner, second.id, { expectedRevision: second.revision, note: "刚编辑的笔记" });
    assert.equal((await post({ scope: "selected", items: [
      { id: first.id, expectedRevision: first.revision },
      { id: second.id, expectedRevision: second.revision },
    ] })).statusCode, 409);
    assert.equal(f.store.get(owner, first.id).readingStatus, "unread", "冲突不能造成部分成功");
    for (const payload of [{}, { scope: "selected", items: [] }, { scope: "selected", items: [{ id: first.id, expectedRevision: 0 }] }, { scope: "selected", items: [{ id: first.id, expectedRevision: first.revision }, { id: first.id, expectedRevision: first.revision }] }]) {
      assert.equal((await post(payload)).statusCode, 400);
    }
    assert.deepEqual((await post({ scope: "selected", items: [{ id: first.id, expectedRevision: first.revision }] })).json(), { changed: 1 });
    assert.equal(f.store.get(owner, second.id).readingStatus, "unread", "选中已读不影响未选中项");
    const read = f.store.get(owner, first.id);
    assert.equal(read.revision, first.revision + 1); assert(read.readAt);
    assert.deepEqual((await post({ scope: "selected", items: [{ id: first.id, expectedRevision: read.revision }] })).json(), { changed: 0 });
    assert.equal(f.store.get(owner, first.id).revision, read.revision, "已读项不重复更新时间与revision");
    const archived = save(3);
    f.store.update(owner, archived.id, { expectedRevision: archived.revision, readingStatus: "archived" });
    const deleted = save(4); f.store.remove(owner, deleted.id, deleted.revision);
    const more = Array.from({ length: 55 }, (_, index) => save(index + 5));
    assert.equal(f.store.list(owner, { filter: "unread" }).items.length, 50);
    assert.deepEqual((await post({ scope: "all" })).json(), { changed: 56 });
    assert.equal(f.store.list(owner).counts.unread, 0);
    assert.equal(f.store.get("other", foreign.id).readingStatus, "unread");
    assert.equal(f.store.get(owner, archived.id).readingStatus, "archived");
    assert.throws(() => f.store.get(owner, deleted.id));
    assert.equal(f.store.get(owner, second.id).note, edited.note);
    const last = f.store.get(owner, more.at(-1)!.id);
    assert.deepEqual(last.tags, ["测试"]); assert.equal(last.note, "我的笔记");
    assert.equal(last.latestJobId, more.at(-1)!.latestJobId); assert.equal(last.parseStatus, "queued");
    assert.deepEqual((await post({ scope: "all" })).json(), { changed: 0 });
    assert.equal(f.store.get(owner, last.id).revision, last.revision);
  } finally { await app.close(); await capture.close(); await f.close(); }
});

test("真实Fastify路由禁止越权、非法输入，首次收藏无需知识库", async () => {
  const f = await fixture(),
    capture = new ReadLaterCaptureService(f.store),
    app = Fastify();
  const promoter = {
    promote: async () => {
      throw new Error("不应调用");
    },
  } as unknown as ReadLaterPromoter;
  registerReadLaterRoutes(app, { store: f.store, capture, promoter });
  try {
    assert.equal((await app.inject('/api/read-later/gbrain/status')).statusCode, 404);
    assert.equal((await app.inject('/api/read-later/gbrain/imports')).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/read-later/gbrain/imports/removed/retry' })).statusCode, 404);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/read-later",
          payload: { operationId: "unsafe", url: "http://localhost/x" },
        })
      ).statusCode,
      400,
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/read-later",
      payload: { operationId: "route", url: "https://example.com/a" },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().item.ownerId, undefined);
    const foreign = f.store.create("other", {
      operationId: "foreign",
      url: "https://example.com/b",
    });
    assert.equal(
      (await app.inject(`/api/read-later/${foreign.item.id}`)).statusCode,
      404,
    );
    assert.equal(
      (await app.inject(`/api/read-later/jobs/${foreign.job.id}`)).statusCode,
      404,
    );
    assert.equal(
      (await app.inject(`/api/read-later/jobs/${response.json().job.id}`))
        .statusCode,
      200,
    );
    assert.equal(
      (await app.inject(`/api/read-later/${response.json().item.id}`))
        .statusCode,
      200,
    );
    assert.equal(f.store.list(localViewerIdentity().user.id).total, 1);
    const jobs = (await app.inject("/api/read-later/jobs")).json().jobs;
    assert.equal(jobs.length, 1, "任务摘要不能混入其他用户收藏");
    assert.equal(jobs[0].title, f.store.get(localViewerIdentity().user.id, response.json().item.id).title);
    assert.equal(jobs[0].source, "example.com");
    assert.equal(jobs[0].itemAvailable, true);
    assert.equal(jobs[0].ownerId, undefined);
    assert.equal(jobs[0].leaseOwner, undefined);
    const ownItem = f.store.get(localViewerIdentity().user.id, response.json().item.id);
    f.store.remove(localViewerIdentity().user.id, ownItem.id, ownItem.revision);
    const removedJobs = (await app.inject("/api/read-later/jobs")).json().jobs;
    assert.equal(removedJobs[0].title, ownItem.title, "历史任务仍可识别其文章");
    assert.equal(removedJobs[0].itemAvailable, false, "删除后不能提供失效的查看入口");
  } finally {
    await app.close();
    await capture.close();
    await f.close();
  }
});

test("旧库 operations.hash NOT NULL 自动迁移为可空，已有数据与幂等语义保留", async () => {
  const f = await fixture();
  try {
    const owner = "migration-owner", time = "2026-01-01T00:00:00.000Z";
    const item = { id: "item-1", ownerId: owner, originalUrl: "https://example.com/a", canonicalUrl: "https://example.com/a", title: "旧收藏", siteName: "example.com", author: "", description: "", readingStatus: "unread", parseStatus: "failed", latestJobId: "job-1", tags: [], note: "", revision: 2, generation: 1, createdAt: time, updatedAt: time };
    const job = { id: "job-1", itemId: item.id, ownerId: owner, generation: 1, status: "failed", step: "采集失败", progress: 0, createdAt: time, updatedAt: time };
    const legacy = new DatabaseSync(path.join(f.root, "read-later.sqlite"));
    legacy.exec(`CREATE TABLE items(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,url TEXT NOT NULL,deleted INTEGER NOT NULL,record_json TEXT NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
CREATE TABLE versions(id TEXT PRIMARY KEY,item_id TEXT NOT NULL,record_json TEXT NOT NULL);
CREATE TABLE operations(owner_id TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,item_id TEXT NOT NULL,job_id TEXT,PRIMARY KEY(owner_id,id));
CREATE TABLE promotions(owner_id TEXT NOT NULL,id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(owner_id,id));`);
    legacy.prepare("INSERT INTO items VALUES(?,?,?,?,?)").run(item.id, owner, item.canonicalUrl, 0, JSON.stringify(item));
    legacy.prepare("INSERT INTO jobs VALUES(?,?)").run(job.id, JSON.stringify(job));
    const saveHash = digest({ url: item.canonicalUrl, title: undefined, note: "", tags: [] });
    legacy.prepare("INSERT INTO operations VALUES(?,?,?,?,?)").run(owner, "save:op-save", saveHash, item.id, job.id);
    legacy.close();
    const store = new ReadLaterStore(f.root);
    const replayed = store.create(owner, { operationId: "op-save", url: item.originalUrl });
    assert.equal(replayed.replayed, true, "迁移后旧 save 操作的幂等回放必须保留");
    assert.equal(replayed.item.id, item.id);
    const retried = store.retry(owner, item.id, 2, "op-retry");
    assert.equal(retried.replayed, false, "迁移后 retry 写入 NULL hash 必须成功");
    assert.equal(store.retry(owner, item.id, 3, "op-retry").replayed, true);
    assert.equal(new ReadLaterStore(f.root).get(owner, item.id).id, item.id, "迁移必须幂等");
  } finally {
    await f.close();
  }
});
