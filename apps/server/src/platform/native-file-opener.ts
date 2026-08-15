import { spawn } from "node:child_process";

export interface NativeFileOpenCommand {
	command: string;
	args: string[];
}

export interface NativeFileOpenResult {
	code: number | null;
	stderr: string;
}

export type NativeFileOpenRunner = (
	command: string,
	args: string[],
) => Promise<NativeFileOpenResult>;

function escapePowerShellString(value: string): string {
	return value.replaceAll("'", "''");
}

export function nativeFileOpenCommand(
	platform: NodeJS.Platform,
	targetPath: string,
): NativeFileOpenCommand {
	if (platform === "darwin") return { command: "open", args: [targetPath] };
	if (platform === "linux") return { command: "xdg-open", args: [targetPath] };
	if (platform === "win32") {
		return {
			command: "powershell.exe",
			args: [
				"-NoProfile",
				"-Command",
				`Invoke-Item -LiteralPath '${escapePowerShellString(targetPath)}'`,
			],
		};
	}
	throw new Error(`当前平台不支持打开本地文件：${platform}`);
}

const runNativeFileOpen: NativeFileOpenRunner = (command, args) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stderr }));
	});

export async function openNativeFile(
	targetPath: string,
	options: {
		platform?: NodeJS.Platform;
		runner?: NativeFileOpenRunner;
	} = {},
): Promise<void> {
	const spec = nativeFileOpenCommand(options.platform ?? process.platform, targetPath);
	const result = await (options.runner ?? runNativeFileOpen)(spec.command, spec.args);
	if (result.code !== 0) {
		throw new Error(result.stderr.trim() || `系统文件打开器退出：${result.code ?? "unknown"}`);
	}
}
