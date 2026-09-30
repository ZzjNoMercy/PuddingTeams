import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { KnowledgeMountSurface } from "../knowledge/runtime-service.js";
import type { ReadLaterStore } from "./store.js";
import type { ReadLaterCaptureService } from "./capture-service.js";
export function withReadLater(
  surface: KnowledgeMountSurface,
  ownerId: string,
  store: ReadLaterStore,
  capture: ReadLaterCaptureService,
): KnowledgeMountSurface {
  const tool = defineTool({
    name: "read_later_save_url",
    label: "保存到稍后读",
    description:
      "仅在用户明确要求收藏/保存稍后读链接时使用。不得自行收藏搜索结果，不得编造标题或笔记。只保存链接并异步采集，不写入知识库、不触发整理。",
    parameters: Type.Object({
      url: Type.String(),
      title: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    execute: async (toolCallId, params) => {
      const result = store.create(ownerId, {
        ...params,
        operationId: `tool:${toolCallId}`,
      });
      void capture.tick();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              itemId: result.item.id,
              jobId: result.job.id,
              status: result.item.parseStatus,
              duplicate: result.duplicate,
              url: `/read-later?item=${result.item.id}`,
            }),
          },
        ],
        details: {},
      };
    },
  });
  return { ...surface, tools: [...surface.tools, tool] };
}
