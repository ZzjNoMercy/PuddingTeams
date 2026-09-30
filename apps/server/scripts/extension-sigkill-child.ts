/** Isolated rehearsal child: SIGKILL after Extension registry commit, before Agent revision write. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import Fastify from "fastify";
import { ExtensionCatalog } from "../src/agent-runtime/extensions.js";
import { DriverRegistry } from "../src/agent-runtime/driver-registry.js";
import { ExtensionRegistry } from "../src/agent-runtime/extension-registry.js";
import { CredentialsStore } from "../src/store/credentials.js";
import { ExtensionMutationJournal } from "../src/store/extension-mutation-journal.js";
import { McpServerStore } from "../src/store/mcp-servers.js";
import { ProductSettingsStore } from "../src/store/product-settings.js";
import { TeamsStore } from "../src/store/teams.js";
import { registerExtensionsRoutes } from "../src/routes/extensions.js";

const home = process.argv[2];
if (!home || !path.isAbsolute(home)) throw new Error("absolute isolated home required");
await mkdir(path.join(home, "workspaces", "unscoped"), { recursive: true });
const source = path.join(home, "fixture-extension");
await mkdir(source, { recursive: true });
const manifestPath = path.join(source, "pudding-extension.json");
const manifest = (version: string) => ({
	id: "fixture-extension", publisher: "test", displayName: "Fixture Extension", version,
	source: "external", kind: "capability", engines: { puddingteams: ">=1 <2" }, entry: "index.mjs",
	capability: { id: "fixture-extension", displayName: "Fixture Extension", apiVersion: "1", tools: [{ name: "check", activation: "always" }] },
});
await writeFile(manifestPath, JSON.stringify(manifest("1.0.0")));
await writeFile(path.join(source, "index.mjs"), 'export const extension = { manifest: { id: "fixture-extension", kind: "capability", name: "Fixture", version: "1", tools: [{ name: "check", activation: "always" }] }, register() {} };');

const credentials = new CredentialsStore(path.join(home, "secrets"));
await credentials.init();
const mcpCredentials = new CredentialsStore(path.join(home, "secrets", "mcp"));
await mcpCredentials.init();
const mcpServers = new McpServerStore(path.join(home, "config"), mcpCredentials);
const teams = new TeamsStore({
	state: path.join(home, "state"), assets: path.join(home, "assets"),
	managedWorkspaces: path.join(home, "workspaces", "managed"),
}, path.join(home, "workspaces", "unscoped"), 900_000, credentials);
await teams.init();
const settings = new ProductSettingsStore(path.join(home, "config"));
await settings.setDeveloperMode(true);
const registry = new ExtensionRegistry(path.join(home, "extensions"), new ExtensionCatalog(), new DriverRegistry());
await registry.init({ developerMode: true });
await registry.install(source);
await teams.addCapabilityBinding("pi-b", { extensionId: "fixture-extension", capabilityId: "fixture-extension", enabled: true, config: {} });
await writeFile(manifestPath, JSON.stringify(manifest("1.0.1")));

const app = Fastify();
registerExtensionsRoutes(app, {
	registry, teams, settings, mcpServers,
	capabilityStateRoot: path.join(home, "secrets", "capabilities"),
	mutationJournal: new ExtensionMutationJournal(path.join(home, "state", "extension-mutation-pending.json")),
});
teams.bumpAgentRevision = async () => {
	process.kill(process.pid, "SIGKILL");
	await new Promise<never>(() => undefined);
};
await app.inject({ method: "POST", url: "/api/extensions/fixture-extension/update", payload: {} });
throw new Error("SIGKILL did not terminate the child");
