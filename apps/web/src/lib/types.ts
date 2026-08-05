// Types shared by the chat UI. The server forwards pi session events as JSON;
// we define structural subsets here so the UI never depends on pi packages.

export interface SessionSummary {
	id: string;
	sessionFile: string;
	firstMessage: string;
	modifiedAt: string;
	active: boolean;
}

export interface ModelSummary {
	/** Opaque reference: `${provider}/${modelId}` — pass back to set/create. */
	id: string;
	name: string;
	provider: string;
}

export interface ProviderSummary {
	id: string;
	name: string;
	modelCount: number;
	configured: boolean;
	oauth: boolean;
}

// ---- pi event subset (as received over the WS) ----

export interface PiTextBlock {
	type: "text";
	text: string;
}

export interface PiThinkingBlock {
	type: "thinking";
	thinking: string;
}

export interface PiToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export type PiContentBlock = PiTextBlock | PiThinkingBlock | PiToolCallBlock;

export interface PiUserMessage {
	role: "user";
	content: string | PiContentBlock[];
	timestamp?: number;
}

export interface PiAssistantMessage {
	role: "assistant";
	content: PiContentBlock[];
	timestamp?: number;
}

export interface PiToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: PiContentBlock[];
	isError: boolean;
	timestamp?: number;
}

export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

export type PiEvent =
	| { type: "session_ready"; sessionId: string }
	| { type: "error"; message: string }
	| { type: "agent_start" }
	| { type: "turn_start" }
	| { type: "turn_end"; message: PiAssistantMessage; toolResults: PiToolResultMessage[] }
	| { type: "message_start"; message: PiMessage }
	| { type: "message_update"; message: PiAssistantMessage; assistantMessageEvent: unknown }
	| { type: "message_end"; message: PiMessage }
	| {
			type: "tool_execution_start";
			toolCallId: string;
			toolName: string;
			args: unknown;
	  }
	| {
			type: "tool_execution_end";
			toolCallId: string;
			toolName: string;
			result: unknown;
			isError: boolean;
	  }
	| { type: "agent_end"; messages: PiMessage[]; willRetry: boolean }
	| { type: "agent_settled" }
	| { type: string; [key: string]: unknown };

// ---- chat model ----

export type ToolCallStatus = "pending" | "running" | "done" | "error";

export interface ToolCallView {
	id: string;
	name: string;
	args?: unknown;
	status: ToolCallStatus;
	result?: string;
	isError?: boolean;
}

export type ChatMessageRole = "user" | "assistant" | "toolResult";

export interface ChatMessage {
	id: string;
	role: ChatMessageRole;
	content: string;
	thinking?: string;
	toolCalls: ToolCallView[];
	timestamp: number;
	streaming: boolean;
	error?: boolean;
	name?: string;
	isError?: boolean;
}

export type ChatStatus = "idle" | "connecting" | "connected" | "reconnecting" | "error";
