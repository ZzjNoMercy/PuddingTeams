/** Host-neutral HTTP + NDJSON transport for code-based Connector Drivers. */

export type HttpJsonlErrorCode =
	| "cancelled"
	| "startup_timeout"
	| "timeout"
	| "connection_error"
	| "http_error"
	| "protocol_error"
	| "response_too_large";

export class HttpJsonlError extends Error {
	constructor(
		message: string,
		readonly code: HttpJsonlErrorCode,
		readonly status?: number,
		readonly responseBody?: string,
	) {
		super(message);
		this.name = "HttpJsonlError";
	}
}

export interface StreamHttpJsonlOptions {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: unknown;
	signal?: AbortSignal;
	startupMs?: number;
	timeoutMs?: number;
	maxBytes?: number;
	maxLineBytes?: number;
	onJsonLine?: (line: unknown) => void | Promise<void>;
}

export interface StreamHttpJsonlResult {
	status: number;
	lineCount: number;
	bytes: number;
	contentType: string;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

function safeTransportMessage(value: unknown): string {
	return String(value || "HTTP request failed")
		.replace(/authorization|bearer|token|secret|password|api[_-]?key/gi, "credential")
		.slice(0, 500);
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	while (true) {
		const next = await reader.read();
		if (next.done) break;
		bytes += next.value.byteLength;
		if (bytes > maxBytes) {
			await reader.cancel().catch(() => undefined);
			break;
		}
		text += decoder.decode(next.value, { stream: true });
	}
	return `${text}${decoder.decode()}`;
}

/**
 * POST/GET one streaming HTTP response and emit complete JSON values split by
 * newline. Network chunks are never exposed as protocol events. A legacy
 * single JSON response without a trailing newline is accepted as one line.
 */
export async function streamHttpJsonl(opts: StreamHttpJsonlOptions): Promise<StreamHttpJsonlResult> {
	const controller = new AbortController();
	let externallyAborted = false;
	let timeoutKind: "startup" | "active" | undefined;
	const abortFromCaller = () => {
		externallyAborted = true;
		controller.abort();
	};
	if (opts.signal?.aborted) abortFromCaller();
	else opts.signal?.addEventListener("abort", abortFromCaller, { once: true });

	const startupMs = opts.startupMs ?? 30_000;
	const timeoutMs = opts.timeoutMs ?? 900_000;
	const startupTimer = setTimeout(() => {
		timeoutKind = "startup";
		controller.abort();
	}, startupMs);
	const activeTimer = setTimeout(() => {
		timeoutKind = "active";
		controller.abort();
	}, timeoutMs);

	try {
		const response = await fetch(opts.url, {
			method: opts.method ?? "POST",
			redirect: "manual",
			signal: controller.signal,
			headers: {
				accept: "application/x-ndjson, application/json",
				...(opts.body === undefined ? {} : { "content-type": "application/json" }),
				...(opts.headers ?? {}),
			},
			...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
		});
		clearTimeout(startupTimer);
		if (!response.ok) {
			const responseBody = await readBoundedText(response, MAX_ERROR_BYTES);
			throw new HttpJsonlError(
				safeTransportMessage(responseBody || `HTTP ${response.status}`),
				"http_error",
				response.status,
				responseBody,
			);
		}
		if (!response.body) throw new HttpJsonlError("HTTP response has no body", "protocol_error", response.status);

		const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
		const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let bytes = 0;
		let lineCount = 0;

		const consumeLine = async (line: string) => {
			if (!line.trim()) return;
			if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
				throw new HttpJsonlError("HTTP JSONL line exceeds size limit", "response_too_large", response.status);
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				throw new HttpJsonlError("HTTP response contains invalid JSONL", "protocol_error", response.status);
			}
			lineCount += 1;
			await opts.onJsonLine?.(parsed);
		};

		while (true) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > maxBytes) {
				await reader.cancel().catch(() => undefined);
				throw new HttpJsonlError("HTTP response exceeds size limit", "response_too_large", response.status);
			}
			buffer += decoder.decode(next.value, { stream: true });
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";
			for (const line of lines) await consumeLine(line);
		}
		buffer += decoder.decode();
		await consumeLine(buffer);
		return {
			status: response.status,
			lineCount,
			bytes,
			contentType: response.headers.get("content-type") ?? "",
		};
	} catch (error) {
		if (error instanceof HttpJsonlError) throw error;
		if (externallyAborted) throw new HttpJsonlError("HTTP request cancelled", "cancelled");
		if (timeoutKind === "startup") throw new HttpJsonlError("HTTP stream startup timed out", "startup_timeout");
		if (timeoutKind === "active") throw new HttpJsonlError("HTTP stream timed out", "timeout");
		throw new HttpJsonlError(safeTransportMessage(error instanceof Error ? error.message : error), "connection_error");
	} finally {
		clearTimeout(startupTimer);
		clearTimeout(activeTimer);
		opts.signal?.removeEventListener("abort", abortFromCaller);
	}
}
