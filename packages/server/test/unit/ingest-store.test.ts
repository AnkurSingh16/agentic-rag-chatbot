import { describe, expect, it } from 'vitest';
import { createPostgresIngestStore } from '../../src/store/ingest-store.js';
import { FakeClient, type Responder } from './fake-client.js';

const VERSION = '11111111-2222-4333-8444-555555555555';
const HASH = 'a'.repeat(64);

function storeWith(respond: Responder = () => []) {
  const client = new FakeClient(respond);
  const store = createPostgresIngestStore({ connect: () => Promise.resolve(client) });
  // The transaction helper's BEGIN, context and COMMIT statements are not under test here.
  const work = () =>
    client.calls.filter(
      (call) =>
        !call.text.startsWith('BEGIN') &&
        !call.text.includes('set_config') &&
        call.text !== 'COMMIT' &&
        call.text !== 'ROLLBACK',
    );
  return { client, store, work };
}

function databaseError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const versionRow = {
  id: VERSION,
  status: 'ready',
  embedding_provider: 'fake',
  embedding_model: 'fake-hash-v1',
  embedding_dimensions: 1024,
  chunker_hash: HASH,
  config_hash: HASH,
  document_count: 2,
  chunk_count: 3,
  created_at: new Date('2026-11-01T00:00:00Z'),
  activated_at: null,
  eval_id: null,
  eval_provider: null,
  eval_model: null,
  eval_passed: null,
  eval_created_at: null,
};

describe('createPostgresIngestStore', () => {
  it('runs each call in the instance context with an empty tag list', async () => {
    const { client, store } = storeWith();
    await store.ensureInstance('help');
    expect(client.calls[1]?.values).toEqual(['help', '_', '', '']);
    expect(client.calls[2]?.text).toContain('ON CONFLICT DO NOTHING');
    expect(client.texts().at(-1)).toBe('COMMIT');
  });

  it('creates a building version and returns its id', async () => {
    const { store, work } = storeWith((text) =>
      text.includes('RETURNING id') ? [{ id: VERSION }] : [],
    );
    const id = await store.createIndexVersion('help', {
      embeddingProvider: 'fake',
      embeddingModel: 'fake-hash-v1',
      embeddingDimensions: 1024,
      chunkerHash: HASH,
      configHash: HASH,
    });
    expect(id).toBe(VERSION);
    expect(work()[0]?.values).toEqual(['help', 'fake', 'fake-hash-v1', 1024, HASH, HASH]);
  });

  it('fails when an insert returns no row', async () => {
    const { store } = storeWith();
    await expect(
      store.createIndexVersion('help', {
        embeddingProvider: 'fake',
        embeddingModel: 'm',
        embeddingDimensions: 1024,
        chunkerHash: HASH,
        configHash: HASH,
      }),
    ).rejects.toMatchObject({ code: 'internal' });
    await expect(
      store.recordEvalRun('help', VERSION, {
        embeddingProvider: 'fake',
        embeddingModel: 'm',
        passed: true,
        metrics: {},
      }),
    ).rejects.toMatchObject({ code: 'internal' });
    await expect(
      store.insertDocument(
        'help',
        VERSION,
        {
          sourceUri: 'a.md',
          title: 'A',
          contentSha256: HASH,
          tenantKey: '_',
          accessTags: ['public'],
        },
        [],
      ),
    ).rejects.toMatchObject({ code: 'internal', message: 'Document a.md was not created' });
  });

  it('inserts a document and its chunks in batches of 100 with vector literals', async () => {
    const { store, work } = storeWith((text) =>
      text.includes('INSERT INTO rag.documents') ? [{ id: 'doc-1' }] : [],
    );
    const chunks = Array.from({ length: 150 }, (_, ordinal) => ({
      ordinal,
      headingPath: ['A', 'B'],
      content: `chunk ${ordinal}`,
      embedding: [0.5, -0.25],
    }));
    await store.insertDocument(
      'help',
      VERSION,
      {
        sourceUri: 'a.md',
        title: 'A',
        contentSha256: HASH,
        tenantKey: '_',
        accessTags: ['public'],
      },
      chunks,
    );
    const [document, first, second] = work();
    expect(document?.values).toEqual(['help', VERSION, 'a.md', 'A', HASH, '_', ['public']]);
    expect(first?.values).toHaveLength(900);
    expect(second?.values).toHaveLength(450);
    expect(first?.text).toContain('($1, $2, $3, $4, $5, $6, $7::vector, $8, $9)');
    expect(second?.values?.slice(0, 9)).toEqual([
      'help',
      VERSION,
      'doc-1',
      100,
      ['A', 'B'],
      'chunk 100',
      '[0.5,-0.25]',
      '_',
      ['public'],
    ]);
  });

  it('looks up cached embeddings and parses pgvector text', async () => {
    const { store, work } = storeWith(() => [
      { content_sha256: HASH, embedding: '[1,0.5,-2e-05]' },
    ]);
    const found = await store.findCachedEmbeddings('help', 'fake-hash-v1', [HASH]);
    expect(found).toEqual(new Map([[HASH, [1, 0.5, -0.00002]]]));
    expect(work()[0]?.values).toEqual(['help', 'fake-hash-v1', [HASH]]);
  });

  it('skips the query for an empty lookup', async () => {
    const { store, work } = storeWith();
    expect(await store.findCachedEmbeddings('help', 'm', [])).toEqual(new Map());
    expect(work()).toEqual([]);
  });

  it('caches embeddings in batches and ignores existing entries', async () => {
    const { store, work } = storeWith();
    const entries = Array.from({ length: 101 }, (_, i) => ({
      contentSha256: i.toString(16).padStart(64, '0'),
      embedding: [i],
    }));
    await store.cacheEmbeddings('help', 'm', entries);
    expect(work().map((call) => call.values?.length)).toEqual([400, 4]);
    expect(work()[0]?.text).toContain('ON CONFLICT DO NOTHING');
    expect(work()[1]?.values).toEqual(['help', 'm', entries[100]?.contentSha256, '[100]']);
  });

  it('marks a building version ready and refuses any other', async () => {
    let updated = 1;
    const client = new FakeClient((text) =>
      text.startsWith('UPDATE') ? Array.from({ length: updated }, () => ({})) : [],
    );
    const store = createPostgresIngestStore({ connect: () => Promise.resolve(client) });
    await store.markReady('help', VERSION, { documents: 2, chunks: 3 });
    expect(client.calls.find((c) => c.text.startsWith('UPDATE'))?.values).toEqual([VERSION, 2, 3]);
    updated = 0;
    await expect(store.markReady('help', VERSION, { documents: 2, chunks: 3 })).rejects.toThrow(
      'is not building and cannot be marked ready',
    );
  });

  it('deletes a version that is not active and reports one it could not delete', async () => {
    let deleted = 1;
    const client = new FakeClient((text) =>
      text.startsWith('DELETE') ? Array.from({ length: deleted }, () => ({})) : [],
    );
    const store = createPostgresIngestStore({ connect: () => Promise.resolve(client) });
    await store.deleteVersion('help', VERSION);
    deleted = 0;
    await expect(store.deleteVersion('help', VERSION)).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('records eval runs with metrics as JSON', async () => {
    const { store, work } = storeWith(() => [{ id: 'eval-1' }]);
    const id = await store.recordEvalRun('help', VERSION, {
      embeddingProvider: 'fake',
      embeddingModel: 'm',
      passed: false,
      metrics: { recallAt8: 0.5 },
    });
    expect(id).toBe('eval-1');
    expect(work()[0]?.values).toEqual(['help', VERSION, 'fake', 'm', false, '{"recallAt8":0.5}']);
  });

  it('activates through the database function and returns the previous version', async () => {
    const { store, work } = storeWith(() => [{ previous: 'old' }]);
    const forced = { force: true, reason: 'demo', operator: 'ankur' };
    expect(await store.activate('help', VERSION, forced)).toBe('old');
    expect(work()[0]).toEqual({
      text: 'SELECT rag.activate_index_version($1, $2, $3, $4, $5) AS previous',
      values: ['help', VERSION, true, 'demo', 'ankur'],
    });
    const none = storeWith(() => [{ previous: null }]);
    const gated = { force: false, reason: undefined, operator: 'ankur' };
    expect(await none.store.activate('help', VERSION, gated)).toBeNull();
    expect(none.work()[0]?.values).toEqual(['help', VERSION, false, null, 'ankur']);
  });

  it('maps activation errors to not_found and invalid_input', async () => {
    const respond = (error: Error) => (text: string) =>
      text.includes('activate_index_version') ? error : [];
    const request = { force: false, reason: undefined, operator: 'o' };
    const missing = storeWith(respond(databaseError('P0002', 'index version does not exist')));
    await expect(missing.store.activate('help', VERSION, request)).rejects.toMatchObject({
      code: 'not_found',
      message: 'index version does not exist',
    });
    const building = storeWith(respond(databaseError('55000', 'index version is building')));
    await expect(building.store.activate('help', VERSION, request)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    const gate = storeWith(
      respond(databaseError('55000', 'eval gate: index version has no eval run')),
    );
    await expect(gate.store.activate('help', VERSION, request)).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'eval gate: index version has no eval run',
    });
    const noReason = storeWith(
      respond(databaseError('22023', 'forced activation requires a reason')),
    );
    await expect(noReason.store.activate('help', VERSION, request)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    const denied = storeWith(respond(databaseError('42501', 'permission denied')));
    await expect(denied.store.activate('help', VERSION, request)).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it('lists versions newest first with their latest eval run', async () => {
    const evalDate = new Date('2026-11-02T00:00:00Z');
    const { store, work } = storeWith(() => [
      {
        ...versionRow,
        eval_id: 'eval-1',
        eval_provider: 'fake',
        eval_model: 'fake-hash-v1',
        eval_passed: true,
        eval_created_at: evalDate,
      },
      versionRow,
    ]);
    const versions = await store.listVersions('help');
    expect(work()[0]?.text).toContain('ORDER BY v.created_at DESC, v.id DESC');
    expect(versions[0]).toEqual({
      id: VERSION,
      status: 'ready',
      embeddingProvider: 'fake',
      embeddingModel: 'fake-hash-v1',
      embeddingDimensions: 1024,
      chunkerHash: HASH,
      configHash: HASH,
      documentCount: 2,
      chunkCount: 3,
      createdAt: versionRow.created_at,
      activatedAt: null,
      latestEval: {
        id: 'eval-1',
        embeddingProvider: 'fake',
        embeddingModel: 'fake-hash-v1',
        passed: true,
        createdAt: evalDate,
      },
    });
    expect(versions[1]?.latestEval).toBeNull();
  });

  it('reads one version, and treats a malformed id as unknown without querying', async () => {
    const { store, work } = storeWith((text) =>
      text.includes('v.id = $2') ? [{ ...versionRow, eval_id: 'e', eval_passed: null }] : [],
    );
    expect((await store.getVersion('help', VERSION))?.latestEval).toEqual({
      id: 'e',
      embeddingProvider: '',
      embeddingModel: '',
      passed: false,
      createdAt: versionRow.created_at,
    });
    expect(await store.getVersion('help', 'not-a-uuid')).toBeUndefined();
    expect(work()).toHaveLength(1);

    const empty = storeWith();
    expect(await empty.store.getVersion('help', VERSION)).toBeUndefined();
  });
});
