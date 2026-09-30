import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { canonicalizeUrl, decodeArticle } from "./public-fetch.js";
import { extractArticle } from "./extract.js";
import { ReadLaterStore } from "./store.js";
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
  } finally {
    await app.close();
    await capture.close();
    await f.close();
  }
});
