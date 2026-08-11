import { test, after } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `puddingteams data import-legacy`（迁移方案 §9）一次性导入 CLI。
 *
 * 与 extension-cli.test.ts 同一约定：所有 CLI 调用经 bin/puddingteams.mjs
 * 子进程执行（node:test 内进程内调用会间歇损坏 runner IPC）。测试造一个
 * 完整的假旧目录树（.teams/.sessions/旧 secrets 备份），覆盖 §9.2 映射表
 * 关键行、§9.3 归档策略、§9.4 冲突不覆盖与 staging→原子发布→报告。
 */

const REPO_ROOT = path.resolve(new URL("../../../../", import.meta.url).pathname);
const SERVER_DIR = path.join(REPO_ROOT, "apps", "server");

const cleanupDirs: string[] = [];
after(() => {
	for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

/** 经真实 bin 跑 CLI（tsx 孙进程），返回退出码与合并输出。 */
function runBin(args: string[]): Promise<{ code: number; out: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [path.join(SERVER_DIR, "bin/puddingteams.mjs"), ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
		child.on("error", reject);
		child.on("exit", (code) => resolve({ code: code ?? 1, out }));
	});
}

function writeJson(file: string, data: unknown): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function readJson(file: string): any {
	return JSON.parse(readFileSync(file, "utf-8"));
}

/** CredentialsStore/InteractionSecretStore 同款 AES-256-GCM v1. 加密（造旧密文用）。 */
function encryptV1(key: Buffer, plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
	return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
}

function sessionFile(dir: string, id: string, cwd: string): string {
	const name = `2026-08-01T00-00-00-000Z_${id}.jsonl`;
	const header = { type: "session", version: 3, id, timestamp: "2026-08-01T00:00:00.000Z", cwd };
	writeFileSync(path.join(dir, name), JSON.stringify(header) + "\n", "utf-8");
	return name;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const LOCAL_MANIFEST = {
	id: "demo-local",
	publisher: "test",
	displayName: "Demo Local",
	version: "1.0.0",
	source: "external",
	kind: "connector",
	engines: { puddingteams: ">=0.1 <1" },
	connector: { id: "demo-local", displayName: "Demo Local", apiVersion: "1", defaultTransport: "spawn", supportedTransports: ["spawn"] },
};

interface LegacyFixture {
	repo: string;
	from: string;
	home: string;
	externalDir: string;
	externalCanonical: string;
	localExtDir: string;
	secretsDir: string;
	managedId: string;
	sidExternal: string;
	sidRepo: string;
	sidManaged: string;
	sidOrphan: string;
	credentialsKey: Buffer;
	interactionsKey: Buffer;
}

/** 造完整的假旧布局：repo/apps/server 下 .teams/.sessions + 外部 workspace + 旧 secrets 备份。 */
function buildLegacyTree(): LegacyFixture {
	const base = freshDir("pt-import-");
	const repo = path.join(base, "repo");
	const from = path.join(repo, "apps", "server");
	const teamsDir = path.join(from, ".teams");
	const sessionsDir = path.join(from, ".sessions");
	const home = path.join(base, "home");
	const externalDir = path.join(base, "external-ws");
	const localExtDir = path.join(base, "local-ext");
	const secretsDir = path.join(base, "secrets-old");
	mkdirSync(teamsDir, { recursive: true });
	mkdirSync(sessionsDir, { recursive: true });
	mkdirSync(externalDir, { recursive: true });
	mkdirSync(localExtDir, { recursive: true });
	mkdirSync(secretsDir, { recursive: true });
	writeFileSync(path.join(repo, "AGENTS.md"), "# repo context\n", "utf-8");
	const externalCanonical = realpathSync(externalDir);

	// sessions：external（随 workspace 窗口迁移）、repo（无项目+源码仓 cwd → §9.3 归档）、
	// managed（managed workspace 窗口）、orphan（无窗口归属 → 归档）。
	const sidExternal = randomUUID();
	const sidRepo = randomUUID();
	const sidManaged = randomUUID();
	const sidOrphan = randomUUID();
	const managedId = randomUUID();
	const managedOldDir = path.join(teamsDir, "workspaces", managedId);
	mkdirSync(managedOldDir, { recursive: true });
	writeFileSync(path.join(managedOldDir, "hello.txt"), "managed workspace file\n", "utf-8");
	const managedOldCanonical = realpathSync(managedOldDir);
	sessionFile(sessionsDir, sidExternal, externalCanonical);
	sessionFile(sessionsDir, sidRepo, realpathSync(from));
	sessionFile(sessionsDir, sidManaged, managedOldCanonical);
	sessionFile(sessionsDir, sidOrphan, externalCanonical);

	writeJson(path.join(teamsDir, "teams.json"), {
		version: 1,
		agents: [
			{
				name: "manager",
				description: "自定义 manager",
				invoke: { type: "pi" },
				pinned: true,
				enabled: true,
				manager: { model: "openai/gpt-5" },
				piResources: { systemPrompt: "用户自定义提示词" },
			},
			{
				name: "puddingclaw",
				description: "企业数据分析 Worker",
				connector: { extensionId: "puddingclaw", connectorId: "puddingclaw", config: { command: "puddingclaw" } },
				enabled: true,
			},
			{
				name: "alpha",
				description: "用户 Worker",
				invoke: { type: "command", command: "echo", runArgs: [] },
				enabled: true,
				avatar: "alpha.png",
			},
		],
	});

	writeJson(path.join(teamsDir, "workspaces.json"), {
		version: 1,
		workspaces: {
			ext1: {
				id: "ext1",
				name: "外部项目",
				rootPath: externalDir,
				canonicalPath: externalCanonical,
				managed: false,
				createdAt: "2026-08-01T00:00:00.000Z",
				lastOpenedAt: "2026-08-01T00:00:00.000Z",
			},
			[managedId]: {
				id: managedId,
				name: "临时项目",
				rootPath: managedOldDir,
				canonicalPath: managedOldCanonical,
				managed: true,
				createdAt: "2026-08-01T00:00:00.000Z",
				lastOpenedAt: "2026-08-01T00:00:00.000Z",
			},
		},
	});

	writeJson(path.join(teamsDir, "windows.json"), {
		version: 1,
		windows: {
			w1: {
				id: "w1",
				type: "group",
				members: ["alpha"],
				sessions: [sidExternal],
				activeSession: sidExternal,
				workspaceId: "ext1",
				cwdSnapshot: externalCanonical,
				createdAt: "2026-08-01T00:00:00.000Z",
			},
			w2: {
				id: "w2",
				type: "direct",
				members: ["alpha"],
				sessions: [sidRepo],
				activeSession: sidRepo,
				cwdSnapshot: realpathSync(from),
				createdAt: "2026-08-01T00:00:00.000Z",
			},
			w3: {
				id: "w3",
				type: "direct",
				members: ["alpha"],
				sessions: [sidManaged],
				activeSession: sidManaged,
				workspaceId: managedId,
				cwdSnapshot: managedOldCanonical,
				workerBindings: {
					alpha: { sessionHandle: "h1", workspaceId: managedId, cwdSnapshot: managedOldCanonical, agentRevision: 1, updatedAt: "2026-08-01T00:00:00.000Z" },
				},
				createdAt: "2026-08-01T00:00:00.000Z",
			},
		},
	});

	writeJson(path.join(teamsDir, "delegations.json"), {
		version: 1,
		delegations: {
			d1: { id: "d1", windowId: "w1", cwdSnapshot: externalCanonical, managerSessionId: sidExternal, agentId: "alpha", agentRevision: 1, operation: "run", status: "completed", revision: 1, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
			d2: { id: "d2", windowId: "w1", cwdSnapshot: externalCanonical, managerSessionId: sidExternal, agentId: "alpha", agentRevision: 1, operation: "run", status: "running", revision: 0, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
		},
	});

	writeJson(path.join(teamsDir, "interactions.json"), {
		version: 1,
		interactions: {
			i1: { id: "i1", delegationId: "d2", kind: "permission", requests: [], status: "pending", revision: 0, providerStateRef: "i1", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
			i2: { id: "i2", delegationId: "missing", kind: "question", requests: [], status: "pending", revision: 0, providerStateRef: "i2", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
		},
	});

	writeJson(path.join(teamsDir, "work-states.json"), {
		version: 3,
		states: {
			[sidExternal]: { sessionId: sidExternal, goal: "g", responsibleAgentId: "manager", participantAgentIds: [], currentBrief: "", completionBoundary: "b", goalRevision: 0, reviewMode: "manager", completionReviews: [], status: "active", artifactIds: [], revision: 0, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
			[sidRepo]: { sessionId: sidRepo, goal: "g2", responsibleAgentId: "manager", participantAgentIds: [], currentBrief: "", completionBoundary: "b", goalRevision: 0, reviewMode: "manager", completionReviews: [], status: "active", artifactIds: [], revision: 0, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z" },
		},
		decisions: {},
	});

	const blob = Buffer.from("artifact-blob\n");
	mkdirSync(path.join(teamsDir, "artifact-snapshots"), { recursive: true });
	writeFileSync(path.join(teamsDir, "artifact-snapshots", "a1"), blob);
	writeJson(path.join(teamsDir, "artifacts.json"), {
		version: 1,
		artifacts: {
			a1: { id: "a1", name: "out.txt", path: path.join(externalDir, "out.txt"), snapshotPath: path.join(teamsDir, "artifact-snapshots", "a1"), contentHash: createHash("sha256").update(blob).digest("hex"), origin: "push", producer: "alpha", delegationId: "d1", windowId: "w1", cwdSnapshot: externalCanonical, createdAt: "2026-08-01T00:00:00.000Z" },
			a2: { id: "a2", name: "lost.txt", path: "/nowhere/lost.txt", snapshotPath: path.join(teamsDir, "artifact-snapshots", "a2"), contentHash: "0".repeat(64), origin: "push", producer: "alpha", delegationId: "d1", windowId: "w1", cwdSnapshot: externalCanonical, createdAt: "2026-08-01T00:00:00.000Z" },
		},
	});

	mkdirSync(path.join(teamsDir, "uploads", sidExternal), { recursive: true });
	writeFileSync(path.join(teamsDir, "uploads", sidExternal, "note.txt"), "upload\n", "utf-8");
	const orphanUploadDir = path.join(teamsDir, "uploads", randomUUID());
	mkdirSync(orphanUploadDir, { recursive: true });
	writeFileSync(path.join(orphanUploadDir, "orphan.txt"), "orphan\n", "utf-8");

	mkdirSync(path.join(teamsDir, "avatars"), { recursive: true });
	writeFileSync(path.join(teamsDir, "avatars", "alpha.png"), PNG_MAGIC);
	writeFileSync(path.join(teamsDir, "avatars", "bad.png"), "not an image");

	writeJson(path.join(teamsDir, "product-settings.json"), { developerMode: true });

	writeFileSync(path.join(localExtDir, "package.json"), JSON.stringify({ name: "@test/demo-local", version: "1.0.0", puddingteams: LOCAL_MANIFEST }, null, 2), "utf-8");
	writeJson(path.join(teamsDir, "extensions.json"), {
		version: 1,
		extensions: [
			{ manifest: { ...LOCAL_MANIFEST, id: "demo-bundled", connector: { ...LOCAL_MANIFEST.connector, id: "demo-bundled", displayName: "Demo Bundled" }, displayName: "Demo Bundled" }, origin: "bundled", sourcePath: "/repo/extensions/connectors/demo-bundled", installedAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", version: "1.0.0" },
			{ manifest: LOCAL_MANIFEST, origin: "local", sourcePath: localExtDir, installedAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z", version: "1.0.0" },
		],
	});

	const credentialsKey = randomBytes(32);
	const interactionsKey = randomBytes(32);
	writeJson(path.join(secretsDir, "credentials.json"), { version: 1, agents: { alpha: { TOKEN: encryptV1(credentialsKey, "secret-value") } } });
	writeFileSync(path.join(secretsDir, "secret.key"), credentialsKey);
	writeJson(path.join(secretsDir, "interaction-secrets.json"), { version: 1, interactions: { i1: encryptV1(interactionsKey, "token-1"), gone: encryptV1(interactionsKey, "token-2") } });
	writeFileSync(path.join(secretsDir, "interaction.key"), interactionsKey);

	return { repo, from, home, externalDir, externalCanonical, localExtDir, secretsDir, managedId, sidExternal, sidRepo, sidManaged, sidOrphan, credentialsKey, interactionsKey };
}

function importArgs(f: LegacyFixture, extra: string[] = []): string[] {
	return ["data", "import-legacy", "--from", f.from, "--home", f.home, "--secrets-from", f.secretsDir, ...extra];
}

// ---- 参数校验 ----

test("缺 --from / 未知子命令 / from 不含 .teams|.sessions → 1", async () => {
	assert.strictEqual((await runBin(["data"])).code, 1);
	assert.strictEqual((await runBin(["data", "bogus"])).code, 1);
	assert.strictEqual((await runBin(["data", "import-legacy"])).code, 1);
	const empty = freshDir("pt-import-empty-");
	const { code, out } = await runBin(["data", "import-legacy", "--from", empty, "--home", path.join(empty, "home")]);
	assert.strictEqual(code, 1);
	assert.match(out, /必须是含 \.teams 或 \.sessions/);
});

// ---- dry-run：零写入 + 映射/归档清单 ----

test("dry-run（默认）：输出映射与归档清单，home 零写入", async () => {
	const f = buildLegacyTree();
	const { code, out } = await runBin(importArgs(f));
	assert.strictEqual(code, 0, out);
	assert.match(out, /DRY-RUN/);
	assert.match(out, /目标映射/);
	assert.match(out, /state\/agents\.json/);
	assert.match(out, /legacy-unscoped-sessions/);
	assert.match(out, /无项目旧 Session/);
	assert.match(out, /sessions\.archived: 2/); // sidRepo + sidOrphan
	assert.match(out, /sessions\.migrated: 2/); // sidExternal + sidManaged
	assert.ok(!existsSync(f.home), "dry-run 不得创建 home");
});

// ---- execute：staging 校验 → 原子发布 → 报告，覆盖映射表关键行 ----

test("--execute：映射表关键行 + §9.3 归档/restub + 报告", async () => {
	const f = buildLegacyTree();
	const { code, out } = await runBin(importArgs(f, ["--execute"]));
	assert.strictEqual(code, 0, out);
	assert.match(out, /导入完成/);

	// agents：manager 合并用户自定义且 pinned 强制；用户 Agent 保留。
	const agents = readJson(path.join(f.home, "state", "agents.json")).agents as any[];
	const manager = agents.find((a) => a.name === "manager");
	assert.strictEqual(manager.pinned, true);
	assert.strictEqual(manager.invoke.type, "pi");
	assert.strictEqual(manager.description, "自定义 manager");
	assert.strictEqual(manager.manager.model, "openai/gpt-5");
	assert.ok(agents.some((a) => a.name === "alpha"));
	assert.ok(agents.some((a) => a.name === "puddingclaw"));

	// workspaces：外部保留 + pending；managed 复制 + 重算 canonical + trusted。
	const workspaces = readJson(path.join(f.home, "state", "workspaces.json")).workspaces as Record<string, any>;
	assert.strictEqual(workspaces.ext1.trust.state, "pending");
	assert.strictEqual(workspaces.ext1.rootPath, f.externalDir);
	const managed = workspaces[f.managedId];
	const managedNewRoot = path.join(f.home, "workspaces", "managed", f.managedId);
	assert.strictEqual(managed.rootPath, managedNewRoot);
	assert.strictEqual(managed.canonicalPath, realpathSync(managedNewRoot));
	assert.strictEqual(managed.trust.state, "trusted");
	assert.strictEqual(readFileSync(path.join(managedNewRoot, "hello.txt"), "utf-8"), "managed workspace file\n");

	// windows：w1 原样迁移；w2 无项目+repo cwd → restub unscoped + 新 stub session；
	// w3 的 cwdSnapshot/workerBindings 随 managed 重写。
	const windows = readJson(path.join(f.home, "state", "windows.json")).windows as Record<string, any>;
	assert.deepStrictEqual(windows.w1.sessions, [f.sidExternal]);
	assert.strictEqual(windows.w1.workspaceId, "ext1");
	assert.strictEqual(windows.w2.workspaceId, undefined);
	assert.strictEqual(windows.w2.cwdSnapshot, realpathSync(path.join(f.home, "workspaces", "unscoped")));
	assert.strictEqual(windows.w2.sessions.length, 1);
	assert.notStrictEqual(windows.w2.sessions[0], f.sidRepo);
	const stubId = windows.w2.sessions[0] as string;
	const stubName = readdirSync(path.join(f.home, "sessions")).find((n) => n.endsWith(`_${stubId}.jsonl`))!;
	const stubHeader = JSON.parse(readFileSync(path.join(f.home, "sessions", stubName), "utf-8").split("\n")[0]!);
	assert.strictEqual(stubHeader.id, stubId);
	assert.strictEqual(stubHeader.cwd, windows.w2.cwdSnapshot);
	assert.strictEqual(windows.w3.cwdSnapshot, realpathSync(managedNewRoot));
	assert.strictEqual(windows.w3.workerBindings.alpha.cwdSnapshot, realpathSync(managedNewRoot));

	// sessions：workspace 归属的迁移；repo/孤儿归档且不在 sessions/。
	const sessionFiles = readdirSync(path.join(f.home, "sessions"));
	assert.ok(sessionFiles.some((n) => n.includes(f.sidExternal)));
	assert.ok(sessionFiles.some((n) => n.includes(f.sidManaged)));
	assert.ok(!sessionFiles.some((n) => n.includes(f.sidRepo)));
	assert.ok(!sessionFiles.some((n) => n.includes(f.sidOrphan)));
	const archived = readdirSync(path.join(f.home, "migrations", "legacy-unscoped-sessions"));
	assert.ok(archived.some((n) => n.includes(f.sidRepo)));
	assert.ok(archived.some((n) => n.includes(f.sidOrphan)));
	// 旧目录不删除（§9.4.6）。
	assert.ok(existsSync(path.join(f.from, ".sessions")));

	// delegations：终态保留；running → cancelled（不可恢复）。
	const delegations = readJson(path.join(f.home, "state", "delegations.json")).delegations as Record<string, any>;
	assert.strictEqual(delegations.d1.status, "completed");
	assert.strictEqual(delegations.d2.status, "cancelled");

	// interactions：pending → expired；孤儿记录丢弃。
	const interactions = readJson(path.join(f.home, "state", "interactions.json")).interactions as Record<string, any>;
	assert.strictEqual(interactions.i1.status, "expired");
	assert.strictEqual(interactions.i2, undefined);

	// work-states：只保留引用有效 Session 的记录。
	const workStates = readJson(path.join(f.home, "state", "work-states.json"));
	assert.ok(workStates.states[f.sidExternal]);
	assert.strictEqual(workStates.states[f.sidRepo], undefined);

	// artifacts：blob 复制 + snapshotPath 重写 + digest 对账；坏记录丢弃。
	const artifacts = readJson(path.join(f.home, "state", "artifacts.json")).artifacts as Record<string, any>;
	assert.strictEqual(artifacts.a1.snapshotPath, path.join(realpathSync(path.join(f.home, "artifacts", "blobs")), "a1"));
	assert.strictEqual(readFileSync(path.join(f.home, "artifacts", "blobs", "a1"), "utf-8"), "artifact-blob\n");
	assert.strictEqual(artifacts.a2, undefined);

	// uploads：按 Session 归属迁移。
	assert.strictEqual(readFileSync(path.join(f.home, "uploads", f.sidExternal, "note.txt"), "utf-8"), "upload\n");

	// avatars：magic bytes + Agent 引用校验。
	assert.ok(existsSync(path.join(f.home, "assets", "avatars", "alpha.png")));
	assert.ok(!existsSync(path.join(f.home, "assets", "avatars", "bad.png")));

	// product settings → config/product.json。
	assert.deepStrictEqual(readJson(path.join(f.home, "config", "product.json")), { developerMode: true });

	// extensions：bundled 不迁；旧 origin:"local" → local-link + digest。
	const registry = readJson(path.join(f.home, "extensions", "registry.json")).extensions as any[];
	assert.strictEqual(registry.length, 1);
	assert.strictEqual(registry[0].origin, "local-link");
	assert.strictEqual(registry[0].sourcePath, f.localExtDir);
	assert.match(registry[0].digest, /^sha256:[0-9a-f]{64}$/);
	assert.strictEqual(registry[0].version, "1.0.0");

	// secrets：成组迁移且可解密；孤儿 continuation state 丢弃。
	assert.ok(readFileSync(path.join(f.home, "secrets", "credentials.key")).equals(f.credentialsKey));
	const creds = readJson(path.join(f.home, "secrets", "credentials.json"));
	const payload = creds.agents.alpha.TOKEN as string;
	const [ivB64, tagB64, ctB64] = payload.slice("v1.".length).split(".");
	const decipher = createDecipheriv("aes-256-gcm", f.credentialsKey, Buffer.from(ivB64!, "base64"));
	decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
	const plain = Buffer.concat([decipher.update(Buffer.from(ctB64!, "base64")), decipher.final()]).toString("utf-8");
	assert.strictEqual(plain, "secret-value");
	assert.ok(readFileSync(path.join(f.home, "secrets", "interactions.key")).equals(f.interactionsKey));
	assert.deepStrictEqual(readJson(path.join(f.home, "secrets", "interaction-secrets.json")).interactions, {});

	// 报告：migrations/user-home-v1.json（来源/摘要/数量/冲突/时间）。
	const report = readJson(path.join(f.home, "migrations", "user-home-v1.json"));
	assert.strictEqual(report.dryRun, false);
	assert.strictEqual(report.from, f.from);
	assert.ok(report.counts["agents.migrated"] >= 3);
	assert.ok(Array.isArray(report.conflicts));
	assert.ok(Array.isArray(report.published) && report.published.length > 0);
	assert.ok(typeof report.finishedAt === "string");
	// staging 已清理。
	assert.ok(!readdirSync(path.join(f.home, "migrations")).some((n) => n.startsWith("staging-")));
});

// ---- §9.4 冲突：同名不同内容不覆盖 ----

test("冲突：目标已存在且内容不同 → 不覆盖、记冲突、退出码 2", async () => {
	const f = buildLegacyTree();
	mkdirSync(path.join(f.home, "state"), { recursive: true });
	writeJson(path.join(f.home, "state", "agents.json"), { version: 1, agents: [{ name: "existing" }] });
	const before = readFileSync(path.join(f.home, "state", "agents.json"), "utf-8");
	const { code, out } = await runBin(importArgs(f, ["--execute"]));
	assert.strictEqual(code, 2, out);
	assert.match(out, /冲突/);
	assert.match(out, /state\/agents\.json/);
	// 未被覆盖；其余事实源照常发布。
	assert.strictEqual(readFileSync(path.join(f.home, "state", "agents.json"), "utf-8"), before);
	assert.ok(existsSync(path.join(f.home, "state", "windows.json")));
	const report = readJson(path.join(f.home, "migrations", "user-home-v1.json"));
	assert.ok(report.conflicts.some((c: any) => c.item === path.join("state", "agents.json")));
});

// ---- secrets：密钥缺失该组跳过并记冲突 ----

test("secrets 密钥文件缺失：该组跳过 + 冲突，退出码 2（dry-run）", async () => {
	const base = freshDir("pt-import-nosecrets-");
	const from = path.join(base, "repo", "apps", "server");
	mkdirSync(path.join(from, ".teams"), { recursive: true });
	const secretsDir = path.join(base, "secrets-old");
	mkdirSync(secretsDir, { recursive: true });
	writeJson(path.join(secretsDir, "credentials.json"), { version: 1, agents: { a: { K: "v1.x.y.z" } } });
	// 没有 secret.key。
	const { code, out } = await runBin(["data", "import-legacy", "--from", from, "--home", path.join(base, "home"), "--secrets-from", secretsDir]);
	assert.strictEqual(code, 2, out);
	assert.match(out, /secret\.key 不存在/);
	assert.ok(!existsSync(path.join(base, "home")), "dry-run 零写入");
});
