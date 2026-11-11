import { basename, dirname, resolve } from 'node:path';
import { ChatbotError, createEmbeddingProvider, train } from '@agentic-rag/core';
import type { SourceAccess, SourceConfig } from '@agentic-rag/core';
import type { CliContext } from '../context.js';
import { checkInstanceId, loadInstance, withIngestStore } from '../context.js';

export async function trainCommand(
  context: CliContext,
  positionals: readonly string[],
  options: { instancesDir: string; source: string | undefined },
): Promise<void> {
  if (positionals.length > 1) {
    throw new ChatbotError('invalid_input', 'Usage: ragctl train <id> [--source <folder>]');
  }
  const id = checkInstanceId(positionals[0]);
  const instance = await loadInstance(context, options.instancesDir, id);
  const embeddings = createEmbeddingProvider(context.env, instance.config);

  let sources: readonly SourceConfig[] = instance.config.sources;
  let access: SourceAccess = { baseDir: instance.directory, fetch: context.fetch };
  if (options.source !== undefined) {
    // Source URIs stay relative to the folder's parent, so a folder named like the configured
    // one (e.g. data/) keeps the URIs the eval set refers to.
    const folder = resolve(context.cwd, options.source);
    sources = [{ type: 'folder', path: basename(folder) }];
    access = { baseDir: dirname(folder), fetch: context.fetch };
  }

  const result = await withIngestStore(context, ({ store }) =>
    train({
      config: {
        ...instance.config,
        sources: [...sources],
        embedding: {
          ...instance.config.embedding,
          provider: embeddings.provider,
          model: embeddings.model,
        },
      },
      configHash: instance.configHash,
      sources: access,
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
  documents ${result.documents}, chunks ${result.chunks} (${result.embeddedChunks} embedded, ${result.reusedChunks} reused from cache), embeddings ${embeddings.provider}/${embeddings.model}${pruned}
Evaluate it with "ragctl eval ${id} ${result.versionId}", then activate it with "ragctl activate ${id} ${result.versionId}".
`);
}
