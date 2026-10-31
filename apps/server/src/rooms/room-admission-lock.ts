import path from "node:path";

/**
 * 房间公开回合的进程内准入锁。
 *
 * 与文件 store 的写锁分开：这里覆盖“检查活动 Turn → 追加用户事件 → 建 Turn”
 * 的跨 store 原子段。runner 在锁外执行，followUp 才能在长任务期间进入。
 */
const locks = new Map<string, Promise<unknown>>();

export function withRoomAdmissionLock<T>(roomSessionId: string, action: () => Promise<T>): Promise<T> {
	const key = path.normalize(roomSessionId);
	const previous = locks.get(key) ?? Promise.resolve();
	const run = previous.then(action, action);
	const tail = run.then(() => undefined, () => undefined);
	locks.set(key, tail);
	return run.finally(() => {
		if (locks.get(key) === tail) locks.delete(key);
	});
}
