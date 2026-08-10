import { test } from "node:test";
import assert from "node:assert";
import { nativeDirectoryPickerCommand, pickNativeDirectory } from "./native-directory-picker.js";

test("原生目录选择器：macOS 使用 Finder choose folder 并正确转义路径", () => {
	const command = nativeDirectoryPickerCommand("darwin", '/Users/pet/A "quoted" folder');
	assert.equal(command.command, "osascript");
	assert.ok(command.args.join(" ").includes("choose folder"));
	assert.ok(command.args.join(" ").includes('A \\"quoted\\" folder'));
});

test("原生目录选择器：Windows 使用 STA FolderBrowserDialog", () => {
	const command = nativeDirectoryPickerCommand("win32", "C:\\Users\\O'Brien\\Code");
	assert.equal(command.command, "powershell.exe");
	assert.ok(command.args.includes("-STA"));
	assert.ok(command.args.at(-1)?.includes("FolderBrowserDialog"));
	assert.ok(command.args.at(-1)?.includes("O''Brien"));
});

test("原生目录选择器：返回选择结果并把用户取消归一为 undefined", async () => {
	const selected = await pickNativeDirectory("/tmp", {
		platform: "darwin",
		runner: async () => ({ code: 0, stdout: "/tmp/project/\n", stderr: "" }),
	});
	assert.equal(selected, "/tmp/project/");

	const cancelled = await pickNativeDirectory("C:\\", {
		platform: "win32",
		runner: async () => ({ code: 2, stdout: "", stderr: "" }),
	});
	assert.equal(cancelled, undefined);

	const macCancelled = await pickNativeDirectory("/tmp", {
		platform: "darwin",
		runner: async () => ({ code: 1, stdout: "", stderr: "execution error: User canceled. (-128)" }),
	});
	assert.equal(macCancelled, undefined);
});
