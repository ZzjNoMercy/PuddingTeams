import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	type CipherKey,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod, open, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

interface CredentialsFile {
	version: number;
	/** agentName → { envKey → encryptedPayload } */
	agents: Record<string, Record<string, string>>;
}

interface BindingTransaction {
	version: 1;
	id: string;
	agentName: string;
	before: CredentialsFile;
	after: CredentialsFile;
}

function validCredentialsFile(value: unknown): value is CredentialsFile {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const file = value as Partial<CredentialsFile>;
	if (file.version !== 1 || !file.agents || typeof file.agents !== "object" || Array.isArray(file.agents)) return false;
	return Object.values(file.agents).every((entries) =>
		entries && typeof entries === "object" && !Array.isArray(entries) &&
		Object.values(entries).every((payload) => typeof payload === "string" && payload.startsWith(PAYLOAD_PREFIX)));
}

const PAYLOAD_PREFIX = "v1.";

export class BindingTransactionCommittedError extends Error {
	constructor() {
		super("binding committed; response uncertain; read back Agent before retrying");
		this.name = "BindingTransactionCommittedError";
	}
}

export class BindingTransactionRecoveryRequiredError extends Error {
	readonly statusCode = 503;
	constructor() {
		super("binding credentials transaction requires startup recovery");
		this.name = "BindingTransactionRecoveryRequiredError";
	}
}

/**
 * Encrypted, per-agent secret store for connector/capability environment
 * credentials explicitly declared by an Extension manifest. Lives outside
 * agents.json — values are AES-256-GCM
 * encrypted with a random 32-byte key at `<secrets>/credentials.key` and
 * written to `<secrets>/credentials.json`. The plaintext is never
 * persisted and never returned to the browser; the backend injects it into the
 * worker subprocess env at spawn time.
 *
 * The key file is the protection boundary: at-rest secrecy against casual
 * reads of agents.json / credentials.json. Anyone with access to the user's
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
	private readonly bindingTransactionFile: string;
	private needsRecovery = false;

	constructor(private readonly dir: string) {
		this.keyFile = path.join(dir, "credentials.key");
		this.credsFile = path.join(dir, "credentials.json");
		this.bindingTransactionFile = path.join(dir, "binding-transaction.json");
	}

	/** Ensure the directory + encryption key exist. */
	async init(): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		await this.encryptionKey();
	}

	/** Run `fn` after all previously queued mutations (in-process mutex). */
	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const guarded = () => {
			if (this.needsRecovery) throw new BindingTransactionRecoveryRequiredError();
			return fn();
		};
		const run = this.queue.then(guarded, guarded);
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
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(tmp, "wx", 0o600);
			await handle.writeFile(JSON.stringify(data, null, 2) + "\n");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(tmp, this.credsFile);
			this.filePromise = Promise.resolve(data);
			await this.syncDirectory();
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await unlink(tmp).catch(() => undefined);
			throw error;
		}
	}

	private async syncDirectory(): Promise<void> {
		let dir: Awaited<ReturnType<typeof open>> | undefined;
		try {
			dir = await open(this.dir, "r");
			await dir.sync();
		} catch (error) {
			this.needsRecovery = true;
			throw error;
		} finally { await dir?.close(); }
	}

	private async writeBindingTransaction(record: BindingTransaction): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		const temp = `${this.bindingTransactionFile}.${randomUUID()}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temp, "wx", 0o600);
			await handle.writeFile(JSON.stringify(record) + "\n");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temp, this.bindingTransactionFile);
			await this.syncDirectory();
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await unlink(temp).catch(() => undefined);
			throw error;
		}
	}

	private async readBindingTransaction(): Promise<BindingTransaction | null> {
		let raw: string;
		try { raw = await readFile(this.bindingTransactionFile, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		let value: unknown;
		try { value = JSON.parse(raw); }
		catch { throw new Error("binding credentials transaction is invalid"); }
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("binding credentials transaction is invalid");
		const record = value as Partial<BindingTransaction>;
		if (record.version !== 1 || typeof record.id !== "string" || !record.id ||
			typeof record.agentName !== "string" || !record.agentName ||
			!validCredentialsFile(record.before) || !validCredentialsFile(record.after)) {
			throw new Error("binding credentials transaction is invalid");
		}
		return record as BindingTransaction;
	}

	private async clearBindingTransaction(): Promise<void> {
		await unlink(this.bindingTransactionFile);
		await this.syncDirectory();
	}

	/** Recover the sole prepared transaction before the server accepts work. */
	async recoverBindingTransaction(isCommitted: (agentName: string, transactionId: string) => boolean | Promise<boolean>): Promise<void> {
		const run = this.queue.then(async () => {
			const record = await this.readBindingTransaction();
			if (!record) { this.needsRecovery = false; return; }
			await this.writeFile(await isCommitted(record.agentName, record.id) ? record.after : record.before);
			await this.clearBindingTransaction();
			this.needsRecovery = false;
		});
		this.queue = run.then(() => undefined, () => undefined);
		return run;
	}

	async assertReady(): Promise<void> {
		await this.queue;
		if (this.needsRecovery || await this.readBindingTransaction()) throw new BindingTransactionRecoveryRequiredError();
	}

	/** A single-writer, recoverable credentials + Registry commit. */
	async transactBinding<T>(
		agentName: string,
		changes: Record<string, string>,
		expectedSecrets: Record<string, string>,
		commit: (transactionId: string | undefined) => Promise<T>,
		isCommitted: (transactionId: string) => Promise<boolean>,
	): Promise<{ result: T; cleanupPending: boolean }> {
		return this.serialize(async () => {
			if (await this.readBindingTransaction()) throw new BindingTransactionRecoveryRequiredError();
			const before = await this.readFile();
			const existing = before.agents[agentName] ?? {};
			const plaintext: Record<string, string> = {};
			for (const [key, payload] of Object.entries(existing)) plaintext[key] = await this.decrypt(payload);
			if (JSON.stringify(Object.entries(plaintext).sort()) !== JSON.stringify(Object.entries(expectedSecrets).sort())) {
				throw new Error("Agent credentials changed during binding update; retry");
			}
			if (Object.keys(changes).length === 0) return { result: await commit(undefined), cleanupPending: false };
			const after = structuredClone(before);
			const next = { ...existing };
			for (const [key, value] of Object.entries(changes)) {
				if (value === "") delete next[key];
				else next[key] = await this.encrypt(value);
			}
			if (Object.keys(next).length > 0) after.agents[agentName] = next;
			else delete after.agents[agentName];
			const record: BindingTransaction = { version: 1, id: randomUUID(), agentName, before, after };
			await this.writeBindingTransaction(record);
			try {
				await this.writeFile(after);
				const result = await commit(record.id);
				let cleanupPending = false;
				try { await this.clearBindingTransaction(); }
				catch {
					// The committed marker makes replay safe, but no further secret reads
					// or writes may bypass the pending record in this process.
					this.needsRecovery = true;
					cleanupPending = true;
				}
				return { result, cleanupPending };
			} catch (error) {
				let committed: boolean;
				try { committed = await isCommitted(record.id); }
				catch {
					this.needsRecovery = true;
					throw new BindingTransactionRecoveryRequiredError();
				}
				try {
					await this.writeFile(committed ? after : before);
					await this.clearBindingTransaction();
				} catch {
					this.needsRecovery = true;
					throw new BindingTransactionRecoveryRequiredError();
				}
				if (committed) throw new BindingTransactionCommittedError();
				throw error;
			}
		});
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
		await this.queue;
		if (this.needsRecovery) throw new BindingTransactionRecoveryRequiredError();
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
		await this.queue;
		if (this.needsRecovery) throw new BindingTransactionRecoveryRequiredError();
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

	/** Reconcile orphaned namespaces after a registry delete committed before secret cleanup. */
	async removeRetiredAgentSecrets(agentNames: Iterable<string>): Promise<void> {
		await this.serialize(async () => {
			const retired = new Set(agentNames);
			if (retired.size === 0) return;
			const data = await this.readFile();
			let changed = false;
			for (const name of retired) {
				if (!(name in data.agents)) continue;
				delete data.agents[name];
				changed = true;
			}
			if (changed) await this.writeFile(data);
		});
	}
}
