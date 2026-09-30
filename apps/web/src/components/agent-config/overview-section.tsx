"use client";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { AgentConfig } from "@/lib/types";
import type { ConfigDraft } from "@/components/agent-config/draft";
import { AvatarEditor } from "@/components/agents/form-parts";

/** 概览分区：头像 + 描述 + 责任边界（头像即传即生效，其余随页面级统一保存提交）。
 *  Manager（pinned）没有责任边界——那是写给 Manager 做路由判断的，Manager 自身用不到。 */
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
		<div>
			<section className="agent-config-card">
				<div className="agent-config-card-head"><h2>基本信息</h2><p>名称与描述会在会话和智能体选择器中展示。</p></div>
				<div className="agent-config-fields">
					<div className="agent-config-avatar">
						<AvatarEditor key={agent.name} agent={agent} onUpdated={onAgentUpdated} />
					</div>
					<label className="agent-config-field">
						<span>显示名称</span>
						<Input value={draft.displayName} onChange={(e) => onChange({ displayName: e.target.value })} placeholder={agent.name} maxLength={40} />
						<small>可随时改，最长 40 字符。</small>
					</label>
					<label className="agent-config-field">
						<span>描述</span>
						<Textarea value={draft.description} onChange={(e) => onChange({ description: e.target.value })} rows={3} />
						{agent.pinned ? null : <small>用于通用 UI 展示和 Manager 路由，不是该 Worker 的运行提示词。</small>}
					</label>
					{/* 原型的内部标识 / 角色是 disabled 输入框：真实控件才能被读屏念出、也能选中复制。 */}
					<div className="agent-config-columns">
						<label className="agent-config-field">
							<span>内部标识</span>
							<Input value={agent.name} readOnly disabled />
						</label>
						<label className="agent-config-field">
							<span>角色</span>
							<Input value={agent.pinned ? "Manager" : "Worker"} readOnly disabled />
						</label>
					</div>
					<small className="agent-config-hint">内部标识创建后不可改：委托工具名、URL 参数与存储键都使用它。</small>
				</div>
			</section>
			{agent.pinned ? null : (
				<section className="agent-config-card">
				<div className="agent-config-card-head"><h2>责任边界</h2><p>帮助 Manager 判断何时分配任务。</p></div>
				<div className="agent-config-fields">
					<div className="agent-config-columns">
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
					<small className="agent-config-hint">
						责任边界只提供给 Manager 做路由、停止与升级判断；不授予权限，也不会发给 Worker。
					</small>
					</div>
				</section>
			)}
		</div>
	);
}
