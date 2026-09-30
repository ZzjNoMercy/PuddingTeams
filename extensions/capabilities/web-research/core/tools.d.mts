import type { SearchState } from './service.mjs';
export function createTools(options: {stateFor: () => Promise<SearchState>; transport?: unknown}): unknown[];
