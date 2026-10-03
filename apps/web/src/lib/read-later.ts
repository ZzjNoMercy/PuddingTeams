import { SERVER_URL, KnowledgeApiError } from "./api";
export interface ReadingItem {
  id: string;
  originalUrl: string;
  canonicalUrl: string;
  fetchedUrl?: string;
  title: string;
  userTitle?: string;
  siteName: string;
  author: string;
  description: string;
  readingStatus: "unread" | "read" | "archived";
  parseStatus: "queued" | "processing" | "ready" | "link_only" | "failed";
  activeVersionId?: string;
  thumbnail?: { versionId: string; assetId: string; alt: string };
  latestJobId: string;
  tags: string[];
  note: string;
  errorMessage?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  fetchedAt?: string;
  readAt?: string;
}
export interface ReadingVersion {
  id: string;
  content: string;
  contentHash: string;
  assets: Array<{
    id: string;
    hash: string;
    mediaType: string;
    path: string;
    alt: string;
    role: string;
  }>;
  warnings: string[];
  capturedAt: string;
  extractorVersion: string;
  captureMethod: "http" | "saved_html";
  sourceFilename?: string;
}
export interface ReadingDetail {
  item: ReadingItem;
  version?: ReadingVersion;
  job: {
    id: string;
    status: string;
    step: string;
    progress: number;
    errorMessage?: string;
  };
  promotions: Array<{
    jobId?: string;
    bindingId: string;
    createdAt: string;
  }>;
}
export interface ReadingCaptureJob {
  id: string;
  itemId: string;
  title: string;
  source: string;
  itemAvailable: boolean;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  step: string;
  progress: number;
  errorMessage?: string;
  createdAt: string;
}
export interface ReadingCaptureJobPage {
  jobs: ReadingCaptureJob[];
  total: number;
  counts: { all: number; active: number; problem: number };
  page: number;
  pages: number;
  limit: number;
}
export interface ReadingList {
  items: ReadingItem[];
  total: number;
  counts: Record<string, number>;
  sources: string[];
  nextCursor: string | null;
}
export async function readingRequest<T>(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${SERVER_URL}/api/read-later${url}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok)
    throw new KnowledgeApiError(
      data.error ?? "稍后读请求失败",
      response.status,
      data.code,
    );
  return data as T;
}
export function readingAssetUrl(
  itemId: string,
  versionId: string,
  assetId: string,
) {
  return `${SERVER_URL}/api/read-later/${encodeURIComponent(itemId)}/versions/${encodeURIComponent(versionId)}/assets/${encodeURIComponent(assetId)}`;
}
