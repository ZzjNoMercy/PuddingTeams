/**
 * 控制文档不是笔记页：操作契约、首页与日志由平台与发布流程维护。
 *
 * 它们照样出现在文件树里（用户要能直接打开看），但不计入笔记数与当前检索语料，
 * 也不能保存为普通笔记来源——否则首页、契约与日志会混进编译来源。
 *
 * 位置有两种，内容根取决于库形态（managed-wiki 库的内容根就是 wiki/ 本身，
 * 纯 Markdown 库的内容根是库根）：内容根顶层，或 wiki/ 目录顶层。
 * 更深的层级（如 concepts/index.md）仍是正常笔记。
 */
const controlDocuments = new Set(["agents.md", "claude.md", "index.md", "log.md"]);
const WIKI_DIRECTORY = "wiki";

export function isControlDocument(relativePath: string): boolean {
	const parts = relativePath.split("/");
	if (parts.length > 2 || (parts.length === 2 && parts[0] !== WIKI_DIRECTORY)) return false;
	return controlDocuments.has(parts[parts.length - 1]!.toLowerCase());
}
