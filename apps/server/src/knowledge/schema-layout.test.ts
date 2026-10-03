import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KnowledgeBinding } from "./contracts.js";
import { assessAcceptedNote } from "./schema-impact.js";
import { copySchemaPreset } from "./schema-presets.js";
import { schemaContentPrefix, schemaEntityDirectory } from "./schema-layout.js";

test("结构化Wiki目录按真实内容区统一：根绑定、子根、平铺与无关wiki目录", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pt-schema-layout-"));
	const binding = { canonicalBindingRoot: root, contentRoot: root } as KnowledgeBinding;
	const schema = copySchemaPreset("people");
	try {
		assert.equal(await schemaContentPrefix(binding, schema), "");
		await mkdir(path.join(root, "wiki"));
		assert.equal(await schemaContentPrefix(binding, schema), "", "仅同名目录不能改平铺布局");
		await writeFile(path.join(root, "wiki", "index.md"), "# Wiki");
		const prefix = await schemaContentPrefix(binding, schema);
		assert.equal(prefix, "wiki/");
		assert.equal(schemaEntityDirectory(prefix, "People"), "wiki/People");
		assert.equal(await schemaContentPrefix({ ...binding, contentRoot: path.join(root, "wiki") }, schema), "");
		await mkdir(path.join(root, "People"));
		assert.equal(await schemaContentPrefix(binding, schema), "", "已有平铺实体不因额外wiki导航目录改变坐标");
		await rm(path.join(root, "People"), { recursive: true });
		await rm(path.join(root, "wiki"), { recursive: true });
		await mkdir(path.join(root, "other")); await writeFile(path.join(root, "other", "index.md"), "# Other");
		await symlink(path.join(root, "other"), path.join(root, "wiki"));
		assert.equal(await schemaContentPrefix(binding, schema), "", "不跟随符号链接选择写入坐标");
	} finally { await rm(root, { recursive: true, force: true }); }
});


test("结构调整影响评估使用Wiki目录前缀", () => {
 const before = copySchemaPreset("people"), after = structuredClone(before);
 const person = after.entities.find(entity => entity.type === "person")!; person.directory = "Contacts";
 const affected = assessAcceptedNote("wiki/People/test.md", { id: "one", type: "person", title: "测试" }, before, after, "wiki/");
 assert(affected?.reasons.includes("directory_changed:People->Contacts"));
});
