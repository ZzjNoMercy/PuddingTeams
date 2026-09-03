#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedVersion = "1.0.1";

const versionedPackages = [
	"package.json",
	"apps/server/package.json",
	"apps/web/package.json",
	"apps/docs/package.json",
	"electron/package.json",
	"packages/puddingteams-cli/package.json",
];

const hostExtensions = [
	"extensions/connectors/codex/package.json",
	"extensions/connectors/claude-code/package.json",
	"extensions/connectors/echo/package.json",
	"extensions/capabilities/lark-cli/package.json",
];

async function readJson(relativePath) {
	return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

const errors = [];
for (const relativePath of versionedPackages) {
	const manifest = await readJson(relativePath);
	if (manifest.version !== expectedVersion) {
		errors.push(`${relativePath}: version=${String(manifest.version)}，期望 ${expectedVersion}`);
	}
}

for (const relativePath of hostExtensions) {
	const manifest = await readJson(relativePath);
	const range = manifest.puddingteams?.engines?.puddingteams;
	if (range !== ">=1 <2") {
		errors.push(`${relativePath}: pudding.engines.puddingteams=${String(range)}，期望 >=1 <2`);
	}
}

const rootManifest = await readJson("package.json");
if (rootManifest.engines?.node !== ">=22.19.0") {
	errors.push(`package.json: engines.node=${String(rootManifest.engines?.node)}，期望 >=22.19.0`);
}
const pinnedNode = (await readFile(path.join(root, ".node-version"), "utf8")).trim();
if (pinnedNode !== "22.19.0") {
	errors.push(`.node-version=${pinnedNode}，期望 22.19.0`);
}

if (errors.length > 0) {
	console.error("✗ 1.0 发布元数据不一致：");
	for (const error of errors) console.error(`  - ${error}`);
	process.exit(1);
}

console.log(`✓ 版本 ${expectedVersion}、Node >=22.19.0 与第一方 Extension 宿主范围一致`);
