#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "electron", "release");
const pattern = /^PuddingTeams-1\.0\.0-(arm64|x64)\.(dmg|exe)$/;

async function sha256(filePath) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	return hash.digest("hex");
}

const names = (await readdir(releaseDir)).filter((name) => pattern.test(name)).sort();
const required = ["PuddingTeams-1.0.1-arm64.dmg", "PuddingTeams-1.0.1-x64.dmg", "PuddingTeams-1.0.1-x64.exe"];
const missing = required.filter((name) => !names.includes(name));
if (missing.length > 0) {
	console.error(`✗ 缺少 1.0.1 安装包：${missing.join("、")}`);
	process.exit(1);
}

const lines = [];
for (const name of names) {
	const filePath = path.join(releaseDir, name);
	const info = await stat(filePath);
	if (info.size < 10 * 1024 * 1024) throw new Error(`${name} 体积异常：${info.size} bytes`);
	lines.push(`${await sha256(filePath)}  ${name}`);
}

await writeFile(path.join(releaseDir, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
console.log(`✓ 已校验 ${names.length} 个安装包并写入 electron/release/SHA256SUMS.txt`);
