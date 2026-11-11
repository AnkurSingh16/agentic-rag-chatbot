import pg from 'pg';
import {
  createChatModel,
  createEmbeddingProvider,
  resolveChatModels,
  toChatbotError,
} from '@agentic-rag/core';
import type { EmbeddingProvider } from '@agentic-rag/core';
import {
  createChatServer,
  createLogger,
  createPostgresChatStore,
  createPostgresRetrievalStore,
  verifyRuntimeRole,
} from '@agentic-rag/server';
import { loadInstances, readAppConfig } from './config.js';

const env = process.env;
const logger = createLogger({ level: env.LOG_LEVEL ?? 'info' });

try {
  const config = readAppConfig(env, process.cwd());
  if (config.sessionSecretGenerated) {
    logger.warn(
      'SESSION_SECRET is not set; using a random secret, so sessions end when the server restarts',
    );
  }
  const instances = await loadInstances(config, env);
  const chatModel = createChatModel(env);

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    application_name: 'rag-server',
  });
  await verifyRuntimeRole(pool);
  const retrieval = createPostgresRetrievalStore(pool);

  // One provider per model, so the local model is loaded once however many instances use it.
  const providers = new Map<string, EmbeddingProvider>();
  const embeddings = new Map<string, EmbeddingProvider>();
  const models = new Map<string, { chat: string; router: string }>();
  for (const instance of instances) {
    const candidate = createEmbeddingProvider(env, instance);
    const key = `${candidate.provider}/${candidate.model}`;
    const provider = providers.get(key) ?? candidate;
    providers.set(key, provider);
    embeddings.set(instance.id, provider);
    models.set(instance.id, resolveChatModels(instance, env));

    const access = { instanceId: instance.id, tenantKey: '_', accessTags: ['public'] };
    const active = await retrieval.activeVersion(access);
    if (active === undefined) {
      logger.warn(
        { instance: instance.id },
        'no active index version; chat returns not_found until one is activated',
      );
    } else if (
      active.embeddingProvider !== provider.provider ||
      active.embeddingModel !== provider.model
    ) {
      logger.warn(
        {
          instance: instance.id,
          index: `${active.embeddingProvider}/${active.embeddingModel}`,
          server: key,
        },
        'active index was built with other embeddings; retrain or change EMBEDDING_PROVIDER',
      );
    }
  }

  const app = createChatServer({
    instances,
    retrieval,
    chatStore: createPostgresChatStore(pool),
    chatModel,
    embeddings,
    models,
    sessionSecret: config.sessionSecret,
    trustedProxies: config.trustedProxies,
    logger,
  });
  const shutdown = () => {
    void app.close().then(() => pool.end());
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({ host: config.host, port: config.port });
  logger.info(
    {
      llmProvider: chatModel.provider,
      instances: instances.map((instance) => ({ id: instance.id, ...models.get(instance.id) })),
    },
    'chat server ready',
  );
} catch (error) {
  logger.fatal({ err: toChatbotError(error) }, 'server failed to start');
  process.exitCode = 1;
}
