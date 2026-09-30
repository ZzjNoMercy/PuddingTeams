import type { FastifyInstance } from "fastify";
import { localViewerIdentity } from "./identity.js";
import {
  ReadLaterError,
  presentItem,
  presentJob,
  type ReadLaterCreate,
  type ReadLaterUpdate,
} from "../read-later/contracts.js";
import type { ReadLaterStore } from "../read-later/store.js";
import type { ReadLaterCaptureService } from "../read-later/capture-service.js";
import type { ReadLaterPromoter, PromoteInput } from "../read-later/promote.js";
export function registerReadLaterRoutes(
  app: FastifyInstance,
  deps: {
    store: ReadLaterStore;
    capture: ReadLaterCaptureService;
    promoter: ReadLaterPromoter;
  },
) {
  const owner = () => localViewerIdentity().user.id;
  const error = (
    e: unknown,
    reply: {
      code: (n: number) => {
        send: (value: unknown) => unknown;
      };
    },
  ) =>
    reply
      .code(
        e instanceof ReadLaterError
          ? e.code === "not_found"
            ? 404
            : e.code === "conflict"
              ? 409
              : e.code === "invalid_input"
                ? 400
                : 422
          : 400,
      )
      .send({
        error: e instanceof Error ? e.message : "稍后读请求失败",
        code: e instanceof ReadLaterError ? e.code : undefined,
      });
  app.get("/api/read-later/jobs", async () => ({
    jobs: deps.store.listJobs(owner()).map(presentJob),
  }));
  app.get<{ Params: { id: string } }>(
    "/api/read-later/jobs/:id",
    async (req, reply) => {
      try {
        return { job: presentJob(deps.store.job(owner(), req.params.id)) };
      } catch (e) {
        return error(e, reply);
      }
    },
  );
  app.get<{
    Querystring: {
      q?: string;
      source?: string;
      filter?: string;
      cursor?: string;
      limit?: string;
    };
  }>("/api/read-later", async (req, reply) => {
    try {
      const result = deps.store.list(owner(), {
        ...req.query,
        limit: req.query.limit ? Number(req.query.limit) : 50,
      });
      return { ...result, items: result.items.map(presentItem) };
    } catch (e) {
      return error(e, reply);
    }
  });
  app.post<{
    Body: ReadLaterCreate;
  }>("/api/read-later", async (req, reply) => {
    try {
      if (!req.body) throw new ReadLaterError("invalid_input", "请输入链接");
      const result = deps.store.create(owner(), req.body);
      void deps.capture.tick();
      return reply.code(202).send({
        ...result,
        item: presentItem(result.item),
        job: presentJob(result.job),
      });
    } catch (e) {
      return error(e, reply);
    }
  });
  app.get<{
    Params: {
      id: string;
    };
  }>("/api/read-later/:id", async (req, reply) => {
    try {
      const item = deps.store.get(owner(), req.params.id);
      return {
        item: presentItem(item),
        version: deps.store.version(owner(), item.id),
        job: presentJob(deps.store.job(owner(), item.latestJobId)),
        promotions: deps.store
          .promotions(owner())
          .filter((p) => p.items.some((i) => i.id === item.id))
          .map(({ ownerId: _owner, requestHash: _hash, ...p }) => p),
      };
    } catch (e) {
      return error(e, reply);
    }
  });
  app.patch<{
    Params: {
      id: string;
    };
    Body: ReadLaterUpdate;
  }>("/api/read-later/:id", async (req, reply) => {
    try {
      if (!req.body) throw new ReadLaterError("invalid_input", "缺少更新字段");
      return {
        item: presentItem(deps.store.update(owner(), req.params.id, req.body)),
      };
    } catch (e) {
      return error(e, reply);
    }
  });
  app.delete<{
    Params: {
      id: string;
    };
    Body: {
      expectedRevision: number;
    };
  }>("/api/read-later/:id", async (req, reply) => {
    try {
      return await deps.capture.remove(
        owner(),
        req.params.id,
        req.body?.expectedRevision,
      );
    } catch (e) {
      return error(e, reply);
    }
  });
  app.post<{
    Params: {
      id: string;
    };
    Body: {
      operationId: string;
      expectedRevision: number;
    };
  }>("/api/read-later/:id/retry", async (req, reply) => {
    try {
      const result = deps.store.retry(
        owner(),
        req.params.id,
        req.body?.expectedRevision,
        req.body?.operationId,
      );
      void deps.capture.tick();
      return reply.code(202).send({
        ...result,
        item: presentItem(result.item),
        job: presentJob(result.job),
      });
    } catch (e) {
      return error(e, reply);
    }
  });
  app.get<{
    Params: {
      id: string;
      versionId: string;
      assetId: string;
    };
  }>(
    "/api/read-later/:id/versions/:versionId/assets/:assetId",
    async (req, reply) => {
      try {
        const { asset, bytes } = await deps.capture.asset(
          owner(),
          req.params.id,
          req.params.versionId,
          req.params.assetId,
        );
        reply
          .header("Cache-Control", "private, no-store")
          .header("X-Content-Type-Options", "nosniff");
        return reply.type(asset.mediaType).send(bytes);
      } catch (e) {
        return error(e, reply);
      }
    },
  );
  app.post<{
    Body: PromoteInput;
  }>("/api/read-later/promotions", async (req, reply) => {
    try {
      if (!req.body) throw new ReadLaterError("invalid_input", "缺少整理请求");
      const result = await deps.promoter.promote(owner(), req.body);
      return reply.code(202).send({
        jobId: result.job.id,
        status: result.job.status,
        bindingId: result.job.targetBindingId,
        replayed: result.replayed,
      });
    } catch (e) {
      return error(e, reply);
    }
  });
}
