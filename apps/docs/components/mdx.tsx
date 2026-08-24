import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

export function Status({ children, tone = "stable" }: { children: React.ReactNode; tone?: "stable" | "preview" | "experimental" | "planned" }) {
  return <span className={`content-status status-${tone}`}>{children}</span>;
}

export function Principle({ title, children }: { title: string; children: React.ReactNode }) {
  return <aside className="principle-note"><strong>{title}</strong><div>{children}</div></aside>;
}

export function getMDXComponents(components?: MDXComponents) {
  return { ...defaultMdxComponents, Status, Principle, ...components } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
