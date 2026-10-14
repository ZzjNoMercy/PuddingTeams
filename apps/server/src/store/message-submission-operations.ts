import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export interface NativeMessageReceipt {
 operationId: string; disposition: "started" | "queued" | "handled"; delivery: "normal" | "followUp" | "steer"; persistence: "durable" | "pending" | "not_applicable";
 processId: string; userEntryId?: string; terminal?: "cancelled_unconfirmed";
}

interface MessageSubmissionRecord {
 receipt?: NativeMessageReceipt;
	key: string;
	sessionId: string;
	requestHash: string;
	contextHash: string;
	state: "reserved" | "accepted" | "rejected" | "retryable";
	reason?: string;
}

export class MessageSubmissionConflictError extends Error {
	constructor() { super("同一消息操作键已用于不同会话或内容"); this.name = "MessageSubmissionConflictError"; }
}

export class MessageSubmissionUnconfirmedError extends Error {
	constructor() { super("该消息操作的发送结果尚未确认，请先核对会话历史，不能自动重发"); this.name = "MessageSubmissionUnconfirmedError"; }
}

const validKey = (key: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(key);
const validHash = (hash: string) => /^[a-f0-9]{64}$/.test(hash);

/** A durable reservation precedes both pi user messages and direct Worker dispatch. */
export class MessageSubmissionOperations {
	private readonly uncertain = new Set<string>();
 private changes = Promise.resolve();
 async get(key: string) { return this.read(this.file(key)); }
 async pending(sessionId: string) {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(this.directory).catch((e: NodeJS.ErrnoException) => { if(e.code === "ENOENT") return []; throw e; });
  const rows = await Promise.all(files.filter(file => /^[a-f0-9]{64}\.json$/.test(file)).map(file => this.read(path.join(this.directory, file))));
  return rows.filter(row => row?.sessionId === sessionId && row.receipt?.persistence === "pending" && !row.receipt.terminal).map(row => row!);
 }
	constructor(private readonly directory: string) {}

	private file(key: string): string {
		return path.join(this.directory, `${createHash("sha256").update(key).digest("hex")}.json`);
	}

	private async syncDirectory(): Promise<void> {
		const directory = await open(this.directory, "r");
		try { await directory.sync(); }
		finally { await directory.close(); }
	}

	private async read(file: string): Promise<MessageSubmissionRecord | null> {
		let raw: string;
		try { raw = await readFile(file, "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
		let record: unknown;
		try { record = JSON.parse(raw) as unknown; }
		catch { throw new MessageSubmissionUnconfirmedError(); }
		if (!record || typeof record !== "object" || Array.isArray(record)) throw new MessageSubmissionUnconfirmedError();
		const parsed = record as Record<string, unknown>;
		if (typeof parsed.key !== "string" || !validKey(parsed.key) || typeof parsed.sessionId !== "string" || !parsed.sessionId ||
			typeof parsed.requestHash !== "string" || !validHash(parsed.requestHash) ||
			typeof parsed.contextHash !== "string" || !validHash(parsed.contextHash) ||
			(parsed.state !== "reserved" && parsed.state !== "accepted" && parsed.state !== "rejected" && parsed.state !== "retryable") ||
			(parsed.state === "rejected" && (typeof parsed.reason !== "string" || !parsed.reason || parsed.reason.length > 2048)) ||
			this.file(parsed.key) !== file) {
			throw new MessageSubmissionUnconfirmedError();
		}
  if (parsed.receipt !== undefined) {
   const receipt = parsed.receipt as NativeMessageReceipt;
   if (!receipt || typeof receipt !== "object" || receipt.operationId !== parsed.key || !["started","queued","handled"].includes(receipt.disposition) || !["normal","followUp","steer"].includes(receipt.delivery) || !["durable","pending","not_applicable"].includes(receipt.persistence) || typeof receipt.processId !== "string" || !receipt.processId || receipt.terminal !== undefined && receipt.terminal !== "cancelled_unconfirmed" || receipt.userEntryId !== undefined && typeof receipt.userEntryId !== "string") throw new MessageSubmissionUnconfirmedError();
  }
		return parsed as unknown as MessageSubmissionRecord;
	}

 async reserve(key: string, sessionId: string, requestHash: string, contextHash: string) {
  const action = () => this.reserveUnlocked(key, sessionId, requestHash, contextHash);
  const run = this.changes.then(action, action); this.changes = run.then(() => {}, () => {}); return run;
 }
	private async reserveUnlocked(key: string, sessionId: string, requestHash: string, contextHash: string): Promise<"new" | "accepted" | "unconfirmed" | { rejected: string }> {
		if (!validKey(key)) throw new Error("Idempotency-Key 必须是 8–128 位字母、数字、点、下划线或连字符");
		if (!sessionId || !validHash(requestHash) || !validHash(contextHash)) throw new Error("消息操作身份无效");
		const file = this.file(key);
		if (this.uncertain.has(file)) throw new MessageSubmissionUnconfirmedError();
		await mkdir(this.directory, { recursive: true });
		const record: MessageSubmissionRecord = { key, sessionId, requestHash, contextHash, state: "reserved" };
		let handle: Awaited<ReturnType<typeof open>>;
		try { handle = await open(file, "wx", 0o600); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = await this.read(file);
			if (!existing) throw new MessageSubmissionUnconfirmedError();
			if (existing.key !== key || existing.sessionId !== sessionId || existing.requestHash !== requestHash || existing.contextHash !== contextHash) throw new MessageSubmissionConflictError();
			if (existing.state === "retryable") { await this.writeRecord({...existing,state:"reserved",reason:undefined}); return "new"; }
			return existing.state === "accepted" ? "accepted" : existing.state === "rejected" ? { rejected: existing.reason! } : "unconfirmed";
		}
		try {
			await handle.writeFile(`${JSON.stringify(record)}\n`);
			await handle.sync();
		} catch (error) {
			this.uncertain.add(file);
			throw error;
		} finally { await handle.close(); }
		try { await this.syncDirectory(); }
		catch (error) { this.uncertain.add(file); throw error; }
		return "new";
	}

	async markAccepted(key: string, sessionId: string, requestHash: string, receipt?: NativeMessageReceipt): Promise<void> {
 const action = () => this.markAcceptedUnlocked(key, sessionId, requestHash, receipt);
 const pending = this.changes.then(action, action); this.changes = pending.catch(() => {}); return pending;
 }
 private async markAcceptedUnlocked(key: string, sessionId: string, requestHash: string, receipt?: NativeMessageReceipt): Promise<void> {
		const file = this.file(key);
		if (this.uncertain.has(file)) throw new MessageSubmissionUnconfirmedError();
		const existing = await this.read(file);
		if (!existing) throw new MessageSubmissionUnconfirmedError();
		if (existing.key !== key || existing.sessionId !== sessionId || existing.requestHash !== requestHash) throw new MessageSubmissionConflictError();
		if (existing.state === "accepted" && !receipt) return;
 if (existing.receipt?.persistence === "durable" && receipt?.persistence === "pending") return;
		if (existing.state === "rejected") throw new MessageSubmissionUnconfirmedError();
		const temp = `${file}.${randomUUID()}.tmp`;
		let renamed = false;
		try {
			const handle = await open(temp, "wx", 0o600);
			try { await handle.writeFile(`${JSON.stringify({ ...existing, state: "accepted", ...(receipt ? { receipt } : {}) })}\n`); await handle.sync(); }
			finally { await handle.close(); }
			await rename(temp, file);
			renamed = true;
			await this.syncDirectory();
		} catch (error) {
			if (renamed) this.uncertain.add(file);
			throw error;
		} finally {
			await rm(temp, { force: true }).catch(() => undefined);
		}
	}

 /** SDK definitively rejected before admission; claim the same intent again, never replay an accepted input. */
 async markRetryable(key: string, sessionId: string, requestHash: string) {
  const action = async () => { const record = await this.read(this.file(key));
   if (!record || record.sessionId !== sessionId || record.requestHash !== requestHash || record.state !== "reserved") throw new MessageSubmissionUnconfirmedError();
   await this.writeRecord({...record,state:"retryable"});
  };
  const run=this.changes.then(action,action);this.changes=run.catch(()=>{});return run;
 }
 private async writeRecord(record: MessageSubmissionRecord) {
  const file=this.file(record.key),temp=`${file}.${randomUUID()}.tmp`;
  const fd=await open(temp,"wx",0o600);try{await fd.writeFile(JSON.stringify(record)+"\n");await fd.sync();}finally{await fd.close();}
  try{await rename(temp,file);await this.syncDirectory();}catch(error){this.uncertain.add(file);throw error;}
 }
	/** Finalize a deterministic validation failure before any upload or message side effect. */
	async markRejected(key: string, sessionId: string, requestHash: string, reason: string): Promise<void> {
		if (!reason || reason.length > 2048) throw new Error("消息拒绝原因无效");
		const file = this.file(key);
		if (this.uncertain.has(file)) throw new MessageSubmissionUnconfirmedError();
		const existing = await this.read(file);
		if (!existing) throw new MessageSubmissionUnconfirmedError();
		if (existing.key !== key || existing.sessionId !== sessionId || existing.requestHash !== requestHash) throw new MessageSubmissionConflictError();
		if (existing.state === "rejected") {
			if (existing.reason !== reason) throw new MessageSubmissionUnconfirmedError();
			return;
		}
		if (existing.state === "accepted") throw new MessageSubmissionUnconfirmedError();
		const temp = `${file}.${randomUUID()}.tmp`;
		let renamed = false;
		try {
			const handle = await open(temp, "wx", 0o600);
			try { await handle.writeFile(`${JSON.stringify({ ...existing, state: "rejected", reason })}\n`); await handle.sync(); }
			finally { await handle.close(); }
			await rename(temp, file);
			renamed = true;
			await this.syncDirectory();
		} catch (error) {
			if (renamed) this.uncertain.add(file);
			throw error;
		} finally {
			await rm(temp, { force: true }).catch(() => undefined);
		}
	}
}
