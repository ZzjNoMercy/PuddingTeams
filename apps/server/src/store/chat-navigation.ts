import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface ChatNavigationFlags { pinned: boolean; archived: boolean; }
interface NavigationState { version: 1; revision: number; sessions: Record<string, ChatNavigationFlags>; }

/** Presentation metadata only. This store never changes Sessions or running jobs. */
export class ChatNavigationStore {
 private pending: Promise<unknown> = Promise.resolve();
 constructor(private readonly file: string) {}
 async read(): Promise<NavigationState> {
  let text: string;
  try { text = await readFile(this.file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, revision: 0, sessions: {} }; throw error; }
  const value = JSON.parse(text) as NavigationState;
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !value.sessions || typeof value.sessions !== "object" || Array.isArray(value.sessions)
   || Object.values(value.sessions).some(flags => !flags || typeof flags.pinned !== "boolean" || typeof flags.archived !== "boolean")) throw new Error("invalid chat navigation state");
  return value;
 }
 update(sessionId: string, patch: Partial<ChatNavigationFlags>): Promise<{ revision: number; flags: ChatNavigationFlags }> {
  const run = this.pending.then(async () => {
   const state = await this.read();
   const prior = Object.hasOwn(state.sessions, sessionId) ? state.sessions[sessionId]! : { pinned: false, archived: false };
   const flags = { ...prior, ...patch };
   const next: NavigationState = { version: 1, revision: state.revision + 1, sessions: { ...state.sessions, [sessionId]: flags } };
   await mkdir(path.dirname(this.file), { recursive: true });
   const temporary = `${this.file}.${randomUUID()}.tmp`;
   try { await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flush: true }); await rename(temporary, this.file); }
   finally { await rm(temporary, { force: true }); }
   return { revision: next.revision, flags };
  });
  this.pending = run.catch(() => undefined);
  return run;
 }
}
