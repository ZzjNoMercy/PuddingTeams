export type ProviderId = 'tavily' | 'deepseek' | 'grok';
export interface ProviderConfig { enabled: boolean; model: string; searchDepth?: 'basic' | 'advanced'; webEnabled?: boolean; xEnabled?: boolean }
export interface WebConfig { enabled: boolean; fetchEnabled: boolean; defaultScope: 'domestic' | 'global'; fallbackEnabled: boolean; crossCheckEnabled: boolean; maxProviderAttempts: number; domesticOrder: ProviderId[]; globalOrder: ProviderId[]; proxyUrl: string; providers: Record<ProviderId, ProviderConfig> }
export interface ProviderTest { status: 'ready' | 'error'; checkedAt: string; message: string; fingerprint: string }
export interface SearchState { config: WebConfig; keys: Record<string,string>; tests: Partial<Record<ProviderId,ProviderTest>> }
export const PROVIDERS: ProviderId[];
export const PROVIDER_KEYS: Record<ProviderId,string>;
export const DEFAULT_CONFIG: WebConfig;
export class SearchError extends Error { category: string }
export function testProvider(provider: ProviderId, state: SearchState, signal?: AbortSignal, transport?: unknown): Promise<{sources: unknown[]}>;
