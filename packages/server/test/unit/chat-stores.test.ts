import { describe, expect, it } from 'vitest';
import { RETRIEVAL } from '@agentic-rag/core';
import { createPostgresChatStore } from '../../src/store/chat-store.js';
import { createPostgresRetrievalStore } from '../../src/store/retrieval-store.js';
import { FakeClient, type Responder } from './fake-client.js';

const CONVERSATION = '11111111-2222-4333-8444-555555555555';
const OWNER = { instanceId: 'help', ownerKey: 'o'.repeat(64) };
const ACCESS = { instanceId: 'help', tenantKey: '_', accessTags: ['public'] };

function connected(respond: Responder) {
  const client = new FakeClient(respond);
  const pool = { connect: () => Promise.resolve(client) };
  const work = () =>
    client.calls.filter(
      (call) =>
        !call.text.startsWith('BEGIN') &&
        !call.text.includes('set_config') &&
        call.text !== 'COMMIT' &&
        call.text !== 'ROLLBACK',
    );
  return { client, pool, work };
}

describe('createPostgresRetrievalStore', () => {
  it('reads the active version under the caller access context', async () => {
    const { client, pool } = connected((text) =>
      text.includes('active_index_version_id')
        ? [{ id: 'v1', embedding_provider: 'mock', embedding_model: 'mock-hash-v1' }]
        : [],
    );
    const store = createPostgresRetrievalStore(pool);
    expect(await store.activeVersion(ACCESS)).toEqual({
      id: 'v1',
      embeddingProvider: 'mock',
      embeddingModel: 'mock-hash-v1',
    });
    expect(client.calls[1]?.values).toEqual(['help', '_', 'public', '']);

    const empty = createPostgresRetrievalStore(connected(() => []).pool);
    expect(await empty.activeVersion(ACCESS)).toBeUndefined();
  });

  it('runs one hybrid statement per query with the ADR 0006 settings', async () => {
    const row = {
      id: 'chunk-1',
      source_uri: 'data/a.md',
      title: 'A',
      heading_path: ['A'],
      content: 'A\n\nText.',
      score: 0.03,
    };
    const { pool, work } = connected((text) =>
      text.includes('websearch_to_tsquery') ? [row] : [],
    );
    const store = createPostgresRetrievalStore(pool);
    const lists = await store.search(ACCESS, 'v1', [
      { text: 'first', embedding: [0.5, 0.5], limit: 8 },
      { text: 'second', embedding: [1, 0], limit: 16 },
    ]);
    expect(lists).toEqual([
      [
        {
          chunkId: 'chunk-1',
          sourceUri: 'data/a.md',
          title: 'A',
          headingPath: ['A'],
          content: 'A\n\nText.',
          score: 0.03,
        },
      ],
      [expect.objectContaining({ chunkId: 'chunk-1' })],
    ]);
    const calls = work();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.values).toEqual([
      'help',
      'v1',
      'first',
      '[0.5,0.5]',
      RETRIEVAL.candidates,
      RETRIEVAL.maxVectorDistance,
      RETRIEVAL.rrfK,
      RETRIEVAL.minFusedScore,
      8,
    ]);
    expect(calls[1]?.values?.[8]).toBe(16);
  });
});

describe('createPostgresChatStore', () => {
  it('creates a conversation and counts the owner turns', async () => {
    const { pool, work } = connected((text) => {
      if (text.includes('count(*)')) return [{ turns: 3 }];
      if (text.includes('INSERT INTO rag.conversations')) return [{ id: CONVERSATION }];
      return [];
    });
    const store = createPostgresChatStore(pool);
    expect(await store.openConversation(OWNER)).toEqual({
      conversationId: CONVERSATION,
      history: [],
      turns: 3,
    });
    expect(work()[1]?.values).toEqual(['help', OWNER.ownerKey, '1 day']);
  });

  it('loads an owned conversation with history that starts with a user turn', async () => {
    const { pool } = connected((text) => {
      if (text.includes('count(*)')) return [{ turns: 1 }];
      if (text.includes('SELECT 1 FROM rag.conversations')) return [{ '?column?': 1 }];
      if (text.includes('FROM rag.messages')) {
        return [
          { role: 'assistant', content: 'older answer' },
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'a' },
        ];
      }
      return [];
    });
    const store = createPostgresChatStore(pool);
    const opened = await store.openConversation(OWNER, CONVERSATION);
    expect(opened.history).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]);
  });

  it('reports unknown, malformed and foreign conversation IDs as not found', async () => {
    const store = createPostgresChatStore(
      connected((text) => (text.includes('count(*)') ? [{ turns: 0 }] : [])).pool,
    );
    await expect(store.openConversation(OWNER, CONVERSATION)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(store.openConversation(OWNER, 'not-a-uuid')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('appends the user message before the answer', async () => {
    const { pool, work } = connected(() => []);
    await createPostgresChatStore(pool).appendTurn(OWNER, CONVERSATION, 'question', 'answer');
    expect(work().map((call) => call.values?.slice(3))).toEqual([
      ['user', 'question'],
      ['assistant', 'answer'],
    ]);
  });

  it('consumes usage and maps an untrained instance to not_found', async () => {
    const { pool, work } = connected(() => [
      { counter_scope: 'instance', total_tokens: '10', total_requests: '2' },
      { counter_scope: null, total_tokens: '99', total_requests: '7' },
    ]);
    const store = createPostgresChatStore(pool);
    expect(
      await store.consumeUsage('help', ['ip:1.2.3.4', 'instance'], { tokens: 5, requests: 1 }),
    ).toEqual([
      { scope: 'instance', tokens: 10, requests: 2 },
      { scope: null, tokens: 99, requests: 7 },
    ]);
    expect(work()[0]?.values).toEqual([['ip:1.2.3.4', 'instance'], 5, 1]);

    const missing = createPostgresChatStore(
      connected((text) =>
        text.includes('consume_usage') ? Object.assign(new Error('fk'), { code: '23503' }) : [],
      ).pool,
    );
    await expect(
      missing.consumeUsage('help', ['instance'], { tokens: 0, requests: 1 }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    const broken = createPostgresChatStore(
      connected((text) => (text.includes('consume_usage') ? new Error('down') : [])).pool,
    );
    await expect(
      broken.consumeUsage('help', ['instance'], { tokens: 0, requests: 1 }),
    ).rejects.toMatchObject({
      code: 'internal',
    });
  });
});
