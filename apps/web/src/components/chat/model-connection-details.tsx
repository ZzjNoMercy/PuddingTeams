import type { ModelSummary } from "@/lib/types";

/** Configuration evidence only: provider identity must never be inferred from a model's display name. */
export function ModelConnectionDetails({ model, modelRef }: { model?: ModelSummary; modelRef?: string }) {
	if (!modelRef) return <div className="model-connection-details">尚未确认当前会话模型</div>;
	return <div className="model-connection-details">
		<strong>当前会话 · {model?.provider ?? modelRef.split("/")[0]}</strong>
		<code>{modelRef}</code>
		<span>配置端点</span>
		<code>{model?.baseUrl || "目录未提供端点"}</code>
		<small>模型选择仅作用于当前会话</small>
	</div>;
}
