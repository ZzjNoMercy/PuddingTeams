"use client";

import { ArrowUpToLineIcon, Clock3Icon, LoaderCircleIcon, PaperclipIcon, XIcon } from "lucide-react";
import type { QueuedNativeInput } from "@/lib/types";

export function QueuedInputList({ items, canSteer, busyKey, onAction }: {
	items: readonly QueuedNativeInput[];
	canSteer: boolean;
	busyKey: string | null;
	onAction: (key: string, action: "steer" | "cancel") => void;
}) {
	if (!items.length) return null;
	return (
		<div className="home-queued-list" role="region" aria-label="待处理消息">
			{items.map((item) => {
				const busy = busyKey === item.key;
				const steering = item.delivery === "steer";
				return (
					<div key={item.key} className="home-queued-message" aria-busy={busy}>
						<div className="home-queued-header">
							<span className="home-queued-status" title="尚未进入对话历史">
								{busy ? <LoaderCircleIcon size={12} className="animate-spin" aria-hidden="true" /> : steering ? <ArrowUpToLineIcon size={12} aria-hidden="true" /> : <Clock3Icon size={12} aria-hidden="true" />}
								{busy ? "处理中…" : steering ? "等待引导" : "等待发送"}
							</span>
							<div className="home-queued-actions">
								{canSteer && !steering && !item.hasImages ? <button type="button" className="home-queued-action home-queued-steer" title="当前步骤结束后优先处理" disabled={busy} onClick={() => onAction(item.key, "steer")}><ArrowUpToLineIcon size={12} aria-hidden="true" />优先引导</button> : null}
								<button type="button" className="home-queued-action home-queued-remove" aria-label="删除排队消息" title="取消这条待发送消息" disabled={busy} onClick={() => onAction(item.key, "cancel")}><XIcon size={14} aria-hidden="true" /></button>
							</div>
						</div>
						{item.text ? <p className="home-queued-text">{item.text}</p> : null}
						{item.attachmentNames.length > 0 ? <p className="home-queued-attachments"><PaperclipIcon size={12} aria-hidden="true" /><span title={item.attachmentNames.join("、")}>{item.attachmentNames.join("、")}</span></p> : null}
					</div>
				);
			})}
		</div>
	);
}
