const queues = new Map<string, Promise<unknown>>();

/** Publication, recovery and observing disk must share one complete mutation boundary. */
export async function withKnowledgeMutation<T>(bindingId: string, action: () => Promise<T>): Promise<T> {
	const previous = queues.get(bindingId) ?? Promise.resolve();
	const current = previous.then(action);
	const settled = current.then(() => undefined, () => undefined);
	queues.set(bindingId, settled);
	try { return await current; } finally { if (queues.get(bindingId) === settled) queues.delete(bindingId); }
}
