import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activateVersion,
  createMockChatModel,
  createMockEmbeddingProvider,
  loadInstanceConfig,
  parseEvalSet,
  runRetrievalEval,
  train,
} from '@agentic-rag/core';
import type { InstanceConfig } from '@agentic-rag/core';
import { createChatServer, createLogger } from '../../src/http/app.js';
import { createPostgresChatStore } from '../../src/store/chat-store.js';
import { createPostgresIngestStore } from '../../src/store/ingest-store.js';
import { migrate } from '../../src/store/migrate.js';
import { createPostgresRetrievalStore } from '../../src/store/retrieval-store.js';
import { withInstanceTransaction } from '../../src/store/transaction.js';
import { adminUrl, createPool, ingestUrl, rolePasswords, runtimeUrl } from './database.js';
import { uniqueInstanceId } from './database.js';

// The demo instance's documents and eval set, trained under a fresh instance ID with mock
// embeddings, exercise retrieval and the chat API against real PostgreSQL.
const demoDir = fileURLToPath(new URL('../../../../instances/demo/', import.meta.url));
const runtime = createPool(runtimeUrl, 4);
const ingestPool = createPool(ingestUrl);
const embeddings = createMockEmbeddingProvider();
const instanceId = uniqueInstanceId('chat');
let config: InstanceConfig;
let versionId: string;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await migrate(admin, rolePasswords);
  } finally {
    await admin.end();
  }
  const yaml = (await readFile(`${demoDir}instance.yaml`, 'utf8')).replace(
    'id: demo',
    `id: ${instanceId}`,
  );
  const loaded = loadInstanceConfig(yaml, {});
  config = {
    ...loaded.config,
    embedding: { provider: 'mock', model: embeddings.model, dimensions: 384 },
  };
  const store = createPostgresIngestStore(ingestPool);
  const trained = await train({
    config,
    configHash: loaded.configHash,
    sources: { baseDir: demoDir, fetch: () => Promise.reject(new Error('no network')) },
    store,
    embeddings,
    signal: new AbortController().signal,
  });
  versionId = trained.versionId;
});

afterAll(async () => {
  await Promise.all([runtime.end(), ingestPool.end()]);
});

const access = () => ({ instanceId, tenantKey: '_', accessTags: ['public'] });

async function search(text: string, tags = ['public'], id = instanceId) {
  const [embedding = []] = await embeddings.embed([text], new AbortController().signal);
  const store = createPostgresRetrievalStore(runtime);
  const [results = []] = await store.search(
    { instanceId: id, tenantKey: '_', accessTags: tags },
    versionId,
    [{ text, embedding, limit: 8 }],
  );
  return results;
}

describe('hybrid retrieval', () => {
  it('passes the demo eval set and records the run so the version can be activated', async () => {
    const evalSet = parseEvalSet(await readFile(`${demoDir}evals.yaml`, 'utf8'));
    const result = await runRetrievalEval({
      evalSet,
      access: access(),
      versionId,
      embeddings,
      retrieval: createPostgresRetrievalStore(ingestPool),
      signal: new AbortController().signal,
    });
    expect(result.recallAt8).toBeGreaterThanOrEqual(0.6);
    expect(result.passed).toBe(true);
    const store = createPostgresIngestStore(ingestPool);
    await store.recordEvalRun(instanceId, versionId, {
      embeddingProvider: embeddings.provider,
      embeddingModel: embeddings.model,
      passed: result.passed,
      metrics: { recallAt8: result.recallAt8 },
    });
    await activateVersion({ store, instanceId, versionId, operator: 'test', log: () => undefined });
    expect(await createPostgresRetrievalStore(runtime).activeVersion(access())).toEqual({
      id: versionId,
      embeddingProvider: 'mock',
      embeddingModel: 'mock-hash-v1',
    });
  });

  it('ranks the matching document first, by keyword and by meaning', async () => {
    const results = await search('What happens if I edit the same note on two devices?');
    expect(results[0]?.sourceUri).toBe('data/sync.md');
    expect(results.length).toBeLessThanOrEqual(8);
    const scores = results.map((result) => result.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect((await search('conflict'))[0]?.sourceUri).toBe('data/sync.md');
  });

  it('returns nothing for unrelated text, other tags or another instance', async () => {
    expect(await search('zzzz qqqq xxxx')).toEqual([]);
    expect(await search('How does sync work?', ['private'])).toEqual([]);
    expect(await search('How does sync work?', ['public'], uniqueInstanceId('other'))).toEqual([]);
  });
});

describe('chat API against PostgreSQL', () => {
  function app() {
    return createChatServer({
      instances: [config],
      retrieval: createPostgresRetrievalStore(runtime),
      chatStore: createPostgresChatStore(runtime),
      chatModel: createMockChatModel(),
      embeddings: new Map([[instanceId, embeddings]]),
      models: new Map([[instanceId, { chat: 'claude-haiku-5-5', router: 'claude-haiku-5-5' }]]),
      sessionSecret: 'integration-session-secret-0123456789',
      logger: createLogger({ level: 'silent' }),
    });
  }

  it('streams a cited answer, stores the turn and counts usage', async () => {
    const server = app();
    const session = await server.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/session`,
    });
    const token = session.json<{ token: string }>().token;
    const response = await server.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/chat`,
      headers: { 'x-session-token': token },
      payload: { message: 'How long does it take for changes to sync?' },
    });
    const events = response.body
      .split('\n\n')
      .filter((frame) => frame.startsWith('event: '))
      .map((frame) => {
        const [event = '', data = ''] = frame.split('\n');
        return {
          event: event.slice(7),
          data: JSON.parse(data.slice(6)) as Record<string, unknown>,
        };
      });
    const meta = events[0]?.data as { conversationId: string; indexVersion: string };
    expect(meta.indexVersion).toBe(versionId);
    const citations = events
      .filter((event) => event.event === 'citation')
      .map((event) => event.data);
    expect(citations.map((citation) => citation.sourceUri)).toContain('data/sync.md');
    expect(events.at(-1)).toMatchObject({ event: 'final', data: { state: 'ANSWERED' } });

    const follow = await server.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/chat`,
      headers: { 'x-session-token': token, accept: 'application/json' },
      payload: { message: 'thanks', conversationId: meta.conversationId },
    });
    expect(follow.json()).toMatchObject({ conversationId: meta.conversationId, state: 'ANSWERED' });

    const ownerKey = createHash('sha256')
      .update(`session:${token.split('.')[2] ?? ''}`)
      .digest('hex');
    const stored = await withInstanceTransaction(
      runtime,
      { instanceId, tenantKey: '_', accessTags: [], ownerKey },
      async (client) => {
        const messages = await client.query<{ role: string }>(
          'SELECT role FROM rag.messages ORDER BY created_at, id',
        );
        const usage = await client.query<{ scope: string; tokens: string; requests: string }>(
          "SELECT scope, tokens, requests FROM rag.usage_counters WHERE scope = 'instance'",
        );
        return { roles: messages.rows.map((row) => row.role), usage: usage.rows[0] };
      },
    );
    expect(stored.roles).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(Number(stored.usage?.requests)).toBe(2);
    expect(Number(stored.usage?.tokens)).toBeGreaterThan(0);

    const otherSession = await server.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/session`,
    });
    const foreign = await server.inject({
      method: 'POST',
      url: `/v1/instances/${instanceId}/chat`,
      headers: {
        'x-session-token': otherSession.json<{ token: string }>().token,
        accept: 'application/json',
      },
      payload: { message: 'hi', conversationId: meta.conversationId },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('keeps one session out of another session conversation over HTTP', async () => {
    const server = app();
    const tokenOf = async () =>
      (await server.inject({ method: 'POST', url: `/v1/instances/${instanceId}/session` })).json<{
        token: string;
      }>().token;
    const ownerKeyOf = (token: string) =>
      createHash('sha256')
        .update(`session:${token.split('.')[2] ?? ''}`)
        .digest('hex');
    const post = (token: string, payload: Record<string, string>) =>
      server.inject({
        method: 'POST',
        url: `/v1/instances/${instanceId}/chat`,
        headers: { 'x-session-token': token, accept: 'application/json' },
        payload,
      });

    const tokenA = await tokenOf();
    const tokenB = await tokenOf();
    const started = await post(tokenA, { message: 'How do I export notes?' });
    const { conversationId } = started.json<{ conversationId: string }>();

    const intruding = await post(tokenB, { message: 'What did we talk about?', conversationId });
    expect(intruding.statusCode).toBe(404);
    expect(intruding.json()).toEqual({ error: { code: 'not_found', retryable: false } });

    const visible = (ownerKey: string) =>
      withInstanceTransaction(
        runtime,
        { instanceId, tenantKey: '_', accessTags: [], ownerKey },
        async (client) => {
          const conversations = await client.query(
            'SELECT id FROM rag.conversations WHERE id = $1',
            [conversationId],
          );
          const messages = await client.query<{ content: string }>(
            'SELECT content FROM rag.messages WHERE conversation_id = $1 ORDER BY created_at',
            [conversationId],
          );
          return { conversations: conversations.rowCount, messages: messages.rows };
        },
      );
    expect(await visible(ownerKeyOf(tokenB))).toEqual({ conversations: 0, messages: [] });
    const own = await visible(ownerKeyOf(tokenA));
    expect(own.conversations).toBe(1);
    expect(own.messages.map((row) => row.content)[0]).toBe('How do I export notes?');
    expect(own.messages).toHaveLength(2);
  });
});
