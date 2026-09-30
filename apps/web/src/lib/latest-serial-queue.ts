/** Serialize side effects while allowing a later selection to invalidate earlier work. */
export class LatestSerialQueue {
	private tail: Promise<void> = Promise.resolve();
	private revision = 0;

	invalidate(): void {
		this.revision += 1;
	}

	enqueue(task: (isCurrent: () => boolean) => void | Promise<void>): Promise<void> {
		const revision = this.revision;
		const isCurrent = () => revision === this.revision;
		const run = this.tail.then(() => isCurrent() ? task(isCurrent) : undefined);
		this.tail = run.then(() => undefined, () => undefined);
		return run;
	}
}
