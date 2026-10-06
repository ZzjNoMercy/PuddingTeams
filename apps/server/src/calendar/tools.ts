import { Type } from "typebox";
import { defineTool, type InlineExtension, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CalendarService } from "./service.js";

const person = Type.Object({ bindingId: Type.String(), personId: Type.String() });
const event = Type.Object({ title: Type.String(), description: Type.Optional(Type.String()), location: Type.Optional(Type.String()), kind: Type.Union([Type.Literal("event"), Type.Literal("focus")]), busy: Type.Boolean(), timeZone: Type.String(), allDay: Type.Boolean(), start: Type.Optional(Type.String()), end: Type.Optional(Type.String()), startDate: Type.Optional(Type.String()), endDateExclusive: Type.Optional(Type.String()), participants: Type.Optional(Type.Array(person)), interaction: Type.Optional(Type.Object({ bindingId: Type.String(), kind: Type.Union(["in_person", "call", "message", "email", "meal", "event", "other"].map(v => Type.Literal(v))) })) });
export interface CalendarToolScope { ownerId: string; bindingIds: string[]; assertCurrent: () => Promise<void> }
export function calendarTools(service: CalendarService, scope: () => Promise<CalendarToolScope>): ToolDefinition[] {
 const wrap = async (action: (s: CalendarToolScope) => Promise<unknown>) => {
  const s = await scope(); await s.assertCurrent(); const result = await action(s); await s.assertCurrent();
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
 };
 return [
  defineTool({ name: "calendar_find_people", label: "选择日程参与人", description: "从本轮已挂载的人脉库按姓名或公司查找已有联系人。返回稳定 personId/bindingId，不创建新人物、不推断同名身份。", parameters: Type.Object({ query: Type.String(), bindingId: Type.Optional(Type.String()) }), execute: async (_id,args) => wrap(s => service.people(s.ownerId,args.query,args.bindingId,s.bindingIds)) }),
  defineTool({ name: "calendar_list_events", label: "查看日程", description: "查看平台本地日程和往来审核状态。不会发送邀请或创建提醒。", parameters: Type.Object({}), execute: async () => wrap(async s => ({ events: await service.list(s.ownerId,s.bindingIds) })) }),
  defineTool({ name: "calendar_get_event", label: "查询日程详情", description: "获取当前日程版本、参与人引用和往来发布状态；更新前先读当前 revision。", parameters: Type.Object({ eventId: Type.String() }), execute: async (_id,args) => wrap(async s => ({ event: await service.get(s.ownerId,args.eventId,s.bindingIds) })) }),
  defineTool({ name: "calendar_create_event", label: "创建日程", description: "用户要求安排时创建平台本地日程。operationId 同一请求重试必须复用。参与人先查找；可选 interaction 生成同库往来候选，等待用户审核，不能称已入库。没有邀请或后台提醒。", parameters: Type.Object({ operationId: Type.String(), event }), execute: async (_id,args) => wrap(async s => { const value = await service.mutate(s.ownerId,"create",undefined,args.operationId,0,args.event,s.bindingIds,s.assertCurrent); return { event: value, eventUrl: `/calendar?event=${encodeURIComponent(value.id)}` }; }) }),
  defineTool({ name: "calendar_update_event", label: "调整日程", description: "按完整日程与 expectedRevision 调整安排，保留已有参与人和 interaction。改期生成同一往来页的新候选，旧候选不能发布；不把计划认定为已发生。", parameters: Type.Object({ eventId: Type.String(), operationId: Type.String(), expectedRevision: Type.Integer(), event }), execute: async (_id,args) => wrap(async s => ({ event: await service.mutate(s.ownerId,"update",args.eventId,args.operationId,args.expectedRevision,args.event,s.bindingIds,s.assertCurrent) })) }),
  defineTool({ name: "calendar_cancel_event", label: "取消日程", description: "用户要求取消时按当前 revision 取消本地日程；取消后日程保留在日历中可见，关联 wiki 往来状态直接同步为已取消，不再生成待审核候选；保留历史，不删除人物页。", parameters: Type.Object({ eventId: Type.String(), operationId: Type.String(), expectedRevision: Type.Integer() }), execute: async (_id,args) => wrap(async s => ({ event: await service.mutate(s.ownerId,"cancel",args.eventId,args.operationId,args.expectedRevision,undefined,s.bindingIds,s.assertCurrent) })) }),
  defineTool({ name: "calendar_set_event_status", label: "标记日程状态", description: "把日程在 confirmed（计划中）/ done（已完成）/ cancelled（已取消）之间切换，立即生效、不生成审核候选；关联 wiki 往来同步为 planned/done/cancelled。恢复计划用 confirmed；取消也可用 calendar_cancel_event。operationId 同一请求重试必须复用。", parameters: Type.Object({ eventId: Type.String(), operationId: Type.String(), expectedRevision: Type.Integer(), status: Type.Union([Type.Literal("confirmed"), Type.Literal("done"), Type.Literal("cancelled")]) }), execute: async (_id,args) => wrap(async s => ({ event: await service.setStatus(s.ownerId,args.eventId,args.operationId,args.expectedRevision,args.status,{scope:s.bindingIds,guard:s.assertCurrent}) })) }),
  defineTool({ name: "calendar_retry_interaction", label: "重试往来同步", description: "重试日程已经保存、往来候选生成失败的关联。幂等，不重新创建日程、不调用模型；已被独立编辑的页面保留原文。", parameters: Type.Object({ eventId: Type.String() }), execute: async (_id,args) => wrap(async s => ({ event: await service.retry(s.ownerId,args.eventId,s.bindingIds,s.assertCurrent) })) }),
 ];
}
export function calendarExtension(service: CalendarService, scope: () => Promise<CalendarToolScope>): InlineExtension {
 return async pi => { for (const tool of calendarTools(service,scope)) pi.registerTool(tool); };
}
