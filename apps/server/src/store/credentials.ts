import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	type CipherKey,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface CredentialsFile {
	version: number;
	/** agentName → { envKey → encryptedPayload } */
	agents: Record<string, Record<string, string>>;
}

const PAYLOAD_PREFIX = "v1.";

/**
 * Encrypted, per-agent secret store for worker env tokens (e.g. PuddingClaw's
 * PUDDINGCLAW_TOKEN). Lives outside teams.json — values are AES-256-GCM
 * encrypted with a random 32-byte key at `~/.puddingteams/secret.key` and
 * written to `~/.puddingteams/credentials.json`. The plaintext is never
 * persisted and never returned to the browser; the backend injects it into the
 * worker subprocess env at spawn time.
 *
 * The key file is the protection boundary: at-rest secrecy against casual
 * reads of teams.json / credentials.json. Anyone with access to the user's
 * home directory can also read the key file, so this is not a substitute for
 * OS keychain — it is the "don't put secrets in plaintext registry/config"
 * guarantee.
 */
export class CredentialsStore {
	private key: CipherKey | null = null;
	private filePromise: Promise<CredentialsFile> | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly keyFile: string;
	private readonly credsFile: string;

	constructor(private readonly dir: string) {
		this.keyFile = path.join(dir, "secret.key");
		this.credsFile = path.join(dir, "credentials.json");
	}

	/** Ensure the directory + encryption key exist. */
	async init(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		await this.encryptionKey();
	}

	/** Run `fn` after all previously queued mutations (in-process mutex). */
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
			// writeFile's mode is ignored when the file exists; make the
			// chmod explicit so the key never ships world-readable.
			await chmod(this.keyFile, 0o600).catch(() => undefined);
			this.key = key;
		}
		return this.key;
	}

	private async loadFile(): Promise<CredentialsFile> {
		this.filePromise ??= this.readFile().catch((err: unknown) => {
			this.filePromise = null;
			throw err;
		});
		return this.filePromise;
	}

	private async readFile(): Promise<CredentialsFile> {
		try {
			const raw = await readFile(this.credsFile, "utf-8");
			const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
			return { version: 1, agents: parsed.agents ?? {} };
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return { version: 1, agents: {} };
		}
	}

	private async writeFile(data: CredentialsFile): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		const tmp = `${this.credsFile}.${randomUUID().slice(0, 8)}.tmp`;
		await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
		await rename(tmp, this.credsFile);
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

	/** Decrypted env vars for an agent (empty when none configured). */
	async getSecrets(agentName: string): Promise<Record<string, string>> {
		const data = await this.loadFile();
		const entries = data.agents[agentName] ?? {};
		const out: Record<string, string> = {};
		for (const [k, payload] of Object.entries(entries)) {
			out[k] = await this.decrypt(payload);
		}
		return out;
	}

	/** Names of configured env keys for an agent (never the values). */
	async listConfigured(agentName: string): Promise<string[]> {
		const data = await this.loadFile();
		return Object.keys(data.agents[agentName] ?? {});
	}

	/** Set env secrets for an agent. Empty-string values remove the key.
	 * Returns the keys now configured for the agent. */
	async setSecrets(agentName: string, secrets: Record<string, string>): Promise<string[]> {
		return this.serialize(async () => {
			const data = await this.readFile();
			const current = { ...(data.agents[agentName] ?? {}) };
			for (const [k, v] of Object.entries(secrets)) {
				if (typeof v !== "string") continue;
				if (v === "") delete current[k];
				else current[k] = await this.encrypt(v);
			}
			if (Object.keys(current).length === 0) delete data.agents[agentName];
			else data.agents[agentName] = current;
			await this.writeFile(data);
			return Object.keys(current);
		});
	}

	/** Remove one env secret for an agent. */
	async removeSecret(agentName: string, key: string): Promise<void> {
		await this.serialize(async () => {
			const data = await this.readFile();
			const current = data.agents[agentName];
			if (!current || !(key in current)) return;
			delete current[key];
			if (Object.keys(current).length === 0) delete data.agents[agentName];
			await this.writeFile(data);
		});
	}

	/** Drop all secrets when an agent is deleted. */
	async removeAgentSecrets(agentName: string): Promise<void> {
		await this.serialize(async () => {
			const data = await this.readFile();
			if (!(agentName in data.agents)) return;
			delete data.agents[agentName];
			await this.writeFile(data);
		});
	}
}
