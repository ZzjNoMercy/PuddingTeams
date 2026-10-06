import { SERVER_URL, KnowledgeApiError } from "./api";
export interface ContactSource { path: string; title: string; contentHash: string; anchor?: string }
export interface ContactAffiliation { org: ContactSource; role: string; status: "current" | "former" | null; startDate: string | null; endDate: string | null; source: ContactSource }
export interface ContactSummary { id: string; name: string; company: string; role: string; location: string; topics: string[]; groups: string[]; lastContact: string | null; source: ContactSource; affiliations: ContactAffiliation[]; avatar?: string }
export interface ContactRelation { kind: string; label: string; source: ContactSource; snippet: string; description: string; occurredAt: string | null }
export interface ContactDetail extends ContactSummary { email: string; phone: string; summary: string; relations: ContactRelation[] }
export interface ContactGraphEdge { id: string; from: string; to: string; label: string; doneCount: number; plannedCount: number; lastInteractionAt: string | null; directCount: number }
export interface ContactParticipant { id: string; name: string; isSelf?: boolean }
export interface ContactInteraction { id: string; title: string; status: "done" | "planned" | "cancelled" | "unknown"; occurredAt: string | null; location: string; kind: string; summary: string; participants: ContactParticipant[]; source: ContactSource }
export interface ContactDirectRelation { from: string; to: string; kind: string; label: string; source: ContactSource; snippet: string }
export interface ContactEdgeDetail { revision: number; edge: ContactGraphEdge; interactions: ContactInteraction[]; relations: ContactDirectRelation[]; total: number; nextOffset: number | null }
export interface ContactsList { vault: string; revision: number; total: number; matched: number; truncated: boolean; groups: string[]; warnings: string[]; people: ContactSummary[]; self?: { id: string }; edges?: ContactGraphEdge[] }
export async function contactsRequest<T>(url: string): Promise<T> {
 const response = await fetch(`${SERVER_URL}/api/contacts${url}`, { cache: "no-store" });
 const body = await response.json().catch(() => ({}));
 if (!response.ok) throw new KnowledgeApiError(body.error ?? "通讯录读取失败", response.status, body.code);
 return body as T;
}
export function contactAvatarUrl(vault: string, person: ContactSummary): string | undefined {
 return person.avatar ? `${SERVER_URL}/api/knowledge/${encodeURIComponent(vault)}/asset?path=${encodeURIComponent(person.avatar)}&v=${person.source.contentHash}` : undefined;
}
export interface ContactAvatarOption { id: string; label: string; category: string; hash: string }
export function builtinContactAvatarUrl(option: ContactAvatarOption): string {
 return `${SERVER_URL}/api/contacts/avatar-options/${encodeURIComponent(option.id)}/image?v=${option.hash}`;
}
export async function listContactAvatarOptions(): Promise<ContactAvatarOption[]> {
 return (await contactsRequest<{ options: ContactAvatarOption[] }>("/avatar-options")).options;
}
export async function saveContactAvatar(vault: string, person: ContactSummary, selection: { image: string | null } | { builtinId: string }): Promise<{ syncWarning?: string }> {
 const response = await fetch(`${SERVER_URL}/api/contacts/${encodeURIComponent(person.id)}/avatar?vault=${encodeURIComponent(vault)}`, {
  method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedHash: person.source.contentHash, ...selection }),
 });
 const body = await response.json().catch(() => ({}));
 if (!response.ok) throw new KnowledgeApiError(body.error ?? "头像保存失败", response.status, body.code);
 return body;
}
