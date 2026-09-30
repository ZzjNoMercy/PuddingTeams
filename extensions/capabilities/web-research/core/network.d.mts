export interface NetworkResponse { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; url: string }
export interface RequestOptions { signal?: AbortSignal; proxy?: string; timeoutMs?: number; maxBytes?: number; method?: string; headers?: Record<string,string>; body?: string | Buffer; resolve?: (hostname: string, options: {all: boolean; verbatim: boolean}) => Promise<Array<{address: string;family: number}>> }
export function publicAddress(address: string): boolean;
export function publicURL(raw: string): URL;
export function resolvePublic(url: URL, resolve?: RequestOptions["resolve"]): Promise<{address:string;family:number}>;
export function proxyURL(raw?: string): URL | undefined;
export function requestURL(raw: string, options?: RequestOptions): Promise<NetworkResponse>;
