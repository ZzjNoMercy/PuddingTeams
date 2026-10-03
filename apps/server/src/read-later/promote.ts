import { createHash } from "node:crypto";
import {
  ReadLaterError,
  cleanText,
  operationId,
  type Promotion,
} from "./contracts.js";
import { digest, type ReadLaterStore } from "./store.js";
import type { ReadLaterCaptureService } from "./capture-service.js";
import type { KnowledgeSourceStore } from "../knowledge/sources.js";
import type { WikiCuratorService } from "../knowledge/curator-jobs.js";
import type { KnowledgeBindingRegistry } from "../knowledge/bindings.js";
import type { TeamsStore } from "../store/teams.js";
import { imageAssetPath } from "../knowledge/image-publication.js";
export interface PromoteInput {
  operationId: string;
  items: Array<{
    id: string;
    versionId: string;
  }>;
  bindingId: string;
  task: string;
  includeNotes?: boolean;
}
export class ReadLaterPromoter {
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    private deps: {
      store: ReadLaterStore;
      capture: ReadLaterCaptureService;
      sources: KnowledgeSourceStore;
      curator: WikiCuratorService;
      bindings: KnowledgeBindingRegistry;
      teams: TeamsStore;
    },
  ) {}
  async promote(ownerId: string, input: PromoteInput) {
    const op = operationId(input.operationId),
      key = `${ownerId}:${op}`;
    const previous = this.locks.get(key);
    if (previous) await previous.catch(() => {});
    const promise = this.run(ownerId, { ...input, operationId: op });
    this.locks.set(key, promise);
    try {
      return await promise;
    } finally {
      if (this.locks.get(key) === promise) this.locks.delete(key);
    }
  }
  private async run(ownerId: string, input: PromoteInput) {
    if (
      (input.includeNotes !== undefined &&
        typeof input.includeNotes !== "boolean")
    )
      throw new ReadLaterError(
        "invalid_input",
        "包含笔记选项必须是布尔值",
      );
    if (
      !Array.isArray(input.items) ||
      !input.items.length ||
      input.items.length > 50 ||
      input.items.some(
        (i) =>
          !i || typeof i.id !== "string" || typeof i.versionId !== "string",
      ) ||
      new Set(input.items.map((i) => i.id)).size !== input.items.length
    )
      throw new ReadLaterError("invalid_input", "请选择 1–50 条正文并提供版本");
    const task = cleanText(input.task, 15000, "整理要求");
    if (!task) throw new ReadLaterError("invalid_input", "请填写整理要求");
    const bindingId = cleanText(input.bindingId, 200, "目标知识库");
    const hash = digest({
        items: input.items,
        bindingId,
        task,
        includeNotes: !!input.includeNotes,
      }),
      old = this.deps.store.promotion(ownerId, input.operationId);
    if (old && old.requestHash !== hash)
      throw new ReadLaterError("conflict", "operationId 已用于不同整理请求");
    await this.deps.bindings.requireUsable(ownerId, bindingId);
    const agent = (await this.deps.teams.listAgents()).find(
      (a) =>
        a.builtinId === "wiki" &&
        a.enabled !== false &&
        a.connector?.connectorId === "pi" &&
        a.connector.transport === "sdk",
    );
    if (!agent) throw new ReadLaterError("unavailable", "请先启用 Wiki 管理员");
    let promotion: Promotion | undefined = old;
    if (!promotion) {
      // Validate the entire selection before freezing any source.
      const entries = input.items.map((ref) => {
        const item = this.deps.store.get(ownerId, ref.id),
          version = this.deps.store.version(ownerId, ref.id, ref.versionId);
        if (
          item.parseStatus !== "ready" ||
          item.activeVersionId !== ref.versionId ||
          !version
        )
          throw new ReadLaterError(
            "conflict",
            "部分正文未就绪或版本已变化，请刷新选择",
          );
        return { item, version };
      });
      const sourceIds: string[] = [];
      for (const { item, version } of entries) {
        const assets = await Promise.all(
          version.assets.map(async (asset) => ({
            ...asset,
            bytes: (
              await this.deps.capture.asset(
                ownerId,
                item.id,
                version.id,
                asset.id,
              )
            ).bytes,
          })),
        );
        let content = version.content;
        for (const asset of assets)
          content = content
            .split(`assets/${asset.path}`)
            .join(imageAssetPath(asset.hash, asset.mediaType));
        content = `# ${item.title.replace(/[\r\n]/g, " ")}\n\n原始链接：${item.originalUrl}\n\n作者：${item.author || "未标注"} · 来源：${item.siteName}\n\n采集时间：${version.capturedAt}\n\n${content}`;
        if (input.includeNotes && item.note)
          content += `\n\n---\n\n## 用户笔记（与原文分开）\n\n${item.note}`;
        const source = await this.deps.sources.createWebCapture(ownerId, {
          id: `read-later:${createHash("sha256").update(`${ownerId}:${input.operationId}:${item.id}`).digest("hex")}`,
          title: item.title,
          content,
          warnings: version.warnings,
          metadata: {
            itemId: item.id,
            versionId: version.id,
            originalUrl: item.originalUrl,
            canonicalUrl: item.canonicalUrl,
            fetchedUrl: item.fetchedUrl,
            author: item.author,
            siteName: item.siteName,
            capturedAt: version.capturedAt,
            extractorVersion: version.extractorVersion,
            contentHash: version.contentHash,
            captureMethod: version.captureMethod,
            sourceFilename: version.sourceFilename,
          },
          assets,
        });
        sourceIds.push(source.id);
      }
      promotion = this.deps.store.savePromotion({
        operationId: input.operationId,
        requestHash: hash,
        ownerId,
        items: input.items,
        sourceIds,
        bindingId,
        task,
        includeNotes: !!input.includeNotes,
        createdAt: new Date().toISOString(),
      });
    }
    const result = await this.deps.curator.create({
      ownerId,
      operationId: `read-later:${input.operationId}`,
      bindingId,
      agentId: agent.name,
      task: promotion.task,
      sourceIds: promotion.sourceIds,
    });
    promotion = this.deps.store.savePromotion({
      ...promotion,
      jobId: result.job.id,
    });
    return { promotion, job: result.job, replayed: !!old || result.replayed };
  }
}
