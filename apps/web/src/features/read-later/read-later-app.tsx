"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ClipboardSafeStreamdown as Streamdown } from "@/components/ai-elements/streamdown";
import { streamdownPlugins } from "@/core/streamdown/plugins";
import {
  ArrowLeft,
  Archive,
  Bookmark,
  Check,
  ExternalLink,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
  BookOpen,
  LoaderCircle,
  Newspaper,
} from "lucide-react";
import { SectionTopbar } from "@/components/section-topbar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getWikiCuratorJob,
  listKnowledgeBindings,
  type KnowledgeBindingSummary,
  type WikiCuratorJob,
} from "@/lib/api";
import {
  readingRequest,
  readingAssetUrl,
  type ReadingDetail,
  type ReadingItem,
  type ReadingList,
} from "@/lib/read-later";
import "./read-later.css";
const filters = [
  { id: "all", label: "收件箱" },
  { id: "unread", label: "未读" },
  { id: "read", label: "已读" },
  { id: "link_only", label: "仅链接" },
  { id: "pending", label: "待处理" },
  { id: "archived", label: "归档" },
];
const statusLabel = {
  queued: "排队中",
  processing: "采集中",
  ready: "正文就绪",
  link_only: "仅链接",
  failed: "采集失败",
};
const date = (value: string) =>
  new Date(value).toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
  });
const message = (error: unknown) =>
  error instanceof Error ? error.message : "请求失败，请重试";
const sourceLabel = (item: ReadingItem) => {
  try {
    return new URL(item.canonicalUrl).hostname.replace(/^www\./, "");
  } catch {
    return item.siteName;
  }
};
const parseTags = (value: string) =>
  [...new Set(value.split(/[,，;；]/).map((tag) => tag.trim()).filter(Boolean))];

function TagChips({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <span className="rl-tags" role="group" aria-label="文章标签">
      {tags.map((tag) => <span className="rl-tag" key={tag}>{tag}</span>)}
    </span>
  );
}

export function ReadLaterApp() {
  const router = useRouter(),
    params = useSearchParams(),
    filter = params.get("filter") ?? "all",
    source = params.get("source") ?? "",
    requested = params.get("item") ?? "";
  const [query, setQuery] = useState(params.get("q") ?? ""),
    [search, setSearch] = useState(query),
    [list, setList] = useState<ReadingList | null>(null),
    [detail, setDetail] = useState<ReadingDetail | null>(null),
    [loadError, setLoadError] = useState(""),
    [detailError, setDetailError] = useState(""),
    [actionError, setActionError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [saveTags, setSaveTags] = useState(""),
    [dialog, setDialog] = useState<
      "save" | "promote" | "delete" | "jobs" | null
    >(null),
    [focus, setFocus] = useState(false),
    [tab, setTab] = useState("body"),
    [selected, setSelected] = useState<Map<string, ReadingItem>>(new Map());
  const [bindings, setBindings] = useState<KnowledgeBindingSummary[]>([]),
    [bindingError, setBindingError] = useState(""),
    [job, setJob] = useState<WikiCuratorJob | null>(null),
    [jobError, setJobError] = useState("");
  const listEpoch = useRef(0),
    detailEpoch = useRef(0),
    saveOperation = useRef(crypto.randomUUID()),
    promotionOperation = useRef(crypto.randomUUID());
  const selectedId = requested || list?.items[0]?.id || "";
  const navigate = useCallback(
    (patch: Record<string, string>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(patch))
        if (value) next.set(key, value);
        else next.delete(key);
      router.replace(`/read-later${next.size ? `?${next}` : ""}`);
    },
    [params, router],
  );
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const reloadList = useCallback(
    async (cursor?: string) => {
      const epoch = ++listEpoch.current;
      try {
        const searchParams = new URLSearchParams({
          filter,
          q: search,
          source,
          ...(cursor ? { cursor } : {}),
        });
        const data = await readingRequest<ReadingList>(`?${searchParams}`);
        if (epoch !== listEpoch.current) return;
        setList((previous) =>
          cursor && previous
            ? { ...data, items: [...previous.items, ...data.items] }
            : data,
        );
        setLoadError("");
      } catch (error) {
        if (epoch === listEpoch.current) setLoadError(message(error));
      }
    },
    [filter, search, source],
  );
  const reloadDetail = useCallback(async () => {
    if (!selectedId) return;
    const epoch = ++detailEpoch.current;
    try {
      const data = await readingRequest<ReadingDetail>(`/${selectedId}`);
      if (epoch !== detailEpoch.current) return;
      setDetail(data);
      setDetailError("");
    } catch (error) {
      if (epoch === detailEpoch.current) {
        setDetail(null);
        setDetailError(message(error));
      }
    }
  }, [selectedId]);
  useEffect(() => {
    const timer = setTimeout(() => void reloadList(), 0);
    return () => clearTimeout(timer);
  }, [reloadList]);
  useEffect(() => {
    const timer = setTimeout(() => void reloadDetail(), 0);
    return () => clearTimeout(timer);
  }, [reloadDetail]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const capturing =
    list?.items.some((i) => ["queued", "processing"].includes(i.parseStatus)) ||
    ["queued", "running"].includes(detail?.job.status ?? "");
  useEffect(() => {
    if (!capturing) return;
    const timer = setInterval(() => {
      void reloadList();
      void reloadDetail();
    }, 2500);
    return () => clearInterval(timer);
  }, [capturing, reloadList, reloadDetail]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocus(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    const timer = setInterval(() => {
      void getWikiCuratorJob(job.id)
        .then((result) => {
          setJob(result.job);
          setJobError("");
        })
        .catch((error) => setJobError(message(error)));
    }, 2500);
    return () => clearInterval(timer);
  }, [job]);
  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setActionError("");
    try {
      await action();
      window.dispatchEvent(new Event("pudding-read-later-changed"));
      await Promise.all([reloadList(), reloadDetail()]);
      return true;
    } catch (error) {
      setActionError(message(error));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const current = detail?.item.id === selectedId ? detail : null;
  const update = (patch: Record<string, unknown>) =>
    current &&
    act(async () => {
      await readingRequest(`/${current.item.id}`, "PATCH", {
        expectedRevision: current.item.revision,
        ...patch,
      });
    });
  const promoteItems = selected.size
      ? [...selected.values()]
      : current
        ? [current.item]
        : [],
    readyItems = promoteItems.filter(
      (i) => i.parseStatus === "ready" && i.activeVersionId,
    );
  const openPromotion = () => {
    promotionOperation.current = crypto.randomUUID();
    setBindingError("");
    setActionError("");
    setDialog("promote");
    void listKnowledgeBindings()
      .then(setBindings)
      .catch((error) => setBindingError(message(error)));
  };
  const choose = (item: ReadingItem) => {
    navigate({ item: item.id });
    setTab("body");
    setActionError("");
  };
  return (
    <div className={`rl-app${focus ? " rl-focus" : ""}`}>
      {!focus && (
        <>
          <SectionTopbar title="稍后读" />
          <header className="rl-header">
            <div>
              <h1>稍后读</h1>
              <p>先收下值得读的内容，再慢慢消化。</p>
            </div>
            <div className="rl-actions">
              <button className="rl-button" onClick={() => setDialog("jobs")}>
                采集任务
              </button>
              <button
                className="rl-button"
                onClick={() => {
                  void reloadList();
                  void reloadDetail();
                }}
                title="刷新"
              >
                <RefreshCw size={14} />
              </button>
              <button
                className="rl-button rl-primary"
                onClick={() => {
                  saveOperation.current = crypto.randomUUID();
                  setSaveTags("");
                  setDialog("save");
                  setActionError("");
                }}
              >
                <Plus size={15} />
                收藏链接
              </button>
            </div>
          </header>
        </>
      )}
      {(actionError || notice) && (
        <div
          className={`rl-banner${actionError ? " rl-error" : ""}`}
          role={actionError ? "alert" : "status"}
        >
          {actionError || notice}
          <button
            aria-label="关闭提示"
            onClick={() => {
              setActionError("");
              setNotice("");
            }}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {job && (
        <div className="rl-banner">
          <BookOpen size={14} />
          <span>
            Wiki 整理：
            {job.status === "pending_review"
              ? "候选待审核"
              : job.status === "no_changes"
                ? "没有新候选"
                : job.status === "failed"
                  ? `失败 · ${job.failureCode ?? "请打开任务检查"}`
                  : job.status === "needs_attention"
                    ? "需要处理"
                    : job.status === "cancelled"
                      ? "已取消"
                      : "正在整理"}
          </span>
          {job.candidateBatchId ? (
            <Link
              href={`/knowledge/review?vault=${encodeURIComponent(job.targetBindingId)}&batch=${encodeURIComponent(job.candidateBatchId)}`}
            >
              查看候选
            </Link>
          ) : (
            <Link
              href={`/knowledge?vault=${encodeURIComponent(job.targetBindingId)}`}
            >
              查看知识库
            </Link>
          )}
          {jobError && <span className="rl-error">{jobError}</span>}
        </div>
      )}
      <div className={`rl-layout${requested ? " rl-show-detail" : ""}`}>
        {!focus && (
          <aside className="rl-inbox" aria-label="收藏列表">
            <div className="rl-list-head">
              <div className="rl-inbox-heading">
                <strong>我的收藏</strong>
                <span>{list?.counts.unread ?? 0} 篇未读</span>
              </div>
              <div className="rl-search">
                <Search size={14} />
                <input
                  aria-label="搜索收藏"
                  placeholder="搜索文章、标签或笔记"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query && (
                  <button aria-label="清空搜索" onClick={() => setQuery("")}>
                    <X size={13} />
                  </button>
                )}
              </div>
              <div className="rl-filters">
                {filters.map((f) => (
                  <button
                    key={f.id}
                    aria-pressed={filter === f.id}
                    onClick={() => {
                      setSelected(new Map());
                      navigate({ filter: f.id, item: "" });
                    }}
                  >
                    {f.label}
                    <span>{list?.counts[f.id] ?? 0}</span>
                  </button>
                ))}
              </div>
              <div className="rl-list-controls">
                <label>
                  <input
                    type="checkbox"
                    aria-label="选择当前列表"
                    checked={
                      !!list?.items.length &&
                      list.items.every((i) => selected.has(i.id))
                    }
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? new Map(list?.items.map((i) => [i.id, i]))
                          : new Map(),
                      )
                    }
                  />
                  全选
                </label>
                <select
                  aria-label="按来源筛选"
                  value={source}
                  onChange={(event) => {
                    setSelected(new Map());
                    navigate({ source: event.target.value, item: "" });
                  }}
                >
                  <option value="">全部来源</option>
                  {list?.sources.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="rl-list-scroll">
              {loadError ? (
                <div className="rl-empty rl-error" role="alert">
                  <p>{loadError}</p>
                  <button
                    className="rl-button"
                    onClick={() => void reloadList()}
                  >
                    重新加载
                  </button>
                </div>
              ) : !list ? (
                <div className="rl-empty">正在加载收藏…</div>
              ) : !list.items.length ? (
                <div className="rl-empty">
                  <Bookmark size={30} />
                  <h2>
                    {search || source
                      ? "没有匹配的收藏"
                      : filter === "all"
                        ? "留一篇，慢慢读"
                        : "这里还没有文章"}
                  </h2>
                  <p>
                    {search || source
                      ? "试试其他关键词或来源。"
                      : "收藏文章后，正文将在后台自动采集。"}
                  </p>
                  {search || source ? (
                    <button
                      className="rl-button"
                      onClick={() => {
                        setQuery("");
                        navigate({ source: "", filter: "all", item: "" });
                      }}
                    >
                      清空筛选
                    </button>
                  ) : (
                    <button
                      className="rl-button"
                      onClick={() => {
                        saveOperation.current = crypto.randomUUID();
                        setSaveTags("");
                        setDialog("save");
                      }}
                    >
                      收藏第一篇
                    </button>
                  )}
                </div>
              ) : (
                list.items.map((item) => (
                  <div
                    key={item.id}
                    className={`rl-row${selectedId === item.id ? " is-active" : ""}`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`选择 ${item.title}`}
                      checked={selected.has(item.id)}
                      onChange={(event) =>
                        setSelected((previous) => {
                          const next = new Map(previous);
                          if (event.target.checked) next.set(item.id, item);
                          else next.delete(item.id);
                          return next;
                        })
                      }
                    />
                    <button
                      className="rl-row-content"
                      onClick={() => choose(item)}
                    >
                      <div className="rl-row-heading">
                        <h2>
                          {item.readingStatus === "unread" && (
                            <i aria-label="未读" />
                          )}
                          {item.title}
                        </h2>
                        {item.thumbnail && (
                          <Image
                            className="rl-thumbnail"
                            src={readingAssetUrl(item.id, item.thumbnail.versionId, item.thumbnail.assetId)}
                            alt=""
                            width={56}
                            height={56}
                            unoptimized
                            loading="lazy"
                            decoding="async"
                          />
                        )}
                      </div>
                      <TagChips tags={item.tags} />
                      <div className="rl-row-footer">
                        <span className="rl-row-meta" title={`${sourceLabel(item)}${item.tags.length ? "" : " · 未分类"} · ${date(item.createdAt)}`}>
                          <Newspaper size={12} aria-hidden="true" />
                          <span>{sourceLabel(item)}{item.tags.length ? "" : " · 未分类"} · {date(item.createdAt)}</span>
                        </span>
                        <span
                          className={item.parseStatus === "ready" ? "sr-only" : `rl-status status-${item.parseStatus}`}
                        >
                          {statusLabel[item.parseStatus]}
                        </span>
                      </div>
                    </button>
                  </div>
                ))
              )}
              {list?.nextCursor && (
                <button
                  className="rl-more"
                  onClick={() => void reloadList(list.nextCursor!)}
                >
                  加载更多（已显示 {list.items.length} / {list.total}）
                </button>
              )}
            </div>
            {selected.size > 0 && (
              <div className="rl-selection">
                <span>已选 {selected.size} 篇</span>
                <button
                  className="rl-button rl-primary"
                  disabled={!readyItems.length}
                  onClick={openPromotion}
                >
                  整理 {readyItems.length} 篇
                </button>
                <button
                  aria-label="取消选择"
                  onClick={() => setSelected(new Map())}
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </aside>
        )}
        <section className="rl-reader" aria-label="文章阅读器">
          <div className="rl-reader-toolbar">
            <button
              className="rl-mobile-back rl-button"
              onClick={() => navigate({ item: "" })}
            >
              <ArrowLeft size={14} />
              返回
            </button>
            <div className="rl-tabs">
              {[
                { id: "body", label: "正文" },
                { id: "info", label: "信息" },
                { id: "notes", label: "我的笔记" },
              ].map((t) => (
                <button
                  key={t.id}
                  aria-pressed={tab === t.id}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="rl-actions">
              {current && (
                <a
                  className="rl-icon"
                  href={current.item.originalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="打开原文"
                  aria-label="打开原文"
                >
                  <ExternalLink size={15} />
                </a>
              )}
              <button
                className="rl-icon"
                title={focus ? "退出专注模式" : "专注阅读"}
                aria-label={focus ? "退出专注模式" : "专注阅读"}
                onClick={() => setFocus((value) => !value)}
              >
                {focus ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
              </button>
            </div>
          </div>
          <div className="rl-reader-scroll">
            {detailError ? (
              <div className="rl-empty rl-error" role="alert">
                <p>{detailError}</p>
                <button
                  className="rl-button"
                  onClick={() => void reloadDetail()}
                >
                  重试加载
                </button>
              </div>
            ) : !current ? (
              <div className="rl-empty">
                <BookOpen size={30} />
                <p>{selectedId ? "正在加载文章…" : "选择一篇文章，开始阅读"}</p>
              </div>
            ) : tab === "notes" ? (
              <NotesEditor
                key={current.item.id}
                item={current.item}
                busy={busy}
                onSave={(note) => update({ note })}
              />
            ) : tab === "info" ? (
              <MetadataEditor
                key={current.item.id}
                detail={current}
                busy={busy}
                onSave={(patch) => update(patch)}
              />
            ) : (
              <article className="rl-article">
                <div className="rl-eyebrow">
                  {current.item.siteName} ·{" "}
                  {current.item.author || "作者未标注"} ·{" "}
                  {date(current.item.createdAt)}
                </div>
                <h1>{current.item.title}</h1>
                <TagChips tags={current.item.tags} />
                <div className="rl-article-meta">
                  <span
                    className={`rl-status status-${current.item.parseStatus}`}
                  >
                    {statusLabel[current.item.parseStatus]}
                  </span>
                  {current.version && (
                    <span>
                      {current.version.assets.length} 张本地图片 ·{" "}
                      {Math.max(
                        1,
                        Math.ceil(current.version.content.length / 700),
                      )}{" "}
                      分钟阅读
                    </span>
                  )}
                </div>
                {current.item.errorMessage && (
                  <div className="rl-warning">{current.item.errorMessage}</div>
                )}
                {current.version ? (
                  <>
                    <div className="rl-prose">
                      <Streamdown
                        {...streamdownPlugins}
                        isAnimating={false}
                        components={{
                          img: ({
                            src,
                            alt,
                          }:
                            | ComponentProps<"img">
                            | Record<string, unknown>) => {
                            const asset =
                              typeof src === "string"
                                ? current.version!.assets.find(
                                    (a) => src === `assets/${a.path}`,
                                  )
                                : undefined;
                            return asset ? (
                              <LocalImage
                                src={readingAssetUrl(
                                  current.item.id,
                                  current.version!.id,
                                  asset.id,
                                )}
                                alt={typeof alt === "string" ? alt : asset.alt}
                                cover={asset.role === "cover"}
                              />
                            ) : (
                              <span className="rl-warning">[图片未保存]</span>
                            );
                          },
                          a: ({
                            href,
                            children,
                          }: ComponentProps<"a"> | Record<string, unknown>) => {
                            let safe = false;
                            try {
                              safe = ["https:", "http:", "mailto:"].includes(
                                new URL(typeof href === "string" ? href : "")
                                  .protocol,
                              );
                            } catch {}
                            return safe ? (
                              <a
                                href={String(href)}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {children as ReactNode}
                              </a>
                            ) : (
                              <span>{children as ReactNode}</span>
                            );
                          },
                        }}
                      >
                        {current.version.content}
                      </Streamdown>
                    </div>
                    {current.version.warnings.length > 0 && (
                      <details className="rl-warning">
                        <summary>
                          采集提示（{current.version.warnings.length}）
                        </summary>
                        {current.version.warnings.map((warning, index) => (
                          <p key={index}>{warning}</p>
                        ))}
                      </details>
                    )}
                  </>
                ) : (
                  <div className="rl-unavailable">
                    {["queued", "processing"].includes(
                      current.item.parseStatus,
                    ) ? (
                      <>
                        <LoaderCircle className="animate-spin" size={24} />
                        <h2>正在为你保存正文</h2>
                        <p>{current.job.step}</p>
                        <progress max={100} value={current.job.progress} />
                      </>
                    ) : (
                      <>
                        <Bookmark size={24} />
                        <h2>链接已保存，正文暂不可用</h2>
                        <p>可以打开原文阅读，或稍后重新采集。</p>
                      </>
                    )}
                  </div>
                )}
              </article>
            )}
          </div>
          {current && (
            <footer className="rl-reader-footer">
              <div className="rl-actions">
                <button
                  disabled={busy}
                  className="rl-button"
                  onClick={() =>
                    update({
                      readingStatus:
                        current.item.readingStatus === "read"
                          ? "unread"
                          : "read",
                    })
                  }
                >
                  <Check size={14} />
                  {current.item.readingStatus === "read"
                    ? "标为未读"
                    : "标为已读"}
                </button>
                <button
                  disabled={busy}
                  className="rl-button"
                  onClick={() =>
                    update({
                      readingStatus:
                        current.item.readingStatus === "archived"
                          ? "unread"
                          : "archived",
                    })
                  }
                >
                  <Archive size={14} />
                  {current.item.readingStatus === "archived" ? "恢复" : "归档"}
                </button>
                <button
                  className="rl-icon"
                  aria-label="重新采集"
                  title="重新采集"
                  disabled={
                    busy ||
                    ["queued", "processing"].includes(current.item.parseStatus)
                  }
                  onClick={() =>
                    void act(async () => {
                      await readingRequest(
                        `/${current.item.id}/retry`,
                        "POST",
                        {
                          operationId: crypto.randomUUID(),
                          expectedRevision: current.item.revision,
                        },
                      );
                    })
                  }
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  className="rl-icon"
                  aria-label="删除收藏"
                  title="删除收藏"
                  onClick={() => {
                    setActionError("");
                    setDialog("delete");
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              <button
                className="rl-button rl-primary"
                disabled={current.item.parseStatus !== "ready"}
                onClick={() => {
                  setSelected(new Map());
                  openPromotion();
                }}
              >
                <BookOpen size={14} />
                整理到知识库
              </button>
            </footer>
          )}
        </section>
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setDialog(null);
            setActionError("");
          }
        }}
      >
        <DialogContent className="rl-dialog">
          <DialogHeader>
            <DialogTitle>
              {dialog === "save"
                ? "留到稍后读"
                : dialog === "delete"
                  ? "删除这篇收藏？"
                  : dialog === "jobs"
                    ? "采集任务"
                    : "整理到知识库"}
            </DialogTitle>
            <DialogDescription>
              {dialog === "save"
                ? "贴入文章链接，正文和图片会在后台保存。"
                : dialog === "delete"
                  ? "将删除这篇收藏的正文与图片，终止采集。已经冻结的整理来源和 Wiki 内容会保留。"
                  : dialog === "jobs"
                    ? "后台采集会持久保存；失败后可以回到文章重新采集。"
                    : "正文将交给 Wiki 管理员整理，候选需要审核后才会发布。"}
            </DialogDescription>
          </DialogHeader>
          {actionError && (
            <p className="rl-error" role="alert">
              {actionError}
            </p>
          )}
          {dialog === "jobs" && (
            <CaptureTasks
              onOpenItem={(id) => {
                setDialog(null);
                navigate({ item: id });
              }}
            />
          )}
          {dialog === "save" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                void act(async () => {
                  const result = await readingRequest<{
                    item: ReadingItem;
                    duplicate: boolean;
                  }>("", "POST", {
                    operationId: saveOperation.current,
                    url: String(data.get("url")),
                    title: String(data.get("title")) || undefined,
                    tags: parseTags(String(data.get("tags"))),
                    note: String(data.get("note")),
                  });
                  setDialog(null);
                  navigate({ item: result.item.id, filter: "all", source: "" });
                  setNotice(
                    result.duplicate
                      ? "已定位到现有收藏，原有笔记保持不变"
                      : "链接已收藏，正在后台采集",
                  );
                });
              }}
            >
              <label>
                文章链接
                <input
                  name="url"
                  type="url"
                  required
                  autoFocus
                  placeholder="https://…"
                  maxLength={1800}
                />
              </label>
              <label>
                标题 <small>可选</small>
                <input
                  name="title"
                  maxLength={300}
                  placeholder="默认使用原文标题"
                />
              </label>
              <label>
                标签 <small>用逗号或分号分隔（中英文均可）</small>
                <input name="tags" placeholder="人工智能; 论文原文" value={saveTags} onChange={(event) => setSaveTags(event.target.value)} />
                <TagChips tags={parseTags(saveTags)} />
              </label>
              <label>
                收藏时的想法 <small>可选</small>
                <textarea
                  name="note"
                  maxLength={10000}
                  placeholder="为什么想读这篇？"
                />
              </label>
              <div className="rl-dialog-footer">
                <button
                  type="button"
                  className="rl-button"
                  disabled={busy}
                  onClick={() => setDialog(null)}
                >
                  取消
                </button>
                <button className="rl-button rl-primary" disabled={busy}>
                  {busy ? "正在收藏…" : "收藏链接"}
                </button>
              </div>
            </form>
          )}
          {dialog === "delete" && (
            <div className="rl-dialog-footer">
              <button
                className="rl-button"
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                保留
              </button>
              <button
                className="rl-button rl-danger"
                disabled={busy || !current}
                onClick={() =>
                  current &&
                  void act(async () => {
                    const deletion = await readingRequest<{
                      cleanupPending?: boolean;
                    }>(`/${current.item.id}`, "DELETE", {
                      expectedRevision: current.item.revision,
                    });
                    setSelected((previous) => {
                      const next = new Map(previous);
                      next.delete(current.item.id);
                      return next;
                    });
                    setDialog(null);
                    navigate({ item: "" });
                    setNotice(
                      deletion.cleanupPending
                        ? "收藏已删除，图片清理将在后台重试"
                        : "收藏已删除",
                    );
                  })
                }
              >
                删除收藏
              </button>
            </div>
          )}
          {dialog === "promote" && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                void act(async () => {
                  const result = await readingRequest<{
                    jobId: string;
                  }>("/promotions", "POST", {
                    operationId: promotionOperation.current,
                    items: readyItems.map((i) => ({
                      id: i.id,
                      versionId: i.activeVersionId,
                    })),
                    bindingId: String(data.get("binding")),
                    task: String(data.get("task")),
                    includeNotes: data.has("notes"),
                  });
                  const next = await getWikiCuratorJob(result.jobId);
                  setJob(next.job);
                  setDialog(null);
                  setSelected(new Map());
                  setNotice("已冻结文章来源并启动整理，完成后可查看候选");
                });
              }}
            >
              <div className="rl-picked">
                {readyItems.map((i) => (
                  <p key={i.id}>
                    <Check size={13} />
                    {i.title}
                  </p>
                ))}
                {promoteItems.length > readyItems.length && (
                  <p className="rl-error">
                    将跳过 {promoteItems.length - readyItems.length}{" "}
                    篇正文未就绪的收藏
                  </p>
                )}
              </div>
              {bindingError ? (
                <p role="alert" className="rl-error">
                  {bindingError}
                  <button
                    type="button"
                    onClick={() =>
                      void listKnowledgeBindings()
                        .then(setBindings)
                        .then(() => setBindingError(""))
                        .catch((error) => setBindingError(message(error)))
                    }
                  >
                    重试
                  </button>
                </p>
              ) : (
                <label>
                  目标知识库
                  <select name="binding" required defaultValue="">
                    <option value="" disabled>
                      选择目标知识库
                    </option>
                    {bindings.map((b) => (
                      <option
                        key={b.id}
                        value={b.id}
                        disabled={b.availability !== "available"}
                      >
                        {b.name}
                        {b.availability !== "available" ? "（不可用）" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!bindings.length && (
                <p>
                  <Link href="/knowledge">先接入一个知识库</Link>
                </p>
              )}
              <label>
                整理要求
                <textarea
                  name="task"
                  required
                  defaultValue="保留原文事实、关键论点和出处，按知识库已有结构整理；不要把不确定内容写成事实。"
                  maxLength={15000}
                />
              </label>
              <label className="rl-check">
                <input name="notes" type="checkbox" />
                附带我的笔记（与原文分开）
              </label>
              <div className="rl-dialog-footer">
                <button
                  type="button"
                  className="rl-button"
                  disabled={busy}
                  onClick={() => setDialog(null)}
                >
                  取消
                </button>
                <button
                  className="rl-button rl-primary"
                  disabled={
                    busy ||
                    !readyItems.length ||
                    !bindings.some((b) => b.availability === "available")
                  }
                >
                  {busy ? "正在创建任务…" : "开始整理"}
                </button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
function NotesEditor({
  item,
  busy,
  onSave,
}: {
  item: ReadingItem;
  busy: boolean;
  onSave: (note: string) => unknown;
}) {
  const [note, setNote] = useState(item.note),
    [saved, setSaved] = useState(item.note);
  return (
    <div className="rl-editor">
      <h2>我的笔记</h2>
      <p>记录你的想法。整理时可选择是否附带，默认独立保留。</p>
      <textarea
        aria-label="我的笔记"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={10000}
      />
      <button
        className="rl-button rl-primary"
        disabled={busy || note === saved}
        onClick={async () => {
          if (await onSave(note)) setSaved(note);
        }}
      >
        保存笔记
      </button>
    </div>
  );
}
function MetadataEditor({
  detail,
  busy,
  onSave,
}: {
  detail: ReadingDetail;
  busy: boolean;
  onSave: (patch: Record<string, unknown>) => unknown;
}) {
  const [title, setTitle] = useState(detail.item.title),
    [tags, setTags] = useState(detail.item.tags.join(", "));
  return (
    <div className="rl-editor">
      <h2>文章信息</h2>
      <label>
        标题
        <input
          value={title}
          maxLength={300}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        标签 <small>用逗号或分号分隔（中英文均可）</small>
        <input value={tags} placeholder="人工智能; 论文原文" onChange={(e) => setTags(e.target.value)} />
        <TagChips tags={parseTags(tags)} />
      </label>
      <button
        disabled={busy}
        className="rl-button rl-primary"
        onClick={() =>
          onSave({
            title,
            tags: parseTags(tags),
          })
        }
      >
        保存信息
      </button>
      <dl>
        <dt>原始链接</dt>
        <dd>
          <a
            href={detail.item.originalUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {detail.item.originalUrl}
          </a>
        </dd>
        <dt>作者 / 来源</dt>
        <dd>
          {detail.item.author || "未标注"} / {detail.item.siteName}
        </dd>
        <dt>收藏时间</dt>
        <dd>{new Date(detail.item.createdAt).toLocaleString("zh-CN")}</dd>
        <dt>正文采集时间</dt>
        <dd>
          {detail.version
            ? new Date(detail.version.capturedAt).toLocaleString("zh-CN")
            : "尚未采集"}
        </dd>
        <dt>本地图片</dt>
        <dd>{detail.version?.assets.length ?? 0} 张</dd>
        <dt>采集任务</dt>
        <dd>
          {detail.job.step} · {detail.job.status}
        </dd>
      </dl>
      {detail.promotions.length > 0 && (
        <>
          <h3>关联整理任务</h3>
          {detail.promotions.map((p, index) => (
            <PromotionLink
              key={p.jobId ?? index}
              jobId={p.jobId}
              bindingId={p.bindingId}
            />
          ))}
        </>
      )}
    </div>
  );
}
function PromotionLink({
  jobId,
  bindingId,
}: {
  jobId?: string;
  bindingId: string;
}) {
  const [job, setJob] = useState<WikiCuratorJob | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    if (jobId)
      void getWikiCuratorJob(jobId)
        .then((data) => {
          if (active) setJob(data.job);
        })
        .catch((e) => {
          if (active) setError(message(e));
        });
    return () => {
      active = false;
    };
  }, [jobId]);
  return (
    <p>
      {error || job?.status || "读取任务中"} ·{" "}
      <Link
        href={
          job?.candidateBatchId
            ? `/knowledge/review?vault=${encodeURIComponent(bindingId)}&batch=${encodeURIComponent(job.candidateBatchId)}`
            : `/knowledge?vault=${encodeURIComponent(bindingId)}`
        }
      >
        {job?.candidateBatchId ? "查看候选" : "查看知识库"}
      </Link>
    </p>
  );
}
function LocalImage({
  src,
  alt,
  cover,
}: {
  src: string;
  alt: string;
  cover?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span className="rl-warning">图片读取失败：{alt}</span>
  ) : (
    // eslint-disable-next-line @next/next/no-img-element -- Authenticated local immutable capture asset.
    <img
      className={cover ? "rl-cover" : undefined}
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
function CaptureTasks({ onOpenItem }: { onOpenItem: (id: string) => void }) {
  const [jobs, setJobs] = useState<
      Array<{
        id: string;
        itemId: string;
        status: string;
        step: string;
        progress: number;
        errorMessage?: string;
        createdAt: string;
      }>
    >([]),
    [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const data = await readingRequest<{ jobs: typeof jobs }>("/jobs");
      setJobs(data.jobs);
      setError("");
    } catch (e) {
      setError(message(e));
    }
  }, []);
  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0),
      timer = setInterval(() => void refresh(), 3000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refresh]);
  return (
    <div className="rl-capture-tasks">
      {error && (
        <p className="rl-error" role="alert">
          {error}
          <button onClick={() => void refresh()}>重试</button>
        </p>
      )}
      {!jobs.length && !error && <p>暂无采集任务</p>}
      {jobs.map((job) => (
        <div className="rl-task" key={job.id}>
          <div>
            <strong>{job.step}</strong>
            <span>
              {date(job.createdAt)} · {job.status}
            </span>
          </div>
          {["queued", "running"].includes(job.status) && (
            <progress max={100} value={job.progress} />
          )}{" "}
          {job.errorMessage && <p className="rl-error">{job.errorMessage}</p>}
          <button className="rl-button" onClick={() => onOpenItem(job.itemId)}>
            查看收藏
          </button>
        </div>
      ))}
    </div>
  );
}
