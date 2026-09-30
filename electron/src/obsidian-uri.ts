/**
 * obsidian:// URI 构造与复核（T24）：server 只生成 URI，shell.openExternal 由桌面
 * 宿主在独立 IPC 通道复核后执行。复核失败返回结构化错误，绝不抛异常。
 */

export const MAX_OBSIDIAN_URI_LENGTH = 4096;

export type ObsidianUriCheck = { ok: true } | { ok: false; error: string };

/** 由服务端校验过的绝对路径构造 obsidian://open URI（纯函数）。 */
export function buildObsidianOpenUri(absolutePath: string): string {
	return `obsidian://open?path=${encodeURIComponent(absolutePath)}`;
}

// WHATWG URL 解析器会静默剔除原始串中的 tab/换行，控制字符必须在解析前拒绝。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function assertValidObsidianUri(uri: string): ObsidianUriCheck {
	if (typeof uri !== "string" || uri.length === 0) return { ok: false, error: "URI 不能为空" };
	if (uri.length > MAX_OBSIDIAN_URI_LENGTH) return { ok: false, error: `URI 超过 ${MAX_OBSIDIAN_URI_LENGTH} 字符上限` };
	if (CONTROL_CHARS.test(uri)) return { ok: false, error: "URI 含有非法控制字符" };
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return { ok: false, error: "URI 无法解析" };
	}
	if (parsed.protocol !== "obsidian:") return { ok: false, error: "仅允许 obsidian: 协议" };
	if (parsed.username || parsed.password || parsed.port || parsed.hostname !== "open" ||
		(parsed.pathname !== "" && parsed.pathname !== "/")) {
		return { ok: false, error: "仅支持 obsidian://open 命令" };
	}
	if (parsed.hash) return { ok: false, error: "URI 不允许携带片段" };
	const keys = [...parsed.searchParams.keys()];
	const allowed = (keys.length === 1 && keys[0] === "path") ||
		(keys.length === 2 && keys.includes("vault") && keys.includes("file"));
	if (!allowed) return { ok: false, error: "URI 只允许 path 或 vault+file 参数" };
	for (const key of keys) {
		if (!parsed.searchParams.get(key)) return { ok: false, error: "URI 参数值不能为空" };
	}
	return { ok: true };
}
