"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { listChatNavigation, updateChatNavigation } from "@/lib/api";
import type { ChatNavigationIndex, ChatNavigationItem } from "@/lib/types";

export function useChatNavigation(refreshKey: unknown) {
 const [index, setIndex] = useState<ChatNavigationIndex>({ items: [], revision: 0 });
 const [ready, setReady] = useState(false);
 const [error, setError] = useState<string | null>(null);
 const [busyId, setBusyId] = useState<string | null>(null);
 const revision = useRef(0), request = useRef(0), busy = useRef(false), mounted = useRef(false);
 const refresh = useCallback(async () => {
  const id = ++request.current;
  try {
   const next = await listChatNavigation();
   if (!mounted.current || request.current !== id || next.revision < revision.current) return;
   revision.current = next.revision; setIndex(next); setError(null); setReady(true);
  } catch (caught) { if (mounted.current && request.current === id) { setError(caught instanceof Error ? caught.message : String(caught)); setReady(true); } }
 }, []);
 useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
 useEffect(() => { let cancelled = false; void Promise.resolve().then(() => { if (!cancelled) void refresh(); }); return () => { cancelled = true; }; }, [refresh, refreshKey]);
 const change = useCallback(async (item: ChatNavigationItem, patch: { pinned?: boolean; archived?: boolean }) => {
  if (busy.current) return;
  busy.current = true; setBusyId(item.sessionId); request.current++;
  try {
   const result = await updateChatNavigation(item.roomId, item.sessionId, patch);
   if (!mounted.current) return;
   if (result.revision >= revision.current) {
    revision.current = result.revision;
    setIndex(previous => ({ revision: result.revision, items: previous.items.map(current => current.sessionId === item.sessionId ? { ...current, ...result.flags } : current) }));
   } else await refresh();
   if (patch.archived !== undefined) toast.success(patch.archived ? "聊天已归档，可随时恢复" : "聊天已恢复");
  } catch (caught) { if (mounted.current) toast.error(caught instanceof Error ? caught.message : String(caught)); }
  finally { busy.current = false; if (mounted.current) setBusyId(null); }
 }, [refresh]);
 return { items: index.items, ready, error, busyId, refresh, change };
}

export type ChatNavigationState = ReturnType<typeof useChatNavigation>;
