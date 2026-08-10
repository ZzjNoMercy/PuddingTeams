"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { ConfigDraft } from "@/components/agent-config/draft";

/** 概览分区：描述 + 责任 Profile（随页面级统一保存提交）。 */
export function OverviewSection({
	draft,
	onChange,
}: {
	draft: ConfigDraft;
	onChange: (patch: Partial<ConfigDraft>) => void;
}) {
	return (
		<div className="flex flex-col gap-3">
			<label className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">描述（展示说明，不等于责任或授权）</span>
				<Textarea value={draft.description} onChange={(e) => onChange({ description: e.target.value })} rows={3} />
			</label>
			<div className="grid gap-2 rounded-md bg-muted/60 p-3 sm:grid-cols-2">
				<span className="text-sm font-medium sm:col-span-2">责任 Profile</span>
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">身份定位（可选）</span>
					<Input value={draft.identity} onChange={(e) => onChange({ identity: e.target.value })} placeholder="如：前端实现负责人" />
				</label>
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">责任领域</span>
					<Input value={draft.domain} onChange={(e) => onChange({ domain: e.target.value })} placeholder="如：Web 前端" />
				</label>
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">负责范围（每行一项）</span>
					<Textarea value={draft.owns} onChange={(e) => onChange({ owns: e.target.value })} rows={3} />
				</label>
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">明确不负责（每行一项）</span>
					<Textarea value={draft.excludes} onChange={(e) => onChange({ excludes: e.target.value })} rows={3} />
				</label>
				<label className="flex flex-col gap-1 text-sm sm:col-span-2">
					<span className="text-muted-foreground">升级给 Human/manager 的条件（每行一项）</span>
					<Textarea value={draft.escalateWhen} onChange={(e) => onChange({ escalateWhen: e.target.value })} rows={2} />
				</label>
				<p className="text-xs text-muted-foreground sm:col-span-2">
					责任 Profile 用于 manager 路由与停止边界，不证明技术能力，也不会授予任何运行权限。
				</p>
			</div>
		</div>
	);
}
