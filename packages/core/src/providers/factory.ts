import type { Environment } from '../config/load.js';
import { DEFAULT_EMBEDDING_MODELS, EMBEDDING_PROVIDERS } from '../config/schema.js';
import type { EmbeddingConfig, EmbeddingProviderName, InstanceConfig } from '../config/schema.js';
import { ChatbotError } from '../errors.js';
import { DEFAULT_MODEL_CACHE_DIR, createLocalEmbeddingProvider } from './local-embeddings.js';
import type { PipelineFactory } from './local-embeddings.js';
import { createMockEmbeddingProvider } from './mock-embeddings.js';
import type { EmbeddingProvider } from './types.js';

function isProviderName(value: string): value is EmbeddingProviderName {
  return (EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The embedding settings in effect: the instance's own, unless `EMBEDDING_PROVIDER` selects
 * another provider, which then runs with its default model. The override lets CI and offline
 * development use `mock` without editing instance files; an index built one way can only be
 * served the same way, which the server checks against the active version.
 */
export function resolveEmbeddingConfig(config: EmbeddingConfig, env: Environment): EmbeddingConfig {
  const requested = env.EMBEDDING_PROVIDER?.trim() ?? '';
  if (requested === '' || requested === config.provider) return config;
  if (!isProviderName(requested)) {
    throw new ChatbotError(
      'invalid_config',
      `EMBEDDING_PROVIDER must be one of ${EMBEDDING_PROVIDERS.join(', ')}, got "${requested}"`,
    );
  }
  return { ...config, provider: requested, model: DEFAULT_EMBEDDING_MODELS[requested] };
}

/**
 * Creates the embedding provider for an instance, after applying `EMBEDDING_PROVIDER` (see
 * {@link resolveEmbeddingConfig}). `MODEL_CACHE_DIR` sets where the local model is cached.
 */
export function createEmbeddingProvider(
  env: Environment,
  instance: Pick<InstanceConfig, 'embedding'>,
  options: { pipelineFactory?: PipelineFactory } = {},
): EmbeddingProvider {
  const config = resolveEmbeddingConfig(instance.embedding, env);
  if (config.provider === 'mock') return createMockEmbeddingProvider({ model: config.model });
  const cacheDir = env.MODEL_CACHE_DIR?.trim();
  return createLocalEmbeddingProvider({
    model: config.model,
    cacheDir: cacheDir === undefined || cacheDir === '' ? DEFAULT_MODEL_CACHE_DIR : cacheDir,
    ...(options.pipelineFactory === undefined ? {} : { pipelineFactory: options.pipelineFactory }),
  });
}
