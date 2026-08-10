import { spawn } from "node:child_process";
import path from "node:path";

export interface NativePickerCommand {
	command: string;
	args: string[];
	cancelExitCodes: number[];
	cancelStderrMarkers?: string[];
}

export interface NativePickerProcessResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

export type NativePickerRunner = (command: string, args: string[]) => Promise<NativePickerProcessResult>;

function escapeAppleScriptString(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapePowerShellString(value: string): string {
	return value.replaceAll("'", "''");
}

export function nativeDirectoryPickerCommand(platform: NodeJS.Platform, initialPath: string): NativePickerCommand {
	if (platform === "darwin") {
		const initial = escapeAppleScriptString(initialPath);
		return {
			command: "osascript",
			args: [
				"-e",
				`set chosenFolder to choose folder with prompt "选择项目文件夹" default location POSIX file "${initial}"`,
				"-e",
				"POSIX path of chosenFolder",
			],
			cancelExitCodes: [],
			cancelStderrMarkers: ["-128", "User canceled"],
		};
	}

	if (platform === "win32") {
		const initial = escapePowerShellString(initialPath);
		const script = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
			"$dialog.Description = '选择项目文件夹'",
			`$dialog.SelectedPath = '${initial}'`,
			"if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath); exit 0 }",
			"exit 2",
		].join("; ");
		return {
			command: "powershell.exe",
			args: ["-NoProfile", "-STA", "-Command", script],
			cancelExitCodes: [2],
		};
	}

	if (platform === "linux") {
		return {
			command: "zenity",
			args: ["--file-selection", "--directory", `--filename=${initialPath.endsWith(path.sep) ? initialPath : `${initialPath}${path.sep}`}`],
			cancelExitCodes: [1],
		};
	}

	throw new Error(`当前平台不支持系统目录选择器：${platform}`);
}

const runNativePicker: NativePickerRunner = (command, args) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, { windowsHide: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout, stderr }));
	});

export async function pickNativeDirectory(
	initialPath: string,
	options: { platform?: NodeJS.Platform; runner?: NativePickerRunner } = {},
): Promise<string | undefined> {
	const spec = nativeDirectoryPickerCommand(options.platform ?? process.platform, initialPath);
	const result = await (options.runner ?? runNativePicker)(spec.command, spec.args);
	if (result.code === 0) {
		const selected = result.stdout.trim();
		if (!selected) throw new Error("系统目录选择器没有返回路径");
		return selected;
	}
	if (spec.cancelStderrMarkers?.some((marker) => result.stderr.includes(marker))) return undefined;
	if (result.code !== null && spec.cancelExitCodes.includes(result.code)) return undefined;
	throw new Error(result.stderr.trim() || `系统目录选择器退出：${result.code ?? "unknown"}`);
}
