import { BookOpenIcon, BrainIcon, FlaskConicalIcon, FolderKanbanIcon, UserRoundIcon, UsersIcon } from "lucide-react";
import type { KnowledgeBindingSummary } from "@/lib/api";

/** 知识库卡片与创建对话框共用的结构色调（对齐冻结原型色板）。 */
export type VaultTone = "teal" | "violet" | "blue" | "amber";

/** 色调按结构预置固定映射（个人助理/研究/项目/人脉），无结构声明一律 teal，不随机。 */
export const SCHEMA_TONES: Record<string, VaultTone> = {
	memory: "teal",
	"personal-assistant": "teal",
	research: "violet",
	project: "blue",
	people: "amber",
};

export function presetTone(schemaId: string): VaultTone {
	return SCHEMA_TONES[schemaId] ?? "teal";
}

export function vaultSchemaKey(binding: KnowledgeBindingSummary): string | null {
	return binding.schemaRef?.originPresetId ?? binding.schemaRef?.id ?? null;
}

export function vaultTone(binding: KnowledgeBindingSummary): VaultTone {
	const key = vaultSchemaKey(binding);
	return key ? presetTone(key) : "teal";
}

export function vaultIcon(binding: KnowledgeBindingSummary) {
	switch (vaultSchemaKey(binding)) {
		case "memory": return BrainIcon;
		case "personal-assistant": return UserRoundIcon;
		case "research": return FlaskConicalIcon;
		case "project": return FolderKanbanIcon;
		case "people": return UsersIcon;
		default: return BookOpenIcon;
	}
}
