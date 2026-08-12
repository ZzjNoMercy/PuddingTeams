import { test } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDoctorCli, runInitCli, type CliDeps, type ExecResult, type HttpProbeResult } from "./init-cli.js";
import { CredentialsStore } from "../store/credentials.js";

/**
 * `puddingteams doctor/init`（分阶段向导：环境检查 → Provider → Connector 状态
 * → CLI 安装 → PuddingClaw 接入 → 汇总确认写入）。
 * 全部流程用注入的假 exec/ask/secretAsk/probeHttp 驱动，不触真实环境；
 * 文件写入（auth.json/credentials/agents.json）落在临时 PUDDINGTEAMS_HOME。
 */

interface FakeEnv {
	deps: CliDeps;
	calls: Array<{ command: string; args: string[] }>;
	asked: string[];
	secrets: string[];
	home: string;
	defaultModel?: { provider: string; model: string };
	customProvider?: { id: string; input: unknown };
}

function makeFake(opts: {
	isTTY?: boolean;
	nodeVersion?: string;
	/** command → exit code / stdout（缺省视为未找到命令）；afterInstall=true 表示
	 * 该命令在 npm 安装成功前视为未找到（模拟"装完复测"）。 */
	commands?: Record<string, { code: number; stdout?: string; afterInstall?: boolean }>;
	answers?: string[];
	/** secretAsk 依次返回的值（缺省空串 = 未输入）。 */
	secretAnswers?: string[];
	probeOk?: boolean;
	models?: Array<{ id: string; name?: string }>;
	specOverride?: string;
}): FakeEnv {
	const calls: FakeEnv["calls"] = [];
	const asked: string[] = [];
	const secrets: string[] = [];
	const home = mkdtempSync(path.join(tmpdir(), "pt-init-cli-"));
	const env: NodeJS.ProcessEnv = { PUDDINGTEAMS_HOME: home };
	if (opts.specOverride) env.PUDDINGTEAMS_INSTALL_SPEC_PUDDINGCLAW = opts.specOverride;
	let installedAny = false;
	let askCount = 0;
	const fake: FakeEnv = {
		deps: {
			isTTY: opts.isTTY ?? false,
			env,
			nodeVersion: opts.nodeVersion ?? "24.0.0",
			exec: async (command, args): Promise<ExecResult> => {
				calls.push({ command, args });
				const hit = opts.commands?.[command];
				if (command === "npm" && hit?.code === 0) installedAny = true;
				if (hit && !(hit.afterInstall && !installedAny)) return { code: hit.code, stdout: hit.stdout ?? "", stderr: "" };
				return { code: -1, stdout: "", stderr: "ENOENT" };
			},
			ask: async (question) => {
				asked.push(question);
				askCount += 1;
				return opts.answers?.[askCount - 1] ?? "n";
			},
			secretAsk: async (question) => {
				asked.push(question);
				const v = opts.secretAnswers?.[secrets.length] ?? "";
				secrets.push(v);
				return v;
			},
			probeHttp: async (): Promise<HttpProbeResult> =>
				opts.probeOk === false ? { ok: false, detail: "HTTP 401" } : { ok: true, detail: "HTTP 200" },
			listProviderModels: async () => opts.models ?? [],
			setDefaultModel: async (provider, model) => {
				fake.defaultModel = { provider, model };
			},
			registerCustomProvider: async (id, input) => {
				fake.customProvider = { id, input };
			},
		},
		calls,
		asked,
		secrets,
		home,
	};
	return fake;
}

const ALL_WORKERS_PRESENT = {
	puddingclaw: { code: 0, stdout: '{"cli_version":"1.2.3"}\n' },
	codex: { code: 0, stdout: "codex 0.40.0\n" },
	claude: { code: 0, stdout: "2.0.0 (Claude Code)\n" },
};

function readAuthJson(home: string): Record<string, { type: string; key: string }> {
	return JSON.parse(readFileSync(path.join(home, "secrets", "auth.json"), "utf-8"));
}

// ---- doctor ----

test("doctor：全部 worker 可用 → 全 ok，退出码 0", async () => {
	const { deps } = makeFake({ commands: ALL_WORKERS_PRESENT });
	assert.equal(await runDoctorCli(["--json"], deps), 0);
});

test("doctor：worker 缺失不影响退出码，但给 npm 修复建议", async () => {
	const { deps } = makeFake({ commands: { codex: { code: 0, stdout: "codex 0.40.0" } } });
	let out = "";
	const orig = console.log;
	console.log = (msg?: unknown) => (out += `${String(msg)}\n`);
	try {
		assert.equal(await runDoctorCli([], deps), 0, "worker 缺失是可选项，不得影响退出码");
	} finally {
		console.log = orig;
	}
	assert.match(out, /✗ puddingclaw — 未找到命令/);
	assert.match(out, /npm install -g @puddingai\/puddingclaw/);
	assert.match(out, /✓ pi — 内置/);
	assert.match(out, /✓ codex — codex 0\.40\.0/);
});

test("doctor：Node <20 是核心故障，退出码 1", async () => {
	const { deps } = makeFake({ nodeVersion: "18.19.0", commands: ALL_WORKERS_PRESENT });
	assert.equal(await runDoctorCli([], deps), 1);
});

// ---- init：阶段 2.5 安装引导 ----

test("init：TTY 下用户拒绝安装 → 跳过不阻塞，退出码 0，不执行 npm", async () => {
	// 应答顺序：阶段1 选 Provider（4=跳过）→ puddingclaw/codex/claude 各拒绝。
	const { deps, calls, asked } = makeFake({ isTTY: true, answers: ["4", "n", "n", "n"] });
	assert.equal(await runInitCli([], deps), 0);
	assert.equal(asked.length, 4, "provider 选择 + 三个缺失 worker 都要询问");
	assert.ok(calls.every((c) => c.command !== "npm"), "用户拒绝后不得执行安装");
});

test("init：TTY 下用户确认 → 执行 npm install -g 并复测", async () => {
	const { deps, calls } = makeFake({
		isTTY: true,
		answers: ["4", "y", "n", "n", "n"],
		commands: { npm: { code: 0 }, puddingclaw: { code: 0, stdout: "puddingclaw 1.2.3\n", afterInstall: true } },
	});
	assert.equal(await runInitCli([], deps), 0);
	const install = calls.find((c) => c.command === "npm");
	assert.ok(install, "确认后必须执行安装");
	assert.deepEqual(install!.args, ["install", "-g", "@puddingai/puddingclaw", "--ignore-scripts", "--no-audit", "--no-fund"]);
});

test("init：安装执行失败 → 退出码 1 并给手动指引", async () => {
	const { deps } = makeFake({ isTTY: true, answers: ["4", "y", "n", "n"], commands: { npm: { code: 1 } } });
	const orig = console.error;
	let errOut = "";
	console.error = (msg?: unknown) => (errOut += `${String(msg)}\n`);
	try {
		assert.equal(await runInitCli([], deps), 1);
	} finally {
		console.error = orig;
	}
	assert.match(errOut, /安装失败/);
	assert.match(errOut, /npm install -g @puddingai\/puddingclaw/);
});

test("init：非 TTY 绝不询问或安装，只给结构化提示", async () => {
	const { deps, calls, asked } = makeFake({ isTTY: false });
	assert.equal(await runInitCli([], deps), 0);
	assert.equal(asked.length, 0, "非交互模式不得弹询问");
	assert.ok(calls.every((c) => c.command !== "npm"), "非交互模式不得自动安装");
});

test("init：安装 spec 可被环境变量覆盖（puddingclaw 发布前的本地开发）", async () => {
	const { deps, calls } = makeFake({
		isTTY: true,
		answers: ["4", "y", "n", "n", "n"],
		commands: { npm: { code: 0 }, puddingclaw: { code: 0, stdout: "dev\n", afterInstall: true } },
		specOverride: "/Users/dev/PuddingClaw/packages/puddingclaw-cli",
	});
	assert.equal(await runInitCli([], deps), 0);
	const install = calls.find((c) => c.command === "npm");
	assert.equal(install!.args[2], "/Users/dev/PuddingClaw/packages/puddingclaw-cli");
});

test("init：核心探测失败直接退出 1，不进入 worker 询问", async () => {
	const { deps, asked } = makeFake({ isTTY: true, nodeVersion: "18.19.0" });
	assert.equal(await runInitCli([], deps), 1);
	assert.equal(asked.length, 0);
});

// ---- init：阶段 1 Provider ----

test("init 阶段1：DeepSeek key 探测通过 → 确认后写 auth.json + 默认模型", async () => {
	// 应答：provider=1(DeepSeek) → 默认模型=1 → 阶段3 配置 puddingclaw=n → 阶段4 确认=y
	const fake = makeFake({
		isTTY: true,
		answers: ["1", "1", "n", "y"],
		secretAnswers: ["sk-deepseek-test"],
		commands: ALL_WORKERS_PRESENT,
		models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
	});
	assert.equal(await runInitCli([], fake.deps), 0);
	const auth = readAuthJson(fake.home);
	assert.deepEqual(auth["deepseek"], { type: "api_key", key: "sk-deepseek-test" }, "key 必须落平台自有 auth.json");
	assert.deepEqual(fake.defaultModel, { provider: "deepseek", model: "deepseek-chat" });
	// 密钥不得出现在任何询问回显之外的输出路径：只经 secretAsk 采集
	assert.equal(fake.secrets[0], "sk-deepseek-test");
});

test("init 阶段1：探测失败且用户不愿保留 → 不写 auth.json", async () => {
	// provider=1 → 探测失败 → 仍保存?=n → 阶段3=n
	const fake = makeFake({
		isTTY: true,
		answers: ["1", "n", "n"],
		secretAnswers: ["sk-bad"],
		probeOk: false,
		commands: ALL_WORKERS_PRESENT,
		models: [{ id: "deepseek-chat" }],
	});
	assert.equal(await runInitCli([], fake.deps), 0);
	assert.ok(!existsSync(path.join(fake.home, "secrets", "auth.json")), "放弃保存后不得写 auth.json");
	assert.equal(fake.defaultModel, undefined);
});

test("init 阶段1：自定义 OpenAI 兼容 provider → 登记目录 + key + 默认模型", async () => {
	// provider=3(自定义) → id/name/baseUrl/models → 默认模型=1 → 阶段3=n → 确认=y
	const fake = makeFake({
		isTTY: true,
		answers: ["3", "myprov", "", "https://api.example.com/v1", "m1,m2", "1", "n", "y"],
		secretAnswers: ["sk-custom"],
		commands: ALL_WORKERS_PRESENT,
	});
	assert.equal(await runInitCli([], fake.deps), 0);
	assert.deepEqual(fake.customProvider, {
		id: "myprov",
		input: {
			name: "myprov",
			baseUrl: "https://api.example.com/v1",
			api: "openai-completions",
			models: [{ id: "m1" }, { id: "m2" }],
		},
	});
	assert.deepEqual(readAuthJson(fake.home)["myprov"], { type: "api_key", key: "sk-custom" });
	assert.deepEqual(fake.defaultModel, { provider: "myprov", model: "m1" });
});

test("init 阶段1：选择跳过 → 无待写入项，阶段 4 不再询问", async () => {
	const fake = makeFake({
		isTTY: true,
		answers: ["4", "n"], // provider=4(跳过) → 阶段3=n
		commands: ALL_WORKERS_PRESENT,
	});
	assert.equal(await runInitCli([], fake.deps), 0);
	assert.equal(fake.asked.length, 2, "无草稿时不得弹写入确认");
	assert.ok(!existsSync(path.join(fake.home, "secrets", "auth.json")));
});

// ---- init：阶段 3 PuddingClaw 接入 + 阶段 4 写入 ----

test("init 阶段3：配置 URL + Token → agents.json env 与加密 credentials", async () => {
	// provider=4(跳过) → 阶段3 配置=Y → URL=回车(默认) → 确认=y
	const fake = makeFake({
		isTTY: true,
		answers: ["4", "", "", "y"],
		secretAnswers: ["pcl-token-1"],
		commands: {
			puddingclaw: { code: 0, stdout: '{"cli_version":"1.2.3","configured":true,"authenticated":true,"reachable":true}\n' },
			codex: { code: 0, stdout: "codex 0.40.0\n" },
			claude: { code: 0, stdout: "2.0.0\n" },
		},
	});
	assert.equal(await runInitCli([], fake.deps), 0);

	const agentsFile = JSON.parse(readFileSync(path.join(fake.home, "state", "agents.json"), "utf-8")) as {
		agents: Array<{ name: string; env?: Record<string, string> }>;
	};
	const pcl = agentsFile.agents.find((a) => a.name === "puddingclaw");
	assert.equal(pcl?.env?.PUDDINGCLAW_URL, "http://127.0.0.1:8888", "默认 URL 必须写 agents.json env");

	// Token 落加密 credentials（读回解密验证），不进 agents.json
	const credentials = new CredentialsStore(path.join(fake.home, "secrets"));
	await credentials.init();
	assert.deepEqual(await credentials.getSecrets("puddingclaw"), { PUDDINGCLAW_TOKEN: "pcl-token-1" });
	assert.equal(pcl?.env?.PUDDINGCLAW_TOKEN, undefined);

	// 配置后必须跑 doctor 复核（env 注入 URL/Token）
	assert.ok(fake.calls.some((c) => c.command === "puddingclaw" && c.args[0] === "doctor"), "复核必须执行 puddingclaw doctor");
});

test("init 阶段4：用户拒绝确认 → 什么都不写", async () => {
	// provider=1 → 默认模型=1 → 阶段3=n → 确认=n
	const fake = makeFake({
		isTTY: true,
		answers: ["1", "1", "n", "n"],
		secretAnswers: ["sk-x"],
		commands: ALL_WORKERS_PRESENT,
		models: [{ id: "deepseek-chat" }],
	});
	assert.equal(await runInitCli([], fake.deps), 0);
	assert.ok(!existsSync(path.join(fake.home, "secrets", "auth.json")), "拒绝确认后不得写入");
	assert.equal(fake.defaultModel, undefined);
});

test("init 阶段3：puddingclaw CLI 缺失时不进入接入配置", async () => {
	// provider=4(跳过) → puddingclaw 安装=n → codex=n → claude=n（无阶段3询问）
	const fake = makeFake({ isTTY: true, answers: ["4", "n", "n", "n"] });
	assert.equal(await runInitCli([], fake.deps), 0);
	assert.ok(!fake.asked.some((q) => q.includes("Backend 接入")), "CLI 缺失时不得询问接入配置");
});
