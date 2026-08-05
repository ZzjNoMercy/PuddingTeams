// Adapted from deer-flow (MIT). Lean plugin set: markdown + shiki code
// highlighting only. No rehype-raw (LLM HTML is not trusted), no KaTeX, no
// Mermaid — keep the renderer minimal for the chat timeline.
import { code } from "@streamdown/code";
import remarkGfm from "remark-gfm";
import type { StreamdownProps } from "streamdown";

export const streamdownPlugins = {
	plugins: {
		code,
	} satisfies NonNullable<StreamdownProps["plugins"]>,
	remarkPlugins: [[remarkGfm, { singleTilde: false }]] as StreamdownProps["remarkPlugins"],
	rehypePlugins: [] as StreamdownProps["rehypePlugins"],
};

export const reasoningPlugins = streamdownPlugins;
