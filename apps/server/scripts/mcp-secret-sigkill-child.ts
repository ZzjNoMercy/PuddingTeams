import { CredentialsStore } from "../src/store/credentials.js";
import { McpServerStore } from "../src/store/mcp-servers.js";
import path from "node:path";

const [home, operation, phase] = process.argv.slice(2);
if (!home || !["create", "update", "delete"].includes(operation) ||
	(phase !== "before-catalog" && phase !== "after-catalog")) throw new Error("home, operation and phase required");
const credentials = new CredentialsStore(path.join(home, "secrets", "mcp"));
await credentials.init();
const store = new McpServerStore(path.join(home, "config"), credentials);
if (operation !== "create") {
	await store.create({ id: "docs", displayName: "Old", definition: { command: "server" }, secrets: { API_TOKEN: "old-token" } });
}

const writable = store as unknown as { write: (data: unknown) => Promise<void> };
const original = writable.write.bind(store);
writable.write = async (data) => {
	if (phase === "before-catalog") process.kill(process.pid, "SIGKILL");
	await original(data);
	process.kill(process.pid, "SIGKILL");
};
if (operation === "create") {
	await store.create({ id: "docs", displayName: "New", definition: { command: "server" }, secrets: { API_TOKEN: "new-token" } });
} else if (operation === "update") {
	await store.update("docs", { displayName: "New", definition: { command: "server" }, secrets: { API_TOKEN: "new-token" } });
} else {
	await store.remove("docs");
}
throw new Error("SIGKILL interception did not run");
