"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { AgentConfig } from "@/lib/types";
import type { ConfigDraft } from "@/components/agent-config/draft";
import { AvatarEditor } from "@/components/agents/form-parts";

/** 概览分区：头像 + 描述 + 责任边界（头像即传即生效，其余随页面级统一保存提交）。 */
export function OverviewSection({
	agent,
	draft,
	onChange,
	onAgentUpdated,
}: {
	agent: AgentConfig;
	draft: ConfigDraft;
	onChange: (patch: Partial<ConfigDraft>) => void;
	onAgentUpdated: (agent: AgentConfig) => void;
}) {
	return (
		<div className="flex flex-col gap-3">
			<section className="agent-config-card">
				<div className="agent-config-card-head"><h2>基本信息</h2><p>描述用于聊天、成员信息以及 Manager 的角色识别。</p></div>
				<div className="agent-config-rows">
					<AvatarEditor agent={agent} onUpdated={onAgentUpdated} />
					<label className="agent-config-field">
						<span>描述</span>
						<Textarea value={draft.description} onChange={(e) => onChange({ description: e.target.value })} rows={3} />
						<small>用于通用 UI 展示和 Manager 路由，不是该 Worker 的运行提示词。</small>
					</label>
				</div>
			</section>
			<section className="agent-config-card">
				<div className="agent-config-card-head"><h2>责任边界</h2><p>帮助 Manager 判断何时自己处理、委派 Worker 或升级给用户。</p></div>
				<div className="agent-config-rows">
					<div className="grid gap-3 sm:grid-cols-2">
						<label className="agent-config-field">
							<span>身份定位（可选）</span>
							<Input value={draft.identity} onChange={(e) => onChange({ identity: e.target.value })} placeholder="如：前端实现负责人" />
						</label>
						<label className="agent-config-field">
							<span>责任领域</span>
							<Input value={draft.domain} onChange={(e) => onChange({ domain: e.target.value })} placeholder="如：Web 前端" />
						</label>
					</div>
					<label className="agent-config-field">
						<span>负责范围（每行一项）</span>
						<Textarea value={draft.owns} onChange={(e) => onChange({ owns: e.target.value })} rows={3} />
					</label>
					<label className="agent-config-field">
						<span>明确不负责（每行一项）</span>
						<Textarea value={draft.excludes} onChange={(e) => onChange({ excludes: e.target.value })} rows={3} />
					</label>
					<label className="agent-config-field">
						<span>升级给 Human/manager 的条件（每行一项）</span>
						<Textarea value={draft.escalateWhen} onChange={(e) => onChange({ escalateWhen: e.target.value })} rows={2} />
					</label>
					<p className="text-xs text-muted-foreground">
						责任边界只提供给 Manager 做路由、停止与升级判断；不授予权限，也不会发给 Worker。
					</p>
				</div>
			</section>
		</div>
	);
}
