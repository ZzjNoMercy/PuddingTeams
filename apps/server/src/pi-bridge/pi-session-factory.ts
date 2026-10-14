import { DefaultResourceLoader, SettingsManager, getAgentDir, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, PiManagerSettings, PiResourceConfig } from "../store/teams.js";
import type { WorkspaceResourceAccess } from "../store/workspaces.js";
import { appendPiPrompts, piResourceLoaderOptions } from "./pi-resources.js";
import { stripUnmanagedPiFff } from "./code-search.js";

export function piSessionOwner(agent: AgentConfig | undefined) {
 const manager = Boolean(agent?.pinned);
 const nativePi = manager || agent?.connector?.connectorId === "pi";
 const restricted = agent?.builtinId === "wiki";
 const config = agent?.connector?.config ?? {};
 const settings: PiManagerSettings = manager ? agent?.manager ?? {} : nativePi ? {
  model: typeof config.model === "string" ? config.model : undefined,
  thinkingLevel: config.thinkingLevel as PiManagerSettings["thinkingLevel"],
  builtinTools: !restricted && config.builtinTools !== false,
  noExtensions: restricted || config.noExtensions === true,
  codeSearch: agent?.codeSearch === "inherit" ? "builtin" : agent?.codeSearch,
 } : { builtinTools: false, noExtensions: true };
 const provider = nativePi ? { id:"pi-native", busyInput:["followUp","steer"], snapshotImport:manager ? undefined : {formatVersion:1 as const} } : undefined;
 return { provider, agent, role: manager ? "manager" as const : "worker" as const, nativePi, restricted, settings, resources: nativePi ? agent?.piResources : undefined };
}

/** All host decisions are explicit; this factory never discovers a Manager. */
export async function piSessionResourceLoader(input: {
 cwd: string; settings?: PiManagerSettings; resources?: PiResourceConfig;
 workspaceAccess?: WorkspaceResourceAccess; factories: InlineExtension[]; guidance?: string; restricted?: boolean;
}) {
 const agentDir = getAgentDir();
 const loader = new DefaultResourceLoader({
  cwd: input.cwd, agentDir, settingsManager: SettingsManager.create(input.cwd, agentDir),
  ...piResourceLoaderOptions(input.resources, input.cwd, agentDir, input.workspaceAccess),
  extensionFactories: input.factories,
  ...(input.settings?.noExtensions ? { noExtensions: true } : {}),
  ...(input.restricted ? { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
   settingsManager: SettingsManager.inMemory(), additionalSkillPaths: [], additionalPromptTemplatePaths: [],
   agentsFilesOverride: () => ({ agentsFiles: [] }), skillsOverride: () => ({ skills: [], diagnostics: [] }),
   promptsOverride: () => ({ prompts: [], diagnostics: [] }), systemPromptOverride: () => undefined } : {}),
  extensionsOverride: stripUnmanagedPiFff,
  appendSystemPromptOverride: base => input.restricted ? [input.guidance ?? ""] : appendPiPrompts(base, input.resources, input.guidance),
 });
 await loader.reload();
 return loader;
}
