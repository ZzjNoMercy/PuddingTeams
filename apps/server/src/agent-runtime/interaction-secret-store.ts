import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	type CipherKey,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface SecretsFile {
	version: number;
	/** interactionId → encrypted provider state payload (e.g. continuation token). */
	interactions: Record<string, string>;
}

const PAYLOAD_PREFIX = "v1.";

/**
 * Encrypted provider-state store for pending interactions.
 *
 * Public records live in `.teams/interactions.json` (DelegationStore); the
 * *raw continuation token* that can resume a PuddingClaw Run lives here,
 * AES-256-GCM encrypted under `~/.puddingteams/interaction.key` with 0600
 * permissions (决策 4: token 不进 LLM/浏览器/Session 历史).
 *
 * Reuses the same crypto primitives as CredentialsStore but is a distinct
 * store: these are interaction handles, not agent env secrets, so the two
 * must never be confused in the UI.
 */
export class InteractionSecretStore {
	private key: CipherKey | null = null;
	private filePromise: Promise<SecretsFile> | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly keyFile: string;
	private readonly secretsFile: string;

	constructor(private readonly dir: string) {
		this.keyFile = path.join(dir, "interaction.key");
		// 与 DelegationStore 的公开 interactions.json 分开（同名会互相覆盖）。
		this.secretsFile = path.join(dir, "interaction-secrets.json");
	}

	async init(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		await this.encryptionKey();
	}

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async encryptionKey(): Promise<CipherKey> {
		if (this.key) return this.key;
		try {
			this.key = await readFile(this.keyFile);
		} catch {
			await mkdir(this.dir, { recursive: true });
			const key = randomBytes(32);
			await writeFile(this.keyFile, key, { mode: 0o600 });
			await chmod(this.keyFile, 0o600).catch(() => undefined);
			this.key = key;
		}
		return this.key;
	}

	private async loadFile(): Promise<SecretsFile> {
		this.filePromise ??= this.readFile().catch((err: unknown) => {
			this.filePromise = null;
			throw err;
		});
		return this.filePromise;
	}

	private async readFile(): Promise<SecretsFile> {
		try {
			const raw = await readFile(this.secretsFile, "utf-8");
			const parsed = JSON.parse(raw) as Partial<SecretsFile>;
			return { version: 1, interactions: parsed.interactions ?? {} };
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return { version: 1, interactions: {} };
		}
	}

	private async writeFile(data: SecretsFile): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		const tmp = `${this.secretsFile}.${randomUUID().slice(0, 8)}.tmp`;
		await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
		await rename(tmp, this.secretsFile);
		// L2：密文文件同样收紧到 0600（§7.2）。
		await chmod(this.secretsFile, 0o600).catch(() => undefined);
		this.filePromise = Promise.resolve(data);
	}

	private async encrypt(plaintext: string): Promise<string> {
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", await this.encryptionKey(), iv);
		const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
		const tag = cipher.getAuthTag();
		return `${PAYLOAD_PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
	}

	private async decrypt(payload: string): Promise<string> {
		if (!payload.startsWith(PAYLOAD_PREFIX)) throw new Error("unsupported payload format");
		const [ivB64, tagB64, ctB64] = payload.slice(PAYLOAD_PREFIX.length).split(".");
		if (!ivB64 || !tagB64 || !ctB64) throw new Error("malformed payload");
		const decipher = createDecipheriv(
			"aes-256-gcm",
			await this.encryptionKey(),
			Buffer.from(ivB64, "base64"),
		);
		decipher.setAuthTag(Buffer.from(tagB64, "base64"));
		return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf-8");
	}

	/** Store the raw provider state (continuation token JSON) under an interaction id. */
	async setProviderState(interactionId: string, state: unknown): Promise<void> {
		await this.serialize(async () => {
			const data = await this.readFile();
			data.interactions[interactionId] = await this.encrypt(JSON.stringify(state));
			await this.writeFile(data);
		});
	}

	/** Decrypted provider state for an interaction, if any. */
	async getProviderState<T = Record<string, unknown>>(interactionId: string): Promise<T | undefined> {
		const data = await this.loadFile();
		const payload = data.interactions[interactionId];
		if (!payload) return undefined;
		return JSON.parse(await this.decrypt(payload)) as T;
	}

	/** Delete the encrypted state (interaction resolved/expired). */
	async removeProviderState(interactionId: string): Promise<void> {
		await this.serialize(async () => {
			const data = await this.readFile();
			if (!(interactionId in data.interactions)) return;
			delete data.interactions[interactionId];
			await this.writeFile(data);
		});
	}
}
