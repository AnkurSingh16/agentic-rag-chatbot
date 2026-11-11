export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A tool the model may call. `inputSchema` is a JSON Schema object. */
export interface ChatTool {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
}

export interface ChatRequest {
  model: string;
  /** Instructions; sent as its own cached block so repeated turns reuse it (ADR 0008). */
  system: string;
  /** Retrieved chunks; sent as a second cached block. Empty when there is no context. */
  context: string;
  messages: readonly ChatMessage[];
  maxOutputTokens: number;
  tools?: readonly ChatTool[];
  /** Forces a call to the named tool. Without it the model decides. */
  toolChoice?: string;
  /** Aborted when the client disconnects or the turn deadline passes (ADR 0005). */
  signal: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * Text arrives in `text` events and tool calls as complete `tool_use` events. The stream ends
 * with exactly one `done` event carrying usage.
 */
export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'done'; usage: TokenUsage };

export type ChatProviderName = 'mock' | 'anthropic';

/** A chat model that streams its answer. Implementations wrap provider errors in ChatbotError. */
export interface ChatModel {
  readonly provider: ChatProviderName;
  generate(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

export const ZERO_USAGE: Readonly<TokenUsage> = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
