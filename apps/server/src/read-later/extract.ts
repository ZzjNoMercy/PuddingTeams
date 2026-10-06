import { parse } from "parse5";
import { canonicalizeUrl } from "./public-fetch.js";
interface Node {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{
    name: string;
    value: string;
  }>;
  childNodes?: Node[];
}
export interface ExtractedArticle {
  title: string;
  siteName: string;
  author: string;
  description: string;
  content: string;
  images: Array<{
    url: string;
    alt: string;
    role: "cover" | "body";
  }>;
  warnings: string[];
  unavailableReason?: string;
  declaredUrl?: string;
}
const attr = (node: Node, name: string) =>
  node.attrs?.find((a) => a.name === name)?.value ?? "";
const text = (node: Node): string =>
  node.value ?? (node.childNodes ?? []).map(text).join("");
const nodes = (root: Node): Node[] => [
  root,
  ...(root.childNodes ?? []).flatMap(nodes),
];
const noise = new Set([
  "script",
  "style",
  "noscript",
  "nav",
  "footer",
  "header",
  "aside",
  "form",
  "dialog",
  "button",
  "iframe",
  "svg",
  "canvas",
  "template",
]);
function hidden(n: Node, ignoreInitialVisibility = false) {
  return (
    noise.has(n.tagName ?? "") ||
    attr(n, "class").split(/\s+/).includes("code-snippet__line-index") ||
    /(^|\s)(comments?|comment-list|advertisement|advertising|ads?|sidebar|cookie-banner|social-share|navigation|menu)(\s|$)/i.test(
      attr(n, "class"),
    ) ||
    n.attrs?.some(
      (a) =>
        a.name === "hidden" || (a.name === "aria-hidden" && a.value === "true"),
    ) ||
    /display\s*:\s*none/i.test(attr(n, "style")) ||
    (!ignoreInitialVisibility &&
      /visibility\s*:\s*hidden/i.test(attr(n, "style")))
  );
}
const escape = (s: string) => s.replace(/[\\`*_{}\[\]<>]/g, "\\$&");
export function extractArticle(
  html: string,
  url: string,
  contentType = "text/html",
  localImages: ReadonlySet<string> = new Set(),
): ExtractedArticle {
  const host = new URL(url).hostname,
    article: ExtractedArticle = {
      title: host,
      siteName: host,
      author: "",
      description: "",
      content: "",
      images: [],
      warnings: [],
    };
  if (contentType.startsWith("text/plain")) {
    article.title = html.trim().split("\n")[0]!.slice(0, 120);
    article.content = html.trim();
    return article;
  }
  const root = parse(html) as unknown as Node,
    all = nodes(root);
  const meta = (name: string) =>
    all
      .find(
        (n) =>
          n.tagName === "meta" &&
          [attr(n, "property"), attr(n, "name")].includes(name),
      )
      ?.attrs?.find((a) => a.name === "content")
      ?.value.trim() ?? "";
  const byId = (id: string) => all.find((n) => attr(n, "id") === id);
  // WeChat ships article HTML in a container initially hidden until its client
  // script finishes layout. Only that container's initial visibility is ignored;
  // hidden descendants and other pages retain the normal filtering rules.
  const wechatBody = host === "mp.weixin.qq.com" ? byId("js_content") : undefined;
  article.declaredUrl = meta("og:url") || all.find(n => n.tagName === "link" && attr(n, "rel").split(/\s+/).includes("canonical"))?.attrs?.find(a => a.name === "href")?.value;
  // A successful HTTP response can still be a verification interstitial.
  // Reject it before extracting metadata, images or a fallback body, even if
  // its instructions happen to exceed the minimum article length.
  if (
    host === "mp.weixin.qq.com" &&
    (new URL(url).pathname === "/mp/wappoc_appmsgcaptcha" ||
      (!byId("js_content") && byId("js_verify") &&
        /环境异常|完成验证后即可继续访问/.test(text(root))))
  ) {
    article.siteName = "微信公众号";
    article.unavailableReason =
      "微信要求安全验证，未返回文章正文。请在原文完成验证；后台访问仍可能受限。";
    return article;
  }
  article.title =
    meta("og:title") ||
    text(all.find((n) => n.tagName === "title") ?? root)
      .trim()
      .slice(0, 300) ||
    host;
  article.siteName =
    host === "mp.weixin.qq.com"
      ? "微信公众号"
      : ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(host)
        ? "X"
        : meta("og:site_name") || host;
  article.description = (meta("og:description") || meta("description")).slice(
    0,
    2000,
  );
  article.author = meta("author") || meta("article:author");
  if (host === "mp.weixin.qq.com") {
    article.title = text(
      byId("activity-name") ?? { nodeName: "", value: article.title },
    ).trim();
    article.author = text(
      byId("js_name") ??
        all.find((n) =>
          attr(n, "class").includes("rich_media_meta_nickname"),
        ) ?? { nodeName: "" },
    ).trim();
  }
  const isX = ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(host);
  // X Articles render the full body separately from the tweet's OG summary.
  // Never choose the surrounding timeline: it also contains replies and controls.
  const xArticleBody = isX
    ? all.find((n) =>
        !hidden(n) &&
        (/\bx-article-body\b/.test(attr(n, "class")) ||
          attr(n, "itemprop").split(/\s+/).includes("articleBody")),
      )
    : undefined;
  if (isX) {
    const match = /^(.*?)\s*\(@[^)]+\)\s*on X/.exec(article.title);
    if (match) article.author = match[1]!;
    article.title = article.description.slice(0, 120) || article.title;
  }
  const candidates = all.filter(
    (n) =>
      !hidden(n) &&
      (attr(n, "id") === "js_content" ||
        n.tagName === "article" ||
        n.tagName === "main" ||
        /^(articleBody|article-body|article-content|article__body|post-content|entry-content)$/.test(
          attr(n, "id"),
        ) ||
        /(^|\s)(article-content|post-content|entry-content)(\s|$)/.test(
          attr(n, "class"),
        )),
  );
  const chosen =
    byId("js_content") ??
    candidates.sort((a, b) => visible(b).length - visible(a).length)[0] ??
    all.find((n) => n.tagName === "body") ??
    root;
  function visible(n: Node): string {
    if (hidden(n, n === wechatBody)) return "";
    return n.value ?? (n.childNodes ?? []).map(visible).join(" ");
  }
  function safe(raw: string): string | undefined {
    try {
      const absolute = new URL(raw, url);
      canonicalizeUrl(absolute.href);
      return absolute.href;
    } catch {
      return undefined;
    }
  }
  function image(raw: string, alt: string, role: "cover" | "body") {
    const absolute = localImages.has(raw) ? raw : safe(raw);
    if (!absolute) return "";
    let index = article.images.findIndex((i) => i.url === absolute);
    if (index < 0) {
      index = article.images.length;
      article.images.push({ url: absolute, alt: alt.slice(0, 300), role });
    }
    return `\n\n![${escape(alt)}](read-later-image:${index})\n\n`;
  }
  const codeBlocks: string[] = [];
  function render(n: Node): string {
    if (hidden(n, n === wechatBody)) return "";
    if (n.nodeName === "#text")
      return escape((n.value ?? "").replace(/\s+/g, " "));
    const children = () => (n.childNodes ?? []).map(render).join("");
    const tag = n.tagName ?? "";
    if (tag === "img") {
      const sources = ["data-src", "data-original", "data-lazy-src", "data-actualsrc", "src"].map(name => attr(n, name)).filter(Boolean);
      const src = sources.find(source => localImages.has(source)) ?? sources[0] ?? "";
      return image(src, attr(n, "alt"), "body");
    }
    if (tag === "pre") {
      const code = codeText(n).replace(/\r\n?/g, "\n");
      const longestFence = Math.max(0, ...(code.match(/`{3,}/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(Math.max(3, longestFence + 1));
      const index = codeBlocks.push(`${fence}\n${code}${code.endsWith("\n") ? "" : "\n"}${fence}`) - 1;
      // Protect code whitespace from prose's empty-line normalization. HTML
      // parsing replaces NUL characters, so source text cannot forge this marker.
      return `\n\n\u0000read-later-code:${index}\u0000\n\n`;
    }
    if (tag === "code") return `\`${text(n).replace(/`/g, "ˋ")}\``;
    if (tag === "br") return "\n";
    if (tag === "hr") return "\n\n---\n\n";
    if (/^h[1-6]$/.test(tag))
      return `\n\n${"#".repeat(Number(tag[1]))} ${children().trim()}\n\n`;
    if (tag === "a") {
      const content = children();
      // Linked article images are rendered as blocks; wrapping that block in an
      // inline Markdown link breaks the image and leaves raw brackets in readers.
      if (nodes(n).some((child) => child.tagName === "img")) return content;
      const href = safe(attr(n, "href"));
      return href
        ? `[${content}](<${href.replace(/[<>\r\n]/g, "")}>)`
        : content;
    }
    if (tag === "strong" || tag === "b") return `**${children()}**`;
    if (tag === "em" || tag === "i") return `*${children()}*`;
    if (tag === "li") {
      const content = children().trim();
      return content ? `\n- ${content.replace(/\n/g, "\n  ")}` : "";
    }
    // Word's HTML exports draw bullets using a Symbol-font span inside a p.
    // Markdown has no font mapping: emit a real list, excluding its decoration.
    if (tag === "p" && /\bbulletedlist\b/i.test(attr(n, "class"))) {
      const parts = [...(n.childNodes ?? [])];
      while (parts[0]?.nodeName === "#text" && !text(parts[0]).trim()) parts.shift();
      const marker = parts[0];
      if (marker?.tagName === "span" &&
          /font-family\s*:\s*["']?Symbol\b/i.test(attr(marker, "style")) &&
          text(marker).trim() === "·") {
        const content = parts.slice(1).map(render).join("").trim();
        return content ? `\n- ${content.replace(/\n/g, "\n  ")}` : "";
      }
    }
    if (tag === "blockquote")
      return `\n\n${children()
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    if (tag === "table") {
      const rows = nodes(n)
        .filter((r) => r.tagName === "tr")
        .map((r) =>
          (r.childNodes ?? [])
            .filter((c) => ["td", "th"].includes(c.tagName ?? ""))
            .map((c) =>
              render(c).trim().replace(/\|/g, "\\|").replace(/\n+/g, " "),
            ),
        );
      if (!rows.length) return "";
      const width = Math.max(...rows.map((r) => r.length)),
        line = (r: string[]) =>
          `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
      return `\n\n${line(rows[0]!)}\n${line(Array(width).fill("---"))}\n${rows.slice(1).map(line).join("\n")}\n\n`;
    }
    if (
      [
        "p",
        "div",
        "section",
        "article",
        "main",
        "ul",
        "ol",
        "figure",
        "figcaption",
      ].includes(tag)
    )
      return `\n\n${children()}\n\n`;
    return children();
  }
  function codeText(n: Node): string {
    if (hidden(n)) return "";
    if (n.nodeName === "#text") return n.value ?? "";
    if (n.tagName === "br") return "\n";
    const content = (n.childNodes ?? []).map(codeText).join("");
    // WeChat represents each source line as a block span rather than a text
    // newline. Keep syntax-highlight token spans inline inside each source line.
    if (
      attr(n, "class").split(/\s+/).includes("code-snippet__line") ||
      ["div", "p"].includes(n.tagName ?? "")
    ) return content.endsWith("\n") ? content : `${content}\n`;
    return content;
  }
  article.content = (xArticleBody
    ? render(xArticleBody)
    : isX
      ? escape(article.description)
      : render(chosen))
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\u0000read-later-code:(\d+)\u0000/g, (_match, index: string, offset: number, markdown: string) => {
      const prefix = markdown.slice(markdown.lastIndexOf("\n", offset - 1) + 1, offset);
      const continuation = /^[ >\t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?$/.test(prefix)
        ? prefix.replace(/(?:[-*+]|\d+[.)])[ \t]+$/, (marker) => " ".repeat(marker.length))
        : "";
      return (codeBlocks[Number(index)] ?? "").replace(/\n/g, `\n${continuation}`);
    });
  if (isX) {
    const pattern = /["']original_img_url["']\s*:\s*["']([^"']+)/g;
    for (const match of html
      .replace(/\\u002[Ff]|\\\//g, "/")
      .matchAll(pattern)) {
      try {
        const media = new URL(match[1]!);
        if (
          media.hostname === "pbs.twimg.com" &&
          media.pathname.startsWith("/media/")
        )
          article.content += image(media.href, "原文图片", "body");
      } catch {
        /* Invalid relay media. */
      }
    }
  }
  const cover = meta("og:image") || meta("twitter:image");
  if (cover && (!isX || !/\/profile_(?:images|banners)\//.test(cover))) {
    const absolute = safe(cover);
    if (absolute && !article.images.some((i) => i.url === absolute))
      article.content = image(cover, "封面", "cover") + article.content;
  }
  article.title = article.title.slice(0, 300);
  article.author = article.author.slice(0, 300);
  if (visible(chosen).trim().length < 80 && !isX)
    article.warnings.push("正文不足 80 字，可能需要登录或原站未提供正文");
  if (
    article.content.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\s/g, "")
      .length < 80
  )
    article.warnings.push("正文不足 80 字");
  return article;
}
