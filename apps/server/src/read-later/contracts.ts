export type ReadingStatus = "unread" | "read" | "archived";
export type ParseStatus =
  | "queued"
  | "processing"
  | "ready"
  | "link_only"
  | "failed";
export interface ReadLaterItem {
  id: string;
  ownerId: string;
  originalUrl: string;
  canonicalUrl: string;
  fetchedUrl?: string;
  title: string;
  userTitle?: string;
  extractedTitle?: string;
  siteName: string;
  author: string;
  description: string;
  readingStatus: ReadingStatus;
  parseStatus: ParseStatus;
  activeVersionId?: string;
  latestJobId: string;
  tags: string[];
  note: string;
  errorMessage?: string;
  revision: number;
  generation: number;
  createdAt: string;
  updatedAt: string;
  fetchedAt?: string;
  readAt?: string;
  deletedAt?: string;
  cleanupPending?: boolean;
}
export interface ArticleAsset {
  id: string;
  hash: string;
  mediaType: string;
  byteSize: number;
  path: string;
  sourceUrl: string;
  alt: string;
  role: "cover" | "body";
}
export interface ArticleVersion {
  id: string;
  itemId: string;
  content: string;
  contentHash: string;
  assets: ArticleAsset[];
  warnings: string[];
  coverAssetId?: string;
  capturedAt: string;
  extractorVersion: string;
  captureMethod: "http" | "saved_html";
  sourceFilename?: string;
}
export interface SavedHtmlInput {
  operationId: string;
  expectedRevision: number;
  filename: string;
  html: string;
  images?: Array<{ path: string; base64: string }>;
}
export interface CaptureJob {
  id: string;
  itemId: string;
  ownerId: string;
  generation: number;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  step: string;
  progress: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
}
export interface ReadLaterCreate {
  operationId: string;
  url: string;
  title?: string;
  note?: string;
  tags?: string[];
}
export interface ReadLaterUpdate {
  expectedRevision: number;
  title?: string;
  note?: string;
  tags?: string[];
  readingStatus?: ReadingStatus;
}
export interface Promotion {
  operationId: string;
  requestHash: string;
  ownerId: string;
  items: Array<{
    id: string;
    versionId: string;
  }>;
  sourceIds: string[];
  bindingId: string;
  task: string;
  includeNotes: boolean;
  jobId?: string;
  createdAt: string;
}
export type MarkReadInput =
  | { scope: "all" }
  | { scope: "selected"; items: Array<{ id: string; expectedRevision: number }> };
export class ReadLaterError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "not_found"
      | "conflict"
      | "capture_failed"
      | "unavailable",
    message: string,
  ) {
    super(message);
  }
}
export function cleanText(value: unknown, max: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000\u0008]/.test(value)
  )
    throw new ReadLaterError("invalid_input", `${label}格式或长度无效`);
  return value.trim();
}
export function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 30)
    throw new ReadLaterError("invalid_input", "最多 30 个标签");
  return [
    ...new Set(value.map((tag) => cleanText(tag, 100, "标签")).filter(Boolean)),
  ];
}
export function operationId(value: unknown): string {
  const id = cleanText(value, 200, "操作标识");
  if (!id) throw new ReadLaterError("invalid_input", "缺少 operationId");
  return id;
}
export function expectedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new ReadLaterError("invalid_input", "请重新读取收藏版本");
  return value as number;
}
export function presentItem<T extends ReadLaterItem>(item: T) {
  const {
    ownerId: _owner,
    generation: _generation,
    deletedAt: _deleted,
    cleanupPending: _cleanup,
    ...dto
  } = item;
  return dto;
}
export function presentJob(job: CaptureJob) {
  const {
    ownerId: _owner,
    generation: _generation,
    leaseOwner: _lease,
    leaseExpiresAt: _expires,
    ...dto
  } = job;
  return dto;
}
