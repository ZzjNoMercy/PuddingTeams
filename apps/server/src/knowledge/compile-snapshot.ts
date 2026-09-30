import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

/** Inspect the exact materialized input tree. Links and special files are not
 * snapshot content: they could make a frozen Job read bytes outside its root. */
export async function inspectCompileSnapshot(root: string): Promise<{
	hash: string;
	entries: Array<["directory" | "file", string, string?]>;
}> {
	if (!path.isAbsolute(root) || await realpath(root) !== root || !(await lstat(root)).isDirectory()) {
		throw new Error("CompileJob source snapshot must be a canonical directory");
	}
	const entries: Array<["directory" | "file", string, string?]> = [];
	const walk = async (directory: string, prefix: string): Promise<void> => {
		const children = (await readdir(directory)).sort();
		for (const name of children) {
			const absolute = path.join(directory, name);
			const relative = prefix ? `${prefix}/${name}` : name;
			const before = await lstat(absolute);
			if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) {
				throw new Error(`CompileJob source snapshot contains a link or special file: ${relative}`);
			}
			if (before.isDirectory()) {
				if (await realpath(absolute) !== absolute) throw new Error(`CompileJob source snapshot directory changed: ${relative}`);
				entries.push(["directory", relative]);
				await walk(absolute, relative);
				continue;
			}
			if (before.nlink !== 1) throw new Error(`CompileJob source snapshot contains a hard link: ${relative}`);
			const fileHash = createHash("sha256");
			const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				if ((await handle.stat()).ino !== before.ino) throw new Error(`CompileJob source snapshot changed before read: ${relative}`);
				for await (const chunk of handle.createReadStream({ autoClose: false })) fileHash.update(chunk as Buffer);
			} finally { await handle.close(); }
			const after = await lstat(absolute);
			if (!after.isFile() || after.ino !== before.ino || after.size !== before.size ||
				after.mtimeMs !== before.mtimeMs || after.nlink !== 1) {
				throw new Error(`CompileJob source snapshot changed while hashing: ${relative}`);
			}
			entries.push(["file", relative, fileHash.digest("hex")]);
		}
	};
	await walk(root, "");
	return { hash: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), entries };
}

export async function fingerprintCompileSnapshot(root: string): Promise<string> {
	return (await inspectCompileSnapshot(root)).hash;
}
