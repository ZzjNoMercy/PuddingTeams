import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerLegacyDataDiagnostics } from "./legacy-data-diagnostics.js";

test("legacy queue diagnostics inspect metadata without parsing, replaying or deleting bytes", async () => {
 const root = await mkdtemp(path.join(tmpdir(), "pt-legacy-diagnostics-"));
 const app = Fastify();
 registerLegacyDataDiagnostics(app, root);
 try {
  assert.deepEqual((await app.inject("/api/diagnostics/legacy-data")).json(), { files: [], automaticReplay: false });
  const file = path.join(root,"worker-input-queue.json");
  await writeFile(file,"not JSON: do not dispatch me");
  const result = (await app.inject("/api/diagnostics/legacy-data")).json();
  assert.equal(result.automaticReplay,false);
  assert.equal(result.files[0].action,"manual_cleanup_only");
  assert.equal(await readFile(file,"utf8"),"not JSON: do not dispatch me");
  assert.equal((await app.inject({method:"DELETE",url:"/api/diagnostics/legacy-data"})).statusCode,404);
 } finally { await app.close(); await rm(root,{recursive:true,force:true}); }
});
