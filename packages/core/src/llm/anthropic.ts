import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageCreateParamsStreaming,
  RawMessageStreamEvent,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { ChatbotError } from '../errors.js';
import type { ChatModel, ChatRequest, ChatStreamEvent, TokenUsage } from './types.js';

type StreamParams = Omit<MessageCreateParamsStreaming, 'stream'>;

/** The part of the SDK client this provider uses, so tests can inject a fake. */
export interface AnthropicClientLike {
  messages: {
    stream(
      params: StreamParams,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<RawMessageStreamEvent>;
  };
}

export interface AnthropicChatModelOptions {
  apiKey: string;
  client?: AnthropicClientLike;
}

const CACHED = { type: 'ephemeral' } as const;

function toParams(request: ChatRequest): StreamParams {
  // Two cache breakpoints: the system prompt alone is reused by the routing call and by every
  // turn, and system plus context is reused by the verification retry (ADR 0008).
  const system: TextBlockParam[] = [{ type: 'text', text: request.system, cache_control: CACHED }];
  if (request.context !== '') {
    system.push({ type: 'text', text: request.context, cache_control: CACHED });
  }
  const params: StreamParams = {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    system,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  };
  if (request.tools !== undefined && request.tools.length > 0) {
    params.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: { type: 'object', ...tool.inputSchema },
    }));
    params.tool_choice =
      request.toolChoice === undefined
        ? { type: 'auto' }
        : { type: 'tool', name: request.toolChoice };
  }
  return params;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    return typeof error.status === 'number' ? error.status : undefined;
  }
  return undefined;
}

// The message never includes the API key: the SDK does not put it in error text.
function toProviderError(error: unknown): ChatbotError {
  const status = statusOf(error);
  const detail = error instanceof Error ? error.message : 'unknown error';
  if (status === 429) {
    return new ChatbotError('rate_limited', `Anthropic rate limit: ${detail}`, { cause: error });
  }
  if (status === 401 || status === 403) {
    return new ChatbotError(
      'invalid_config',
      `Anthropic rejected the API key (${status}); check ANTHROPIC_API_KEY in .env`,
      { cause: error },
    );
  }
  if (status === undefined || status >= 500) {
    return new ChatbotError('provider_unavailable', `Anthropic unavailable: ${detail}`, {
      cause: error,
    });
  }
  return new ChatbotError('internal', `Anthropic request failed (${status}): ${detail}`, {
    cause: error,
  });
}

function parseToolInput(json: string): unknown {
  if (json === '') return {};
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new ChatbotError('provider_unavailable', 'Anthropic returned malformed tool input', {
      cause: error,
    });
  }
}

/**
 * Calls Claude through the official SDK (ADR 0008). The system prompt and the retrieved context
 * are sent as separate blocks marked for prompt caching, and usage includes cache reads and
 * writes. SDK errors become ChatbotError: 429 `rate_limited`, 401 and 403 `invalid_config`, 5xx
 * and network failures `provider_unavailable`.
 */
export function createAnthropicChatModel(options: AnthropicChatModelOptions): ChatModel {
  const client: AnthropicClientLike =
    options.client ?? new Anthropic({ apiKey: options.apiKey, maxRetries: 1 });
  return {
    provider: 'anthropic',
    async *generate(request): AsyncGenerator<ChatStreamEvent> {
      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const tools = new Map<number, { name: string; json: string }>();
      try {
        const stream = client.messages.stream(toParams(request), { signal: request.signal });
        for await (const event of stream) {
          switch (event.type) {
            case 'message_start': {
              const start = event.message.usage;
              usage.inputTokens = start.input_tokens;
              usage.outputTokens = start.output_tokens;
              usage.cacheReadTokens = start.cache_read_input_tokens ?? 0;
              usage.cacheWriteTokens = start.cache_creation_input_tokens ?? 0;
              break;
            }
            case 'content_block_start':
              if (event.content_block.type === 'tool_use') {
                tools.set(event.index, { name: event.content_block.name, json: '' });
              }
              break;
            case 'content_block_delta':
              if (event.delta.type === 'text_delta') {
                yield { type: 'text', text: event.delta.text };
              } else if (event.delta.type === 'input_json_delta') {
                const tool = tools.get(event.index);
                if (tool !== undefined) tool.json += event.delta.partial_json;
              }
              break;
            case 'content_block_stop': {
              const tool = tools.get(event.index);
              if (tool !== undefined) {
                tools.delete(event.index);
                yield { type: 'tool_use', name: tool.name, input: parseToolInput(tool.json) };
              }
              break;
            }
            case 'message_delta': {
              // Delta usage is cumulative for the whole message.
              const delta = event.usage;
              usage.outputTokens = delta.output_tokens;
              usage.inputTokens = delta.input_tokens ?? usage.inputTokens;
              usage.cacheReadTokens = delta.cache_read_input_tokens ?? usage.cacheReadTokens;
              usage.cacheWriteTokens = delta.cache_creation_input_tokens ?? usage.cacheWriteTokens;
              break;
            }
            case 'message_stop':
              break;
          }
        }
      } catch (error) {
        if (error instanceof ChatbotError) throw error;
        // A deadline or client disconnect is reported by the caller, not as a provider failure.
        if (request.signal.aborted) throw request.signal.reason;
        throw toProviderError(error);
      }
      yield { type: 'done', usage };
    },
  };
}
