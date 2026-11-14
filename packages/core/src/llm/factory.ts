import type { InstanceConfig } from '../config/schema.js';
import type { Environment } from '../config/load.js';
import { ChatbotError } from '../errors.js';
import { createAnthropicChatModel } from './anthropic.js';
import type { AnthropicClientLike } from './anthropic.js';
import { createMockChatModel } from './mock.js';
import {
  OLLAMA_DEFAULT_BASE_URL,
  createOllamaChatModel,
  ollamaBaseUrl,
  ollamaModelName,
} from './ollama.js';
import type { OllamaFetch, OllamaSampling } from './ollama.js';
import type { ChatModel } from './types.js';

/** The model used when neither the instance nor LLM_MODEL names one (ADR 0008). */
export const DEFAULT_CHAT_MODEL = 'claude-haiku-5-5';

function setting(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Creates the chat model selected by `LLM_PROVIDER`: `mock` (the default), `anthropic`, which
 * needs `ANTHROPIC_API_KEY`, or `ollama`, a local model server (`OLLAMA_BASE_URL`, `OLLAMA_MODEL`).
 * The key is read from the given environment only, which the app loads from its `.env` file.
 *
 * @throws ChatbotError `invalid_config` for an unknown provider, a missing key or a remote Ollama
 *   address without `OLLAMA_ALLOW_REMOTE=true`.
 */
export function createChatModel(
  env: Environment,
  options: {
    anthropicClient?: AnthropicClientLike;
    ollamaFetch?: OllamaFetch;
    ollamaSampling?: OllamaSampling;
  } = {},
): ChatModel {
  const provider = setting(env, 'LLM_PROVIDER') ?? 'mock';
  if (provider === 'mock') return createMockChatModel();
  if (provider === 'ollama') {
    return createOllamaChatModel({
      baseUrl: ollamaBaseUrl(
        setting(env, 'OLLAMA_BASE_URL') ?? OLLAMA_DEFAULT_BASE_URL,
        setting(env, 'OLLAMA_ALLOW_REMOTE') === 'true',
      ),
      model: ollamaModelName(env),
      ...(options.ollamaFetch === undefined ? {} : { fetch: options.ollamaFetch }),
      ...(options.ollamaSampling === undefined ? {} : { sampling: options.ollamaSampling }),
    });
  }
  if (provider !== 'anthropic') {
    throw new ChatbotError(
      'invalid_config',
      `LLM_PROVIDER must be mock, anthropic or ollama, got "${provider}"`,
    );
  }
  const apiKey = setting(env, 'ANTHROPIC_API_KEY');
  if (apiKey === undefined) {
    throw new ChatbotError(
      'invalid_config',
      'LLM_PROVIDER=anthropic needs ANTHROPIC_API_KEY in the app .env file; use LLM_PROVIDER=mock to run without a key',
    );
  }
  return createAnthropicChatModel({
    apiKey,
    ...(options.anthropicClient === undefined ? {} : { client: options.anthropicClient }),
  });
}

/**
 * The answer and routing models for an instance: its own setting, then LLM_MODEL, then the default.
 * With `LLM_PROVIDER=ollama` the instance settings are Claude model names, so the model is always
 * OLLAMA_MODEL.
 */
export function resolveChatModels(
  config: Pick<InstanceConfig, 'models'>,
  env: Environment,
): { chat: string; router: string } {
  if (setting(env, 'LLM_PROVIDER') === 'ollama') {
    const model = ollamaModelName(env);
    return { chat: model, router: model };
  }
  const chat = config.models.chat ?? setting(env, 'LLM_MODEL') ?? DEFAULT_CHAT_MODEL;
  return { chat, router: config.models.router ?? chat };
}
