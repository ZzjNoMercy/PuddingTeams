/**
 * 增量 JSONL 行解析器：供 Driver 在 spawnWorker 的 onStdout 回调里逐块
 * 解析事件流（spawnWorker 自带的 lines 汇总只在进程退出后可用，无法做
 * 流式 progress）。半行缓冲 + flush 语义与 spawn.ts 的 JSONL 解码一致。
 */
export class JsonlLineParser {
	private buf = "";

	/** 喂入一个 stdout chunk，返回本次完整解析出的 JSON 行（非 JSON 行忽略）。 */
	push(chunk: string): unknown[] {
		this.buf += chunk;
		const out: unknown[] = [];
		let nl: number;
		while ((nl = this.buf.indexOf("\n")) >= 0) {
			const raw = this.buf.slice(0, nl);
			this.buf = this.buf.slice(nl + 1);
			const trimmed = raw.trim();
			if (!trimmed) continue;
			try {
				out.push(JSON.parse(trimmed));
			} catch {
				// 非 JSON 行是诊断输出，忽略。
			}
		}
		return out;
	}

	/** 进程退出后冲刷尾部半行。 */
	flush(): unknown[] {
		const trimmed = this.buf.trim();
		this.buf = "";
		if (!trimmed) return [];
		try {
			return [JSON.parse(trimmed)];
		} catch {
			return [];
		}
	}
}
