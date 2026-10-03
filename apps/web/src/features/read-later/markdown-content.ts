import { isValidElement, type ReactNode } from "react";

/** Empty Markdown list entries have no visible content; images still count. */
export function hasMarkdownContent(node: ReactNode): boolean {
  if (typeof node === "string") return node.trim().length > 0;
  if (typeof node === "number") return true;
  if (Array.isArray(node)) return node.some(hasMarkdownContent);
  if (isValidElement<{ children?: ReactNode; src?: unknown }>(node)) {
    return (typeof node.props.src === "string" && node.props.src.length > 0) ||
      hasMarkdownContent(node.props.children);
  }
  return false;
}
