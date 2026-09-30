import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Synthetic M0 fixture. It never reads or writes a user's existing Home or Wiki. */
const base = await mkdtemp(path.join(tmpdir(), "puddingteams-2-fixture-"));
const home = path.join(base, "home");
const workspaceA = path.join(base, "workspaces", "project-a");
const workspaceB = path.join(base, "workspaces", "project-b");
const markdown = path.join(base, "vaults", "markdown");
const wiki = path.join(base, "vaults", "managed-wiki");

for (const directory of [
	home, workspaceA, workspaceB, markdown,
	path.join(wiki, "wiki", "concepts"), path.join(wiki, "raw", "synthetic-source"),
	path.join(wiki, "schema"), path.join(wiki, ".puddingclaw", "staging"),
]) await mkdir(directory, { recursive: true });

await writeFile(path.join(workspaceA, "README.md"), "# Project A\nSynthetic workspace.\n");
await writeFile(path.join(workspaceB, "README.md"), "# Project B\nSynthetic workspace.\n");
await writeFile(path.join(markdown, "note.md"), "# Markdown vault\nSynthetic note.\n");
const source = "Synthetic evidence.\n";
await writeFile(path.join(wiki, "raw", "synthetic-source", "snapshot.txt"), source);
await writeFile(path.join(wiki, "raw", "manifest.jsonl"), JSON.stringify({
	source_id: "synthetic-source", snapshot_path: "synthetic-source/snapshot.txt",
	sha256: createHash("sha256").update(source).digest("hex"),
}) + "\n");
await writeFile(path.join(wiki, "schema", "brain.schema.yaml"), "id: synthetic-wiki\nversion: 1\n");
await writeFile(path.join(wiki, "wiki", "index.md"), "# Synthetic Wiki\n");
await writeFile(path.join(wiki, "wiki", "concepts", "example.md"), "---\nid: concept-example\ntitle: Example\n---\n\n# Example\n");
await writeFile(path.join(wiki, "wiki", "log.md"), "# Synthetic publish log\n");

console.log(JSON.stringify({
	fixtureVersion: 1, synthetic: true, base, home,
	workspaces: [workspaceA, workspaceB],
	vaults: { markdown, managedWiki: wiki },
	usage: `PUDDINGTEAMS_HOME=${home}`,
}, null, 2));
