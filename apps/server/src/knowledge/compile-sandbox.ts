import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InvocationContext } from "../agent-runtime/types.js";

type ProtectedCompile = NonNullable<InvocationContext["protectedCompile"]>;

export interface CompileSandboxRequest {
	jobId: string;
	/** Immutable materialized source snapshot, never the live Wiki root. */
	sourceSnapshotRoot: string;
	/** The only writable candidate output tree. */
	stagingRoot: string;
	/** Per-job private directory, owned by the host, outside source and staging. */
	privateRoot: string;
	/** Trusted first-party CLI file; caller supplies its reviewed digest. */
	commandPath: string;
	commandSha256: string;
	/** Host-owned local Responses proxy. Omit for the default no-network profile. */
	modelChannel?: { port: number };
}

function contains(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function canonicalDirectory(value: string, name: string): Promise<string> {
	if (!path.isAbsolute(value) || await realpath(value) !== value || !(await stat(value)).isDirectory()) {
		throw new Error(`${name} must be an existing canonical directory`);
	}
	return value;
}

function literalAncestors(value: string): string[] {
	const parents: string[] = [];
	for (let current = path.dirname(value); ; current = path.dirname(current)) {
		parents.push(current);
		if (current === path.dirname(current)) break;
	}
	return parents;
}

/** Issue the OS portion of one CompileJob's execution boundary. No Manager or
 * Connector configuration field can call this through an HTTP or tool route.
 * Admission still requires a durable CompileJob, a reviewed first-party package
 * digest, and a controlled model channel before real compilation is enabled. */
export async function issueCompileSandbox(request: CompileSandboxRequest): Promise<ProtectedCompile> {
	if (process.platform !== "darwin") throw new Error("knowledge compile sandbox is unavailable on this OS");
	if (!/^[A-Za-z0-9_-]{1,96}$/.test(request.jobId)) throw new Error("invalid CompileJob id");
	if (!/^[a-f0-9]{64}$/.test(request.commandSha256)) throw new Error("invalid reviewed CLI digest");
	if (request.modelChannel && (!Number.isSafeInteger(request.modelChannel.port) || request.modelChannel.port < 1 || request.modelChannel.port > 65535)) {
		throw new Error("invalid CompileJob model channel port");
	}
	const [source, staging, privateRoot] = await Promise.all([
		canonicalDirectory(request.sourceSnapshotRoot, "source snapshot"),
		canonicalDirectory(request.stagingRoot, "staging"),
		canonicalDirectory(request.privateRoot, "private sandbox root"),
	]);
	for (const [a, b] of [[source, staging], [source, privateRoot], [staging, privateRoot]]) {
		if (contains(a!, b!) || contains(b!, a!)) throw new Error("compile sandbox roots must be disjoint");
	}
	const privateStats = await stat(privateRoot);
	if ((privateStats.mode & 0o077) !== 0 || (process.getuid && privateStats.uid !== process.getuid())) {
		throw new Error("compile sandbox private root must be owned by the server and mode 0700");
	}
	const command = request.commandPath;
	if (!path.isAbsolute(command) || await realpath(command) !== command || contains(source, command) || contains(staging, command) || contains(privateRoot, command)) {
		throw new Error("reviewed CLI must be canonical and outside worker-writable roots");
	}
	const actualCommandSha256 = createHash("sha256").update(await readFile(command)).digest("hex");
	if (actualCommandSha256 !== request.commandSha256) throw new Error("reviewed CLI digest changed");
	const home = path.join(privateRoot, "home");
	const tmp = path.join(privateRoot, "tmp");
	await mkdir(home, { recursive: true, mode: 0o700 });
	await mkdir(tmp, { recursive: true, mode: 0o700 });
	for (const [value, name] of [[home, "compile HOME"], [tmp, "compile TMPDIR"]] as const) {
		await canonicalDirectory(value, name);
		if (((await stat(value)).mode & 0o077) !== 0) throw new Error(`${name} must be mode 0700`);
	}
	const quoted = (value: string) => JSON.stringify(value);
	// Native Codex resume canonicalizes its rollout path component by component.
	// It needs metadata lookup on the private root itself before reaching home/.
	const ancestors = [...new Set([privateRoot, ...[source, staging, privateRoot, command].flatMap(literalAncestors)])]
		.sort((a, b) => a.length - b.length)
		.map((parent) => `(literal ${quoted(parent)})`).join(" ");
	// Codex checks the managed system requirements path on startup even when
	// the file is absent. Grant only that policy lookup, never the /etc tree.
	const codexRequirements = [
		"/etc", "/etc/codex", "/etc/codex/requirements.toml",
		"/private/etc", "/private/etc/codex", "/private/etc/codex/requirements.toml",
	].map((entry) => `(literal ${quoted(entry)})`).join(" ");
	const profile = `(version 1)\n(deny default)\n`
		+ `(allow process-fork)\n`
		+ `(allow process-exec (subpath "/bin") (subpath "/usr/bin") (literal ${quoted(command)}))\n`
		+ `(allow file-read* ${ancestors} ${codexRequirements} (subpath "/bin") (subpath "/usr/bin") (subpath "/usr/lib") (subpath "/System/Library") (literal ${quoted(command)}) (subpath ${quoted(source)}) (subpath ${quoted(staging)}) (subpath ${quoted(home)}) (subpath ${quoted(tmp)}) (literal "/dev/null"))\n`
		+ `(allow file-write* (subpath ${quoted(staging)}) (subpath ${quoted(home)}) (subpath ${quoted(tmp)}) (literal "/dev/null"))\n`
		+ (request.modelChannel ? `(allow network-outbound (remote tcp ${quoted(`localhost:${request.modelChannel.port}`)}))\n` : "")
		+ `(allow sysctl-read)\n`;
	const sandboxProfilePath = path.join(privateRoot, "compile.sb");
	try { await writeFile(sandboxProfilePath, profile, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(sandboxProfilePath, "utf8") !== profile) {
			throw new Error("CompileJob sandbox profile already exists with different authority");
		}
	}
	return {
		jobId: request.jobId,
		stagingRoot: staging,
		commandPath: command,
		commandSha256: request.commandSha256,
		sandboxProfilePath,
		sandboxProfileSha256: createHash("sha256").update(profile).digest("hex"),
		...(request.modelChannel ? { modelChannel: { port: request.modelChannel.port } } : {}),
		env: { PATH: "/usr/bin:/bin", HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
	};
}
