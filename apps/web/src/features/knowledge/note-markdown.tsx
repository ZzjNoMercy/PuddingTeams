"use client";

import { isValidElement, type ComponentProps, type MouseEvent, type ReactNode } from "react";
import { ImageIcon } from "lucide-react";
import { knowledgeAssetUrl } from "@/lib/api";
import { parseWikiLinkHref, resolveKnowledgeAssetRef, slugifyHeading } from "./markdown";

export function headingText(node: ReactNode): string {
	if (node === null || node === undefined || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(headingText).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) return headingText(node.props.children);
	return "";
}

export interface NoteMarkdownHandlers {
	/** 点击 [[wiki 链接]]；target 为解码后的裸目标（可能带 #anchor）。 */
	onWikiLink: (target: string, event: MouseEvent) => void;
	/** 点击相对路径 Markdown 链接；href 原样传给 resolve（kind=md）。 */
	onMdLink: (href: string, event: MouseEvent) => void;
	/** 点击页内 #anchor 链接。 */
	onAnchorLink: (anchor: string, event: MouseEvent) => void;
	/** 已知解析结果的链接样式键（"wiki:target" / "md:href"）。 */
	brokenLinks: ReadonlySet<string>;
	allowedRemoteImages: ReadonlySet<string>;
	onAllowRemoteImage: (src: string) => void;
}

/**
 * 笔记正文的渲染组件表：http/https/mailto 维持外部链接；wiki/相对链接走库内 resolve；
 * 相对图片改写为 asset 端点，远程图片点击后才加载，越界/绝对路径不请求。
 */
export function buildNoteMarkdownComponents(options: NoteMarkdownHandlers & {
	bindingId: string; notePath: string;
	/** 固定候选/历史可提供自己的授权资源端点；null 不请求该图片。 */
	assetUrl?: (path: string) => string | null;
	remoteImagesDisabled?: boolean;
}) {
	const { bindingId, notePath } = options;
	const heading = (Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => {
		function Heading({ children }: { children?: ReactNode }) {
			return <Tag id={slugifyHeading(headingText(children))}>{children}</Tag>;
		}
		return Heading;
	};
	return {
		a: ({ href, children }: ComponentProps<"a">) => {
			const wikiTarget = parseWikiLinkHref(href);
			if (wikiTarget !== null) {
				const broken = options.brokenLinks.has(`wiki:${wikiTarget}`);
				return (
					<button
						type="button"
						className={broken ? "knowledge-wiki-link is-broken" : "knowledge-wiki-link"}
						title={broken ? "找不到目标笔记" : wikiTarget}
						onClick={(event) => options.onWikiLink(wikiTarget, event)}
					>{children}</button>
				);
			}
			try {
				const url = href ? new URL(href) : null;
				if (url && ["https:", "http:", "mailto:"].includes(url.protocol)) {
					return <a href={url.href} target="_blank" rel="noopener noreferrer">{children}</a>;
				}
			} catch { /* 相对链接继续走库内解析 */ }
			if (href?.startsWith("#")) {
				return (
					<button type="button" className="knowledge-wiki-link" onClick={(event) => options.onAnchorLink(href.slice(1), event)}>{children}</button>
				);
			}
			if (href) {
				const broken = options.brokenLinks.has(`md:${href}`);
				return (
					<button
						type="button"
						className={broken ? "knowledge-wiki-link is-broken" : "knowledge-wiki-link"}
						title={broken ? "找不到目标笔记" : href}
						onClick={(event) => options.onMdLink(href, event)}
					>{children}</button>
				);
			}
			return <span>{children}</span>;
		},
		img: ({ src, alt }: ComponentProps<"img">) => {
			if (typeof src !== "string" || !src) return null;
			const assetRef = resolveKnowledgeAssetRef(notePath, src);
			if (assetRef.kind === "remote") {
				if (options.remoteImagesDisabled) return <span className="knowledge-image-blocked">[远程图片未加载{alt ? ` · ${alt}` : ""}]</span>;
				if (options.allowedRemoteImages.has(assetRef.url)) {
					// eslint-disable-next-line @next/next/no-img-element -- 用户显式点击后才加载的远程图片
					return <img src={assetRef.url} alt={alt ?? ""} loading="lazy" />;
				}
				return (
					<button type="button" className="knowledge-remote-image" onClick={() => options.onAllowRemoteImage(assetRef.url)}>
						<ImageIcon size={15} />
						<span>远程图片未自动加载{alt ? `：${alt}` : ""} · 点击加载</span>
					</button>
				);
			}
			if (assetRef.kind === "blocked") {
				return <span className="knowledge-image-blocked">[图片未加载：路径越界或不在库内{alt ? ` · ${alt}` : ""}]</span>;
			}
			const url = options.assetUrl ? options.assetUrl(assetRef.path) : knowledgeAssetUrl(bindingId, assetRef.path);
			if (!url) return <span className="knowledge-image-blocked">[图片未加载：未包含在此固定版本中{alt ? ` · ${alt}` : ""}]</span>;
			// eslint-disable-next-line @next/next/no-img-element -- 授权资源直出，不走 next/image 优化管线
			return <img src={url} alt={alt ?? ""} loading="lazy" />;
		},
		h1: heading("h1"),
		h2: heading("h2"),
		h3: heading("h3"),
		h4: heading("h4"),
		h5: heading("h5"),
		h6: heading("h6"),
	};
}
