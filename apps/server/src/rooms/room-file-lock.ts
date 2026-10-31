import path from "node:path";

/**
 * 进程内按 (root, roomSessionId) 串行。
 *
 * 所有 RoomSession 文件存储共享同一把锁：同一进程里多个 store 实例、
 * 或多个房间服务并发写同一房间时，不能各自维护实例级队列。
 */
const queues = new Map<string, Promise<unknown>>();

function key(root: string, roomSessionId: string): string {
	return `${path.resolve(root)}\u0000${roomSessionId}`;
}

export async function withRoomFileLock<T>(root: string, roomSessionId: string, action: () => Promise<T>): Promise<T> {
	const lockKey = key(root, roomSessionId);
	const previous = queues.get(lockKey) ?? Promise.resolve();
	const run = previous.then(action, action);
	const tail = run.then(() => undefined, () => undefined);
	queues.set(lockKey, tail);
	try {
		return await run;
	} finally {
		if (queues.get(lockKey) === tail) queues.delete(lockKey);
	}
}
