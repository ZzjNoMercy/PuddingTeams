"use client";

import type { ReactNode } from "react";
import { Block, type Components } from "streamdown";
import remarkGfm from "remark-gfm";

// 摘要在可点击的对话行里：只输出行内内容，不放链接、图片、复制按钮或块级布局。
function InlineContent({ children }: Record<string, unknown> | { children?: ReactNode }) {
	return <span>{children as ReactNode} </span>;
}

const components: Components = {
	p: InlineContent,
	h1: InlineContent,
	h2: InlineContent,
	h3: InlineContent,
	h4: InlineContent,
	h5: InlineContent,
	h6: InlineContent,
	blockquote: InlineContent,
	ul: InlineContent,
	ol: InlineContent,
	li: InlineContent,
	pre: InlineContent,
	table: InlineContent,
	thead: InlineContent,
	tbody: InlineContent,
	tr: InlineContent,
	th: InlineContent,
	td: InlineContent,
	a: ({ children }) => <span>{children}</span>,
	img: ({ alt }) => <span>{alt || "图片"}</span>,
	br: () => <span> </span>,
	hr: () => <span> </span>,
	strong: ({ children }) => <strong>{children}</strong>,
	em: ({ children }) => <em>{children}</em>,
	del: ({ children }) => <del>{children}</del>,
	code: ({ children }) => <code>{children}</code>,
	inlineCode: ({ children }) => <code>{children}</code>,
};

const allowedElements = Object.keys(components).filter((tag) => tag !== "inlineCode");
type PreviewNode = { type: string; value?: string; children?: PreviewNode[] };

// 服务端摘要已把换行收为空格；只在普通文本节点清理残留标题符号，代码不受影响。
function compactHeadingMarkers() {
	return (tree: PreviewNode) => {
		const visit = (node: PreviewNode) => {
			if (node.type === "text" && node.value) node.value = node.value.replace(/(^|\s)#{1,6}\s+/g, "$1");
			node.children?.forEach(visit);
		};
		visit(tree);
	};
}

const remarkPlugins = [remarkGfm, compactHeadingMarkers];
const rehypePlugins: [] = [];

export function MessagePreview({ content }: { content: string }) {
	return <Block
		content={content.slice(0, 512)}
		index={0}
		isIncomplete={false}
		shouldParseIncompleteMarkdown={false}
		shouldNormalizeHtmlIndentation={false}
		components={components}
		allowedElements={allowedElements}
		unwrapDisallowed
		skipHtml
		remarkPlugins={remarkPlugins}
		rehypePlugins={rehypePlugins}
	/>;
}
