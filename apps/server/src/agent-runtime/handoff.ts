import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * workspace / handoff 目录约定与软引导（§15.3 / §15.5.1）。
 *
 * <workspace>/
 * └─ .pudding/
 *    └─ handoff/<delegationId>/     # 本次 Run 的交付物（push 导出目录）
 *
 * CLI 不知道平台目录结构：导出路径由 Driver 按 handoffDirFor 生成并经
 * --export 传入（§15.7）；ArtifactRef.path 统一存 workspace 相对路径。
 */

/** 本次 Run 的交付物导出目录（绝对路径）。 */
export function handoffDirFor(workspace: string, delegationId: string): string {
	return path.join(workspace, ".pudding", "handoff", delegationId);
}

/** 导出目录相对路径 → workspace 相对路径（统一 posix 分隔，供接力文本引用）。 */
export function handoffRelativePath(delegationId: string, exportedPath: string): string {
	const parts = exportedPath.split(/[\\/]+/).filter(Boolean);
	return [".pudding", "handoff", delegationId, ...parts].join("/");
}

const MANAGED_BEGIN = "<!-- pudding:handoff-begin -->";
const MANAGED_END = "<!-- pudding:handoff-end -->";

const MANAGED_BLOCK = `${MANAGED_BEGIN}
## PuddingTeams 交付约定（平台托管块，请勿手工编辑）

- 报告、导出数据等交付物写入本工作区的 \`.pudding/handoff/\` 目录；
- 最终回复中列出交付物清单（名称 + 路径），供接力任务按路径引用（传路径不传内容）；
- 中间过程产物（scratch、临时文件）自理，不要放进 handoff 目录。
${MANAGED_END}`;

/** 写入/替换托管块：块外用户内容原样保留，重复调用幂等。 */
export function upsertManagedBlock(content: string): string {
	const begin = content.indexOf(MANAGED_BEGIN);
	const end = content.indexOf(MANAGED_END);
	if (begin >= 0 && end > begin) {
		return `${content.slice(0, begin)}${MANAGED_BLOCK}${content.slice(end + MANAGED_END.length)}`;
	}
	const trimmed = content.trimEnd();
	const sep = trimmed.length ? "\n\n" : "";
	return `${trimmed}${sep}${MANAGED_BLOCK}\n`;
}

/**
 * 绑定 workspace 时的软引导（§15.5.1）：AGENTS.md / CLAUDE.md 都写托管块
 * （Codex、Claude、Pi 都会自动读取其中之一）。幂等：内容无变化不写盘。
 */
export async function ensureHandoffGuidance(workspace: string): Promise<void> {
	await mkdir(workspace, { recursive: true });
	for (const name of ["AGENTS.md", "CLAUDE.md"]) {
		const file = path.join(workspace, name);
		let current = "";
		try {
			current = await readFile(file, "utf-8");
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		const next = upsertManagedBlock(current);
		if (next !== current) await writeFile(file, next, "utf-8");
	}
}
