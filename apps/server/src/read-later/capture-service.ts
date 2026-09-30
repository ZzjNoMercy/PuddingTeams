import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  actualImageMediaType,
  IMAGE_ASSET_EXTENSIONS,
} from "../knowledge/image-publication.js";
import { ReadLaterStore } from "./store.js";
import {
  ReadLaterError,
  type ArticleAsset,
  type ArticleVersion,
  type CaptureJob,
} from "./contracts.js";
import { extractArticle } from "./extract.js";
import {
  decodeArticle,
  fetchArticle,
  type ArticleFetch,
} from "./public-fetch.js";
export class ReadLaterCaptureService {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = true;
  private active = new Map<string, AbortController>();
  private activeItems = new Map<string, string>();
  private worker = randomUUID();
  private ticking = false;
  constructor(
    readonly store: ReadLaterStore,
    private fetch: ArticleFetch = fetchArticle,
  ) {}
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), 1000);
    this.timer.unref();
    void this.tick();
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const controller of this.active.values())
      controller.abort(new Error("服务正在停止"));
    while (this.active.size)
      await new Promise((resolve) => setTimeout(resolve, 20));
  }
  async remove(owner: string, id: string, revision: number) {
    this.store.remove(owner, id, revision);
    for (const [jobId, controller] of this.active) {
      if (this.activeItems.get(jobId) === id)
        controller.abort(new Error("收藏已删除"));
    }
    try {
      await this.cleanup();
      return { deleted: true, cleanupPending: false };
    } catch {
      return { deleted: true, cleanupPending: true };
    }
  }
  private async cleanup() {
    for (const item of this.store.cleanupItems()) {
      await rm(path.join(this.store.directory, "assets", item.id), {
        recursive: true,
        force: true,
      });
      this.store.cleaned(item);
    }
  }
  async tick() {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      await this.cleanup();
      while (!this.stopped && this.active.size < 2) {
        const job = this.store.claim(this.worker);
        if (!job) break;
        const controller = new AbortController();
        this.active.set(job.id, controller);
        this.activeItems.set(job.id, job.itemId);
        void this.capture(job, controller).finally(() => {
          this.active.delete(job.id);
          this.activeItems.delete(job.id);
          void this.tick();
        });
      }
    } catch (error) {
      process.stderr.write(`稍后读队列：${String(error)}\n`);
    } finally {
      this.ticking = false;
    }
  }
  async asset(owner: string, id: string, versionId: string, assetId: string) {
    const version = this.store.version(owner, id, versionId),
      asset = version?.assets.find((a) => a.id === assetId);
    if (!asset) throw new ReadLaterError("not_found", "图片不存在");
    if (
      asset.path !==
        `${asset.hash}.${IMAGE_ASSET_EXTENSIONS[asset.mediaType]}` ||
      !/^[a-f0-9]{64}$/.test(asset.hash)
    )
      throw new ReadLaterError("capture_failed", "图片清单完整性校验失败");
    const bytes = await readFile(
      path.join(this.store.directory, "assets", id, versionId, asset.path),
    );
    if (createHash("sha256").update(bytes).digest("hex") !== asset.hash)
      throw new ReadLaterError("capture_failed", "图片完整性校验失败");
    return { asset, bytes };
  }
  private async capture(job: CaptureJob, controller: AbortController) {
    const deadline = setTimeout(
        () => controller.abort(new Error("采集超过 90 秒，请稍后重试")),
        90000,
      ),
      heartbeat = setInterval(() => {
        if (!this.store.progress(job, "正在采集", 20))
          controller.abort(new Error("任务租约已失效"));
      }, 10000);
    const versionId = randomUUID(),
      directory = path.join(
        this.store.directory,
        "assets",
        job.itemId,
        versionId,
      );
    let committed = false;
    try {
      const item = this.store.get(job.ownerId, job.itemId);
      this.store.progress(job, "获取网页", 10);
      const response = await this.fetch(item.canonicalUrl, controller.signal);
      controller.signal.throwIfAborted();
      if (response.status < 200 || response.status >= 300) {
        this.store.complete(job, {
          error: `原站返回 HTTP ${response.status}，链接已保留`,
        });
        return;
      }
      const contentType = String(response.headers["content-type"] ?? "");
      if (
        !/^(text\/html|application\/xhtml\+xml|text\/plain)\b/i.test(
          contentType,
        )
      ) {
        this.store.complete(job, {
          error: "原站响应不是支持的网页或纯文本，链接已保留",
        });
        return;
      }
      const article = extractArticle(
          decodeArticle(response.body, contentType),
          response.url,
          contentType,
        ),
        metadata = {
          title: article.title,
          siteName: article.siteName,
          author: article.author,
          description: article.description,
          fetchedUrl: response.url,
        };
      if (article.warnings.some((w) => w.includes("不足 80"))) {
        this.store.complete(job, {
          metadata,
          error: article.warnings.join("；"),
        });
        return;
      }
      const assets: ArticleAsset[] = [],
        warnings = [...article.warnings],
        replacements = new Map<number, string>();
      this.store.progress(job, "归档正文与图片", 40);
      for (const [index, image] of article.images.entries()) {
        controller.signal.throwIfAborted();
        if (index >= 32 || assets.length >= 16) {
          warnings.push("已达到图片采集上限，剩余图片未保存");
          break;
        }
        try {
          const result = await this.fetch(image.url, controller.signal),
            declared = String(result.headers["content-type"] ?? "")
              .split(";")[0]!
              .trim()
              .toLowerCase(),
            actual = actualImageMediaType(result.body);
          if (
            result.status < 200 ||
            result.status >= 300 ||
            !actual ||
            declared !== actual ||
            result.body.length < 256 ||
            result.body.length > 5 * 1024 * 1024
          )
            throw new Error("图片响应、大小或类型无效");
          const hash = createHash("sha256").update(result.body).digest("hex"),
            existing = assets.find((a) => a.hash === hash);
          if (existing) {
            replacements.set(index, `assets/${existing.path}`);
            continue;
          }
          const filename = `${hash}.${IMAGE_ASSET_EXTENSIONS[actual]}`,
            asset: ArticleAsset = {
              id: randomUUID(),
              hash,
              mediaType: actual,
              byteSize: result.body.length,
              path: filename,
              sourceUrl: image.url,
              alt: image.alt,
              role: image.role,
            };
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await writeFile(path.join(directory, filename), result.body, {
            mode: 0o600,
            flag: "wx",
          });
          assets.push(asset);
          replacements.set(index, `assets/${filename}`);
        } catch (error) {
          controller.signal.throwIfAborted();
          warnings.push(
            `图片未保存：${image.url}（${error instanceof Error ? error.message : "请求失败"}）`,
          );
        }
      }
      const content = article.content.replace(
        /(!\[(?:\\.|[^\]\\])*\])\(read-later-image:(\d+)\)/g,
        (_match, label: string, index: string) =>
          replacements.has(Number(index))
            ? `${label}(${replacements.get(Number(index))})`
            : `${label.slice(1)}（图片未保存）`,
      );
      controller.signal.throwIfAborted();
      const version: ArticleVersion = {
        id: versionId,
        itemId: job.itemId,
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        assets,
        warnings,
        coverAssetId: assets.find((a) => a.role === "cover")?.id,
        capturedAt: new Date().toISOString(),
        extractorVersion: "teams-read-later/1",
      };
      committed = this.store.complete(job, { metadata, version });
    } catch (error) {
      if (!this.stopped)
        this.store.complete(job, {
          error: error instanceof Error ? error.message : "采集失败",
          failed: true,
        });
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      if (!committed)
        await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
}
