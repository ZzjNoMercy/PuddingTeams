import { test } from "node:test";
import assert from "node:assert";
import { nativeFileOpenCommand, openNativeFile } from "./native-file-opener.js";

test("系统文件打开器按平台生成不经 shell 拼接的命令", () => {
	assert.deepEqual(nativeFileOpenCommand("darwin", "/tmp/a b.py"), {
		command: "open",
		args: ["/tmp/a b.py"],
	});
	assert.deepEqual(nativeFileOpenCommand("linux", "/tmp/a b.py"), {
		command: "xdg-open",
		args: ["/tmp/a b.py"],
	});
	assert.deepEqual(nativeFileOpenCommand("win32", "C:\\work\\a'b.py"), {
		command: "powershell.exe",
		args: ["-NoProfile", "-Command", "Invoke-Item -LiteralPath 'C:\\work\\a''b.py'"],
	});
});

test("系统文件打开器向调用方暴露原生命令失败", async () => {
	await assert.rejects(
		openNativeFile("/tmp/missing", {
			platform: "darwin",
			runner: async () => ({ code: 1, stderr: "cannot open" }),
		}),
		/cannot open/,
	);
});
