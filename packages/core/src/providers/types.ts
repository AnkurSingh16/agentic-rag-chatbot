import type { EmbeddingProviderName } from '../config/schema.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  system: string;
  messages: readonly ChatMessage[];
  maxOutputTokens: number;
  /** Aborted when the client disconnects or the turn deadline passes (ADR 0005). */
  signal: AbortSignal;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Text arrives in `text` events; the stream ends with exactly one `done` event carrying usage. */
export type ChatStreamEvent = { type: 'text'; text: string } | { type: 'done'; usage: TokenUsage };

/** A chat model that streams its answer. Implementations wrap provider errors in ChatbotError. */
export interface ChatModelProvider {
  readonly provider: string;
  generate(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
}

/** Turns texts into vectors. One vector per input text, in input order. */
export interface EmbeddingProvider {
  readonly provider: EmbeddingProviderName;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], signal: AbortSignal): Promise<number[][]>;
}

export interface RerankCandidate {
  content: string;
}

/** Reorders retrieved chunks by relevance to the query (ADR 0006). */
export interface Reranker {
  rerank<T extends RerankCandidate>(
    query: string,
    candidates: readonly T[],
    signal: AbortSignal,
  ): Promise<T[]>;
}
