import { SERVER_URL, KnowledgeApiError } from "./api";
export interface ContactSource { path: string; title: string; contentHash: string; anchor?: string }
export interface ContactAffiliation { org: ContactSource; role: string; status: "current" | "former" | null; startDate: string | null; endDate: string | null; source: ContactSource }
export interface ContactSummary { id: string; name: string; company: string; role: string; location: string; topics: string[]; groups: string[]; lastContact: string | null; source: ContactSource; affiliations: ContactAffiliation[] }
export interface ContactRelation { kind: string; label: string; source: ContactSource; snippet: string; description: string; occurredAt: string | null }
export interface ContactDetail extends ContactSummary { email: string; phone: string; summary: string; relations: ContactRelation[] }
export interface ContactGraphEdge { id: string; from: string; to: string; kind: string; label: string; source: ContactSource; snippet: string }
export interface ContactsList { vault: string; revision: number; total: number; matched: number; truncated: boolean; groups: string[]; warnings: string[]; people: ContactSummary[]; edges?: ContactGraphEdge[] }
export async function contactsRequest<T>(url: string): Promise<T> {
 const response = await fetch(`${SERVER_URL}/api/contacts${url}`, { cache: "no-store" });
 const body = await response.json().catch(() => ({}));
 if (!response.ok) throw new KnowledgeApiError(body.error ?? "通讯录读取失败", response.status, body.code);
 return body as T;
}
