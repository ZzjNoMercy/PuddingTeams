"use client";

import { useMemo } from "react";
import { ClipboardSafeStreamdown } from "@/components/ai-elements/streamdown";
import { streamdownPlugins } from "@/core/streamdown/plugins";
import { buildNoteMarkdownComponents } from "./note-markdown";
import { rewriteWikiLinks } from "./markdown";

/** Immutable review/history rendering: assets come only from the supplied snapshot resolver. */
export function SnapshotMarkdown({ text, bindingId, notePath, assetUrl }: {
	text: string; bindingId: string; notePath: string; assetUrl: (path: string) => string | null;
}) {
	const components = useMemo(() => buildNoteMarkdownComponents({
		bindingId, notePath, assetUrl, remoteImagesDisabled: true,
		brokenLinks: new Set(), allowedRemoteImages: new Set(),
		onWikiLink: () => {}, onMdLink: () => {}, onAnchorLink: () => {}, onAllowRemoteImage: () => {},
	}), [bindingId, notePath, assetUrl]);
	return <ClipboardSafeStreamdown {...streamdownPlugins} components={components}>{rewriteWikiLinks(text)}</ClipboardSafeStreamdown>;
}
