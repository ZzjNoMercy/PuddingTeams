import { lstat } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeBinding } from "./contracts.js";
import type { TeamsSchemaPreset } from "./schema-presets.js";

/** Stored paths stay relative to binding.contentRoot. Platform scaffolds place
 * structured notes next to wiki/index.md even when the binding is the vault root.
 * A bare incidental wiki directory alone does not opt a flat vault into this layout.
 */
export async function schemaContentPrefix(binding: KnowledgeBinding, schema?: TeamsSchemaPreset): Promise<string> {
 if (!schema || binding.contentRoot !== binding.canonicalBindingRoot) return "";
 const wiki = await lstat(path.join(binding.contentRoot, "wiki")).catch(() => null);
 const index = wiki?.isDirectory() && !wiki.isSymbolicLink() ? await lstat(path.join(binding.contentRoot, "wiki", "index.md")).catch(() => null) : null;
 if (!index?.isFile() || index.isSymbolicLink()) return "";
 // Existing flat entity directories have an unambiguous flat coordinate system.
 const flat = await Promise.all(schema.entities.map(entity => lstat(path.join(binding.contentRoot, entity.directory)).catch(() => null)));
 if (flat.some(entry => entry?.isDirectory() && !entry.isSymbolicLink())) return "";
 return "wiki/";
}
export function schemaEntityDirectory(prefix: string, directory: string): string { return `${prefix}${directory}`; }
