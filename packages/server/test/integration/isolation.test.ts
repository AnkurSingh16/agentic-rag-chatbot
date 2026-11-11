import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/store/migrate.js';
import { withInstanceTransaction, type InstanceAccess } from '../../src/store/transaction.js';
import {
  activate,
  adminUrl,
  axisVector,
  createPool,
  createReadyVersion,
  failureOf,
  ingest,
  ingestUrl,
  rolePasswords,
  runtimeUrl,
  sqlState,
  uniqueInstanceId,
} from './database.js';

const runtime = createPool(runtimeUrl);
// One connection, so a test can reuse a session whose settings a previous transaction set.
const runtimeSingle = createPool(runtimeUrl, 1);
const ingestPool = createPool(ingestUrl);

const instanceA = uniqueInstanceId('iso-a');
const instanceB = uniqueInstanceId('iso-b');
let versionA = '';
let chunksA: Record<string, string> = {};

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await migrate(admin, rolePasswords);
  } finally {
    await admin.end();
  }

  const seededA = await createReadyVersion(ingestPool, instanceA, [
    {
      label: 'north-faq',
      tenantKey: 'north',
      accessTags: ['faq'],
      content: 'North FAQ: reset a password',
      axis: 1,
    },
    {
      label: 'south-faq',
      tenantKey: 'south',
      accessTags: ['faq'],
      content: 'South FAQ: billing cycles',
      axis: 2,
    },
    {
      label: 'north-internal',
      tenantKey: 'north',
      accessTags: ['internal'],
      content: 'North internal runbook',
      axis: 3,
    },
    {
      label: 'north-billing',
      tenantKey: 'north',
      accessTags: ['billing', 'finance'],
      content: 'North billing guide',
      axis: 4,
    },
    {
      label: 'public',
      tenantKey: '_',
      accessTags: ['public'],
      content: 'Public welcome page',
      axis: 5,
    },
  ]);
  versionA = seededA.versionId;
  chunksA = seededA.chunkIds;
  await activate(ingestPool, instanceA, versionA);

  // Instance B reuses A's public vector, so only RLS can keep it out of A's nearest neighbours.
  const seededB = await createReadyVersion(ingestPool, instanceB, [
    {
      label: 'public',
      tenantKey: '_',
      accessTags: ['public'],
      content: 'Instance B private pricing',
      axis: 5,
    },
  ]);
  await activate(ingestPool, instanceB, seededB.versionId);
});

afterAll(async () => {
  await Promise.all([runtime.end(), runtimeSingle.end(), ingestPool.end()]);
});

function visibleChunks(access: InstanceAccess, pool = runtime): Promise<string[]> {
  return withInstanceTransaction(pool, access, async (client) => {
    const result = await client.query<{ content: string }>(
      // The C collation keeps the order the same whatever the database locale is.
      'SELECT content FROM rag.chunks ORDER BY content COLLATE "C"',
    );
    return result.rows.map((row) => row.content);
  });
}

describe('corpus row-level security', () => {
  it('keeps each instance to its own documents and chunks', async () => {
    const publicA = { instanceId: instanceA, tenantKey: '_', accessTags: ['public'] };
    const publicB = { instanceId: instanceB, tenantKey: '_', accessTags: ['public'] };
    expect(await visibleChunks(publicA)).toEqual(['Public welcome page']);
    expect(await visibleChunks(publicB)).toEqual(['Instance B private pricing']);

    const documents = await withInstanceTransaction(runtime, publicA, (client) =>
      client.query<{ instance_id: string }>('SELECT instance_id FROM rag.documents'),
    );
    expect(documents.rows).toEqual([{ instance_id: instanceA }]);
  });

  it('matches the tenant exactly, so a shared tag does not cross tenants', async () => {
    const northFaq = { instanceId: instanceA, tenantKey: 'north', accessTags: ['faq'] };
    expect(await visibleChunks(northFaq)).toEqual(['North FAQ: reset a password']);
  });

  it('matches access tags on overlap', async () => {
    const northReader = {
      instanceId: instanceA,
      tenantKey: 'north',
      accessTags: ['faq', 'finance'],
    };
    expect(await visibleChunks(northReader)).toEqual([
      'North FAQ: reset a password',
      'North billing guide',
    ]);
    expect(await visibleChunks({ ...northReader, accessTags: ['unknown'] })).toEqual([]);
    expect(await visibleChunks({ ...northReader, accessTags: [] })).toEqual([]);
  });

  it('returns no rows when the access context is missing or incomplete', async () => {
    // A finished transaction leaves the settings defined but empty on this session.
    await visibleChunks(
      { instanceId: instanceA, tenantKey: '_', accessTags: ['public'] },
      runtimeSingle,
    );

    const client = await runtimeSingle.connect();
    try {
      await client.query('BEGIN');
      const counts = await client.query<Record<string, string>>(
        `SELECT (SELECT count(*) FROM rag.chunks) AS chunks,
                (SELECT count(*) FROM rag.documents) AS documents,
                (SELECT count(*) FROM rag.instances) AS instances,
                (SELECT count(*) FROM rag.index_versions) AS versions,
                (SELECT count(*) FROM rag.usage_global) AS usage_global`,
      );
      expect(counts.rows[0]).toEqual({
        chunks: '0',
        documents: '0',
        instances: '0',
        versions: '0',
        usage_global: '0',
      });

      await client.query(
        "SELECT set_config('rag.instance_id', $1, true), set_config('rag.access_tags', 'public', true)",
        [instanceA],
      );
      const withoutTenant = await client.query('SELECT 1 FROM rag.chunks');
      expect(withoutTenant.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('finds the nearest chunk through the HNSW index without crossing instances or tenants', async () => {
    const nearest = (access: InstanceAccess, axis: number) =>
      withInstanceTransaction(runtime, access, async (client) => {
        // A tiny table is cheaper to sort than to walk the graph; these make the planner use the
        // HNSW index so the test proves RLS filtering on its results.
        await client.query('SET LOCAL enable_seqscan = off');
        await client.query('SET LOCAL enable_sort = off');
        const sql = `SELECT id, content FROM rag.chunks WHERE index_version_id = $1
                     ORDER BY embedding <=> $2::vector LIMIT 1`;
        const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, [
          versionA,
          axisVector(axis),
        ]);
        const rows = await client.query<{ id: string; content: string }>(sql, [
          versionA,
          axisVector(axis),
        ]);
        return { plan: plan.rows.map((row) => row['QUERY PLAN']).join('\n'), row: rows.rows[0] };
      });

    const publicA = await nearest(
      { instanceId: instanceA, tenantKey: '_', accessTags: ['public'] },
      5,
    );
    expect(publicA.plan).toContain('chunks_embedding_hnsw');
    expect(publicA.row).toEqual({ id: chunksA.public, content: 'Public welcome page' });

    // The query vector is the south chunk's own embedding; a north reader still gets a north chunk.
    const northFaq = await nearest(
      { instanceId: instanceA, tenantKey: 'north', accessTags: ['faq'] },
      2,
    );
    expect(northFaq.row?.id).toBe(chunksA['north-faq']);
  });
});

describe('corpus write permissions', () => {
  it('denies the runtime role any corpus write', async () => {
    const access = { instanceId: instanceA, tenantKey: '_', accessTags: ['public'] };
    const insert = failureOf(
      withInstanceTransaction(runtime, access, (client) =>
        client.query(
          `INSERT INTO rag.documents (instance_id, index_version_id, source_uri, content_sha256, access_tags)
           VALUES ($1, $2, 'test://runtime', $3, '{public}')`,
          [instanceA, versionA, 'b'.repeat(64)],
        ),
      ),
    );
    expect(sqlState(await insert)).toBe('42501');

    const update = failureOf(
      withInstanceTransaction(runtime, access, (client) =>
        client.query("UPDATE rag.chunks SET content = 'changed' WHERE instance_id = $1", [
          instanceA,
        ]),
      ),
    );
    expect(sqlState(await update)).toBe('42501');
  });

  it('lets the ingest role write only into a version that is still building', async () => {
    const intoActive = failureOf(
      ingest(ingestPool, instanceA, (client) =>
        client.query(
          `INSERT INTO rag.documents (instance_id, index_version_id, source_uri, content_sha256, access_tags)
           VALUES ($1, $2, 'test://late', $3, '{public}')`,
          [instanceA, versionA, 'c'.repeat(64)],
        ),
      ),
    );
    expect(sqlState(await intoActive)).toBe('42501');

    const intoOtherInstance = failureOf(
      ingest(ingestPool, instanceA, (client) =>
        client.query('INSERT INTO rag.instances (id) VALUES ($1)', [uniqueInstanceId('iso-c')]),
      ),
    );
    expect(sqlState(await intoOtherInstance)).toBe('42501');
  });

  it('stops the ingest role from activating a version without the activation function', async () => {
    const { versionId } = await createReadyVersion(ingestPool, instanceA, [
      { label: 'extra', tenantKey: '_', accessTags: ['public'], content: 'Extra page', axis: 6 },
    ]);
    // A building version may become ready, never active.
    const direct = failureOf(
      ingest(ingestPool, instanceA, async (client) => {
        const building = await client.query<{ id: string }>(
          `INSERT INTO rag.index_versions
             (instance_id, embedding_provider, embedding_model, embedding_dimensions, chunker_hash, config_hash)
           VALUES ($1, 'fake', 'fake-1024', 1024, $2, $2) RETURNING id`,
          [instanceA, 'e'.repeat(64)],
        );
        return client.query("UPDATE rag.index_versions SET status = 'active' WHERE id = $1", [
          building.rows[0]?.id,
        ]);
      }),
    );
    expect(sqlState(await direct)).toBe('42501');
    const pointer = failureOf(
      ingest(ingestPool, instanceA, (client) =>
        client.query('UPDATE rag.instances SET active_index_version_id = $2 WHERE id = $1', [
          instanceA,
          versionId,
        ]),
      ),
    );
    expect(sqlState(await pointer)).toBe('42501');
  });
});

describe('conversation row-level security', () => {
  it('binds conversations, messages and feedback to their owner', async () => {
    const owner = {
      instanceId: instanceA,
      tenantKey: '_',
      accessTags: ['public'],
      ownerKey: 'owner-1',
    };
    const { conversationId, messageId } = await withInstanceTransaction(
      runtime,
      owner,
      async (client) => {
        const created = await client.query<{ id: string }>(
          `INSERT INTO rag.conversations (instance_id, owner_key, expires_at)
         VALUES ($1, $2, now() + interval '1 day') RETURNING id`,
          [instanceA, 'owner-1'],
        );
        const id = created.rows[0]?.id ?? '';
        const message = await client.query<{ id: string }>(
          `INSERT INTO rag.messages (instance_id, conversation_id, owner_key, role, content)
         VALUES ($1, $2, $3, 'user', 'hello') RETURNING id`,
          [instanceA, id, 'owner-1'],
        );
        const messageId = message.rows[0]?.id ?? '';
        await client.query(
          `INSERT INTO rag.feedback (instance_id, message_id, owner_key, rating) VALUES ($1, $2, $3, 1)`,
          [instanceA, messageId, 'owner-1'],
        );
        return { conversationId: id, messageId };
      },
    );

    const countFor = (access: InstanceAccess) =>
      withInstanceTransaction(runtime, access, async (client) => {
        const result = await client.query<{
          conversations: string;
          messages: string;
          feedback: string;
        }>(
          `SELECT (SELECT count(*) FROM rag.conversations WHERE id = $1) AS conversations,
                  (SELECT count(*) FROM rag.messages WHERE conversation_id = $1) AS messages,
                  (SELECT count(*) FROM rag.feedback WHERE message_id = $2) AS feedback`,
          [conversationId, messageId],
        );
        return result.rows[0];
      });

    const none = { conversations: '0', messages: '0', feedback: '0' };
    expect(await countFor(owner)).toEqual({ conversations: '1', messages: '1', feedback: '1' });
    expect(await countFor({ ...owner, ownerKey: 'owner-2' })).toEqual(none);
    const withoutOwner = { instanceId: instanceA, tenantKey: '_', accessTags: ['public'] };
    expect(await countFor(withoutOwner)).toEqual(none);
    expect(await countFor({ ...owner, instanceId: instanceB })).toEqual(none);

    const intruder = failureOf(
      withInstanceTransaction(runtime, { ...owner, ownerKey: 'owner-2' }, (client) =>
        client.query(
          `INSERT INTO rag.messages (instance_id, conversation_id, owner_key, role, content)
           VALUES ($1, $2, 'owner-1', 'user', 'injected')`,
          [instanceA, conversationId],
        ),
      ),
    );
    expect(sqlState(await intruder)).toBe('42501');

    const rateAs = (ownerKey: string) =>
      failureOf(
        withInstanceTransaction(runtime, { ...owner, ownerKey: 'owner-2' }, (client) =>
          client.query(
            'INSERT INTO rag.feedback (instance_id, message_id, owner_key, rating) VALUES ($1, $2, $3, -1)',
            [instanceA, messageId, ownerKey],
          ),
        ),
      );
    // Claiming the real owner fails the policy; using one's own key fails the owner-bound key.
    expect(sqlState(await rateAs('owner-1'))).toBe('42501');
    expect(sqlState(await rateAs('owner-2'))).toBe('23503');
  });
});

describe('conversation lifetime', () => {
  it('rejects expiry more than 30 days after creation and a caller-chosen creation time', async () => {
    const owner = {
      instanceId: instanceA,
      tenantKey: '_',
      accessTags: ['public'],
      ownerKey: 'owner-3',
    };
    const conversationId = await withInstanceTransaction(runtime, owner, async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO rag.conversations (instance_id, owner_key, expires_at)
         VALUES ($1, $2, now() + interval '1 day') RETURNING id`,
        [instanceA, 'owner-3'],
      );
      return created.rows[0]?.id ?? '';
    });

    const extend = (interval: string) =>
      withInstanceTransaction(runtime, owner, (client) =>
        client.query(
          `UPDATE rag.conversations SET expires_at = created_at + $2::interval WHERE id = $1`,
          [conversationId, interval],
        ),
      );
    expect((await extend('30 days')).rowCount).toBe(1);
    expect(sqlState(await failureOf(extend('31 days')))).toBe('23514');

    const backdated = withInstanceTransaction(runtime, owner, (client) =>
      client.query(
        `INSERT INTO rag.conversations (instance_id, owner_key, created_at, expires_at)
         VALUES ($1, 'owner-3', now() + interval '1 year', now() + interval '1 year 1 day')`,
        [instanceA],
      ),
    );
    expect(sqlState(await failureOf(backdated))).toBe('42501');
  });
});

describe('usage counters', () => {
  const access = { instanceId: instanceA, tenantKey: '_', accessTags: ['public'] };
  const consume = (
    scopes: string[],
    tokens: number,
    requests: number,
    context: InstanceAccess = access,
  ) =>
    withInstanceTransaction(runtime, context, async (client) => {
      const result = await client.query<{
        counter_scope: string | null;
        total_tokens: string;
        total_requests: string;
      }>('SELECT * FROM rag.consume_usage($1, $2, $3)', [scopes, tokens, requests]);
      return Object.fromEntries(
        result.rows.map((row) => [
          row.counter_scope ?? 'global',
          [row.total_tokens, row.total_requests],
        ]),
      );
    });

  it('only increases counters, per scope and once globally', async () => {
    const scope = `ip:${instanceA}`;
    const first = await consume([scope, scope], 10, 1);
    const second = await consume([scope], 5, 1);
    expect(first[scope]).toEqual(['10', '1']);
    expect(second[scope]).toEqual(['15', '2']);
    const firstGlobal = first.global ?? ['0', '0'];
    expect(Number(second.global?.[0]) - Number(firstGlobal[0])).toBeGreaterThanOrEqual(5);
  });

  it('records large calls in full and rejects only calls above the overflow guard', async () => {
    const scope = `guard:${instanceA}`;
    expect((await consume([scope], 250_000, 3))[scope]).toEqual(['250000', '3']);
    expect((await consume([scope], 10_000_000, 1000))[scope]).toEqual(['10250000', '1003']);

    for (const [tokens, requests] of [
      [10_000_001, 0],
      [0, 1001],
      ['9223372036854775807', 0],
      [0, '9223372036854775807'],
    ] as const) {
      const attempt = withInstanceTransaction(runtime, access, (client) =>
        client.query('SELECT * FROM rag.consume_usage($1, $2, $3)', [[scope], tokens, requests]),
      );
      expect(sqlState(await failureOf(attempt)), `${tokens} tokens, ${requests} requests`).toBe(
        '22023',
      );
    }

    expect((await consume([scope], 0, 0))[scope]).toEqual(['10250000', '1003']);
  });

  it('rejects negative deltas, a missing instance context and direct writes', async () => {
    expect(sqlState(await failureOf(consume(['session:x'], -1, 0)))).toBe('22023');
    expect(sqlState(await failureOf(consume(['session:x'], 0, -1)))).toBe('22023');
    expect(sqlState(await failureOf(consume([], 1, 1)))).toBe('22023');

    const client = await runtime.connect();
    try {
      const noContext = await failureOf(
        client.query("SELECT * FROM rag.consume_usage('{x}', 1, 1)"),
      );
      expect(sqlState(noContext)).toBe('42501');
    } finally {
      client.release();
    }

    for (const sql of [
      'UPDATE rag.usage_counters SET tokens = 0',
      'UPDATE rag.usage_global SET tokens = 0',
      "INSERT INTO rag.usage_counters (instance_id, scope, day) VALUES ($1, 'x', current_date)",
      'DELETE FROM rag.usage_global',
    ]) {
      const attempt = withInstanceTransaction(runtime, access, (c) =>
        c.query(sql, sql.includes('$1') ? [instanceA] : []),
      );
      expect(sqlState(await failureOf(attempt)), sql).toBe('42501');
    }
  });
});
