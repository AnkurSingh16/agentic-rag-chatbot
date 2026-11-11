import type { InstanceConfig } from '../config/schema.js';
import type { Environment } from '../config/load.js';
import { ChatbotError } from '../errors.js';
import { createAnthropicChatModel } from './anthropic.js';
import type { AnthropicClientLike } from './anthropic.js';
import { createMockChatModel } from './mock.js';
import type { ChatModel } from './types.js';

/** The model used when neither the instance nor LLM_MODEL names one (ADR 0008). */
export const DEFAULT_CHAT_MODEL = 'claude-haiku-5-5';

function setting(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Creates the chat model selected by `LLM_PROVIDER`: `mock` (the default) or `anthropic`, which
 * needs `ANTHROPIC_API_KEY`. The key is read from the given environment only, which the app
 * loads from its `.env` file.
 *
 * @throws ChatbotError `invalid_config` for an unknown provider or a missing key.
 */
export function createChatModel(
  env: Environment,
  options: { anthropicClient?: AnthropicClientLike } = {},
): ChatModel {
  const provider = setting(env, 'LLM_PROVIDER') ?? 'mock';
  if (provider === 'mock') return createMockChatModel();
  if (provider !== 'anthropic') {
    throw new ChatbotError(
      'invalid_config',
      `LLM_PROVIDER must be mock or anthropic, got "${provider}"`,
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

/** The answer and routing models for an instance: its own setting, then LLM_MODEL, then the default. */
export function resolveChatModels(
  config: Pick<InstanceConfig, 'models'>,
  env: Environment,
): { chat: string; router: string } {
  const chat = config.models.chat ?? setting(env, 'LLM_MODEL') ?? DEFAULT_CHAT_MODEL;
  return { chat, router: config.models.router ?? chat };
}
