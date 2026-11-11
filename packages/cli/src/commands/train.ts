import { ChatbotError, createFakeEmbeddingProvider, train } from '@agentic-rag/core';
import type { EmbeddingProvider, InstanceConfig } from '@agentic-rag/core';
import type { CliContext } from '../context.js';
import { checkInstanceId, loadInstance, withIngestStore } from '../context.js';

// Only the fake provider exists so far; voyage and ollama clients are planned (ADR 0006).
function embeddingProvider(context: CliContext, config: InstanceConfig): EmbeddingProvider {
  const configured = config.embedding.provider;
  const fromEnv = context.env.EMBEDDING_PROVIDER;
  const requested = fromEnv === undefined || fromEnv === '' ? configured : fromEnv;
  if (requested !== configured) {
    throw new ChatbotError(
      'invalid_config',
      `EMBEDDING_PROVIDER is "${requested}" but instance "${config.id}" is configured for "${configured}"`,
    );
  }
  if (requested !== 'fake') {
    throw new ChatbotError(
      'invalid_config',
      `The ${requested} embedding provider is not implemented yet; only fake is available`,
    );
  }
  return createFakeEmbeddingProvider({ model: config.embedding.model });
}

export async function trainCommand(
  context: CliContext,
  positionals: readonly string[],
  instancesDir: string,
): Promise<void> {
  if (positionals.length > 1) {
    throw new ChatbotError('invalid_input', 'Usage: ragctl train <id>');
  }
  const id = checkInstanceId(positionals[0]);
  const instance = await loadInstance(context, instancesDir, id);
  const embeddings = embeddingProvider(context, instance.config);

  const result = await withIngestStore(context, (store) =>
    train({
      config: instance.config,
      configHash: instance.configHash,
      sources: { baseDir: instance.directory, fetch: context.fetch },
      store,
      embeddings,
      signal: context.signal,
      log: (message) => {
        context.stderr(`${message}\n`);
      },
    }),
  );

  const pruned =
    result.prunedVersions.length > 0
      ? `\nDeleted old versions: ${result.prunedVersions.join(', ')}`
      : '';
  context.stdout(`Trained ${id}: version ${result.versionId} is ready
  documents ${result.documents}, chunks ${result.chunks} (${result.embeddedChunks} embedded, ${result.reusedChunks} reused from cache)${pruned}
Activate it with "ragctl activate ${id} ${result.versionId}" once it has a passing eval run.
`);
}
