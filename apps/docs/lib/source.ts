import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";

const docs = defineDocs({
  dir: ".",
  docs: { files: ["*.mdx"] },
  meta: { files: ["meta.json"] }
});

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource()
});
