import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ProductSettings {
	developerMode: boolean;
}

export class ProductSettingsStore {
	private readonly file: string;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly teamsDir: string) {
		this.file = path.join(teamsDir, "product-settings.json");
	}

	async get(): Promise<ProductSettings> {
		try {
			const parsed = JSON.parse(await readFile(this.file, "utf-8")) as Partial<ProductSettings>;
			return { developerMode: parsed.developerMode === true };
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return { developerMode: false };
		}
	}

	async setDeveloperMode(enabled: boolean): Promise<ProductSettings> {
		const run = this.queue.then(async () => {
			const settings = { developerMode: enabled };
			await mkdir(this.teamsDir, { recursive: true });
			const tmp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
			await writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
			await rename(tmp, this.file);
			return settings;
		});
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}
}
