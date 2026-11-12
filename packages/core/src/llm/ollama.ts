import { totalmem } from 'node:os';
import { ChatbotError } from '../errors.js';
import type { ChatModel, ChatRequest, ChatStreamEvent, TokenUsage } from './types.js';

export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
/** Longest silence between two streamed chunks before the request is abandoned. */
export const OLLAMA_DEFAULT_IDLE_TIMEOUT_MS = 120_000;

const SIXTEEN_GIB = 16 * 1024 ** 3;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '[::1]', '::1']);

/** The model used when OLLAMA_MODEL is unset, chosen by the machine's memory (docs/local-setup.md). */
export function recommendedOllamaModel(totalMemoryBytes: number): string {
  return totalMemoryBytes >= SIXTEEN_GIB ? 'qwen2.5:7b' : 'llama3.2:3b';
}

/** `OLLAMA_MODEL`, or the recommended model for this machine. */
export function ollamaModelName(env: Record<string, string | undefined>): string {
  const configured = env.OLLAMA_MODEL?.trim();
  return configured === undefined || configured === ''
    ? recommendedOllamaModel(totalmem())
    : configured;
}

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.startsWith('127.');
}

/**
 * Checks `OLLAMA_BASE_URL` and returns it without a trailing slash. Only loopback addresses are
 * accepted unless `allowRemote` is set, so a prompt never leaves the machine by accident.
 *
 * @throws ChatbotError `invalid_config` for a non-HTTP URL or a remote host without `allowRemote`.
 */
export function ollamaBaseUrl(value: string, allowRemote: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ChatbotError('invalid_config', `OLLAMA_BASE_URL is not a URL: "${value}"`, {
      cause: error,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ChatbotError('invalid_config', 'OLLAMA_BASE_URL must start with http:// or https://');
  }
  if (!allowRemote && !isLoopback(url.hostname)) {
    throw new ChatbotError(
      'invalid_config',
      `OLLAMA_BASE_URL points to ${url.hostname}, which is not a loopback address. ` +
        'Set OLLAMA_ALLOW_REMOTE=true to allow it.',
    );
  }
  return value.replace(/\/+$/, '');
}

/** The `fetch` the provider calls; tests replace it. */
export type OllamaFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface OllamaChatModelOptions {
  /** Already validated with {@link ollamaBaseUrl}. */
  baseUrl: string;
  model: string;
  idleTimeoutMs?: number;
  fetch?: OllamaFetch;
}

interface OllamaToolCall {
  function?: { name?: unknown; arguments?: unknown };
}

interface OllamaChunk {
  error?: unknown;
  message?: { content?: unknown; tool_calls?: OllamaToolCall[] };
  done?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
}

// Ollama has no forced tool choice, so `toolChoice` is not sent. The graph copes with a missing
// tool call by treating the question as knowledge (agent/run-chat.ts).
function toBody(request: ChatRequest, model: string) {
  // Ollama takes one system message, so the instructions and the retrieved documents share it.
  const system = [request.system, request.context].filter((part) => part !== '').join('\n\n');
  const body: Record<string, unknown> = {
    model,
    stream: true,
    messages: [
      { role: 'system', content: system },
      ...request.messages.map((message) => ({ role: message.role, content: message.content })),
    ],
    options: { num_predict: request.maxOutputTokens, temperature: 0.2 },
  };
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: { type: 'object', ...tool.inputSchema },
      },
    }));
  }
  return body;
}

function toolArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new ChatbotError('provider_unavailable', 'Ollama returned malformed tool arguments', {
      cause: error,
    });
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : response.statusText;
  } catch {
    return response.statusText;
  }
}

async function requestFailure(response: Response, model: string): Promise<ChatbotError> {
  const detail = await errorDetail(response);
  if (response.status === 404 && /not found/i.test(detail)) {
    return new ChatbotError(
      'invalid_config',
      `Ollama does not have the model "${model}". Run: ollama pull ${model}`,
    );
  }
  if (response.status >= 500) {
    return new ChatbotError(
      'provider_unavailable',
      `Ollama failed (${response.status}): ${detail}`,
    );
  }
  return new ChatbotError('internal', `Ollama request failed (${response.status}): ${detail}`);
}

/**
 * Calls a local Ollama server over its HTTP API (`POST /api/chat`, streamed as newline-delimited
 * JSON). Usage comes from `prompt_eval_count` and `eval_count`; Ollama reports no cache counts, so
 * they are zero. A connection failure says how to start Ollama, and a model that is not pulled
 * says which `ollama pull` to run.
 */
export function createOllamaChatModel(options: OllamaChatModelOptions): ChatModel {
  const fetchFn: OllamaFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const idleTimeoutMs = options.idleTimeoutMs ?? OLLAMA_DEFAULT_IDLE_TIMEOUT_MS;

  return {
    provider: 'ollama',
    async *generate(request): AsyncGenerator<ChatStreamEvent> {
      request.signal.throwIfAborted();
      const model = request.model;
      const controller = new AbortController();
      const abortFromCaller = () => {
        controller.abort(request.signal.reason);
      };
      request.signal.addEventListener('abort', abortFromCaller, { once: true });
      let idle: ReturnType<typeof setTimeout> | undefined;
      const armIdleTimer = () => {
        clearTimeout(idle);
        idle = setTimeout(() => {
          controller.abort(
            new ChatbotError(
              'provider_unavailable',
              `Ollama sent nothing for ${idleTimeoutMs / 1000} seconds`,
            ),
          );
        }, idleTimeoutMs);
      };

      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        armIdleTimer();
        let response: Response;
        try {
          response = await fetchFn(`${options.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(toBody(request, model)),
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          throw new ChatbotError(
            'provider_unavailable',
            `Ollama is not reachable at ${options.baseUrl}. Start it with "brew services start ollama" ` +
              'or run "ollama serve", then try again.',
            { cause: error },
          );
        }
        if (!response.ok) throw await requestFailure(response, model);
        if (response.body === null) {
          throw new ChatbotError('provider_unavailable', 'Ollama sent an empty response');
        }

        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = '';
        let usage: TokenUsage | undefined;

        const handle = function* (line: string): Generator<ChatStreamEvent> {
          if (line.trim() === '') return;
          const chunk = JSON.parse(line) as OllamaChunk;
          if (chunk.error !== undefined) {
            const detail =
              typeof chunk.error === 'string' ? chunk.error : JSON.stringify(chunk.error);
            throw new ChatbotError('provider_unavailable', `Ollama error: ${detail}`);
          }
          const text = chunk.message?.content;
          if (typeof text === 'string' && text !== '') yield { type: 'text', text };
          for (const call of chunk.message?.tool_calls ?? []) {
            const name = call.function?.name;
            if (typeof name === 'string') {
              yield { type: 'tool_use', name, input: toolArguments(call.function?.arguments) };
            }
          }
          if (chunk.done === true) {
            usage = {
              inputTokens: numberOrZero(chunk.prompt_eval_count),
              outputTokens: numberOrZero(chunk.eval_count),
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            };
          }
        };

        for (;;) {
          const { value, done } = await reader.read();
          armIdleTimer();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let newline = pending.indexOf('\n');
          while (newline !== -1) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            yield* handle(line);
            newline = pending.indexOf('\n');
          }
        }
        pending += decoder.decode();
        yield* handle(pending);

        if (usage === undefined) {
          throw new ChatbotError('provider_unavailable', 'Ollama ended the response early');
        }
        yield { type: 'done', usage };
      } catch (error) {
        if (error instanceof ChatbotError) throw error;
        if (controller.signal.aborted) throw controller.signal.reason;
        throw new ChatbotError('provider_unavailable', 'Ollama stream failed', { cause: error });
      } finally {
        clearTimeout(idle);
        request.signal.removeEventListener('abort', abortFromCaller);
        await reader?.cancel().catch(() => undefined);
      }
    },
  };
}
