import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/store/migrate.js';
import { withInstanceTransaction } from '../../src/store/transaction.js';
import {
  activate,
  adminUrl,
  axisVector,
  createPool,
  createReadyVersion,
  ingest,
  ingestUrl,
  rolePasswords,
  runtimeUrl,
  sqlState,
  uniqueInstanceId,
} from './database.js';

// Every table in schema rag must be listed here. `instance` tables hold one instance's rows in
// `column`; `global` rows are shared by all instances by design; `internal` tables have no grant
// for either login role. `insert` is a row for instance A that is valid apart from its context.
type Insert = (seed: Seed) => [string, unknown[]];
interface Expectation {
  kind: 'instance' | 'global' | 'internal';
  column?: string;
  insert: Insert;
}

interface Seed {
  instanceA: string;
  versionA: string;
  documentA: string;
  conversationA: string;
  messageA: string;
}

const OWNER = 'owner-a';
const HASH = 'f'.repeat(64);

const expectations: Record<string, Expectation> = {
  activation_log: {
    kind: 'instance',
    insert: (s) => [
      `INSERT INTO rag.activation_log (instance_id, index_version_id, forced, operator)
       VALUES ($1, $2, false, 'other')`,
      [s.instanceA, s.versionA],
    ],
  },
  instances: {
    kind: 'instance',
    column: 'id',
    insert: () => ['INSERT INTO rag.instances (id) VALUES ($1)', [uniqueInstanceId('tbl-new')]],
  },
  index_versions: {
    kind: 'instance',
    insert: (s) => [
      `INSERT INTO rag.index_versions
         (instance_id, embedding_provider, embedding_model, embedding_dimensions, chunker_hash, config_hash)
       VALUES ($1, 'mock', 'mock-384', 384, $2, $2)`,
      [s.instanceA, HASH],
    ],
  },
  eval_runs: {
    kind: 'instance',
    insert: (s) => [
      `INSERT INTO rag.eval_runs (instance_id, index_version_id, embedding_provider, embedding_model, passed)
       VALUES ($1, $2, 'mock', 'mock-384', true)`,
      [s.instanceA, s.versionA],
    ],
  },
  documents: {
    kind: 'instance',
    insert: (s) => [
      `INSERT INTO rag.documents (instance_id, index_version_id, source_uri, content_sha256, access_tags)
       VALUES ($1, $2, 'test://other', $3, '{public}')`,
      [s.instanceA, s.versionA, HASH],
    ],
  },
  chunks: {
    kind: 'instance',
    insert: (s) => [
      `INSERT INTO rag.chunks
         (instance_id, index_version_id, document_id, ordinal, content, embedding, access_tags)
       VALUES ($1, $2, $3, 1, 'other', $4::vector, '{public}')`,
      [s.instanceA, s.versionA, s.documentA, axisVector(9)],
    ],
  },
  embedding_cache: {
    kind: 'instance',
    insert: (s) => [
      `INSERT INTO rag.embedding_cache (instance_id, model, content_sha256, embedding)
       VALUES ($1, 'other-model', $2, $3::vector)`,
      [s.instanceA, HASH, axisVector(9)],
    ],
  },
  conversations: {
    kind: 'instance',
    insert: (s) => [
      `INSERT INTO rag.conversations (instance_id, owner_key, expires_at)
       VALUES ($1, $2, now() + interval '1 day')`,
      [s.instanceA, OWNER],
    ],
  },
  messages: {
    kind: 'instance',
    insert: (s) => [
      `INSERT INTO rag.messages (instance_id, conversation_id, owner_key, role, content)
       VALUES ($1, $2, $3, 'user', 'other')`,
      [s.instanceA, s.conversationA, OWNER],
    ],
  },
  feedback: {
    kind: 'instance',
    insert: (s) => [
      'INSERT INTO rag.feedback (instance_id, message_id, owner_key, rating) VALUES ($1, $2, $3, 1)',
      [s.instanceA, s.messageA, OWNER],
    ],
  },
  usage_counters: {
    kind: 'instance',
    insert: (s) => [
      "INSERT INTO rag.usage_counters (instance_id, scope, day) VALUES ($1, 'other', current_date)",
      [s.instanceA],
    ],
  },
  usage_global: {
    kind: 'global',
    insert: () => ['INSERT INTO rag.usage_global (day) VALUES (current_date + 10000)', []],
  },
  schema_migrations: {
    kind: 'internal',
    insert: () => [
      'INSERT INTO rag.schema_migrations (name, checksum) VALUES ($1, $2)',
      ['9999_x.sql', HASH],
    ],
  },
};

const admin = new pg.Client({ connectionString: adminUrl });
const roles = { rag_runtime: createPool(runtimeUrl), rag_ingest: createPool(ingestUrl) };
const instanceA = uniqueInstanceId('tbl-a');
const instanceB = uniqueInstanceId('tbl-b');
let seed: Seed;
let tables: string[] = [];

beforeAll(async () => {
  await admin.connect();
  await migrate(admin, rolePasswords);

  const { versionId, chunkIds } = await createReadyVersion(roles.rag_ingest, instanceA, [
    { label: 'doc', tenantKey: '_', accessTags: ['public'], content: 'Instance A page', axis: 1 },
  ]);
  await activate(roles.rag_ingest, instanceA, versionId);
  await createReadyVersion(roles.rag_ingest, instanceB, [
    { label: 'doc', tenantKey: '_', accessTags: ['public'], content: 'Instance B page', axis: 1 },
  ]);
  const documentA = await ingest(roles.rag_ingest, instanceA, async (client) => {
    await client.query(
      `INSERT INTO rag.eval_runs (instance_id, index_version_id, embedding_provider, embedding_model, passed)
       VALUES ($1, $2, 'mock', 'mock-384', true)`,
      [instanceA, versionId],
    );
    await client.query(
      `INSERT INTO rag.embedding_cache (instance_id, model, content_sha256, embedding)
       VALUES ($1, 'mock-384', $2, $3::vector)`,
      [instanceA, HASH, axisVector(1)],
    );
    const doc = await client.query<{ document_id: string }>(
      'SELECT document_id FROM rag.chunks WHERE id = $1',
      [chunkIds.doc],
    );
    return doc.rows[0]?.document_id ?? '';
  });

  const ownerA = { instanceId: instanceA, tenantKey: '_', accessTags: ['public'], ownerKey: OWNER };
  const ids = await withInstanceTransaction(roles.rag_runtime, ownerA, async (client) => {
    const conversation = await client.query<{ id: string }>(
      `INSERT INTO rag.conversations (instance_id, owner_key, expires_at)
       VALUES ($1, $2, now() + interval '1 day') RETURNING id`,
      [instanceA, OWNER],
    );
    const conversationA = conversation.rows[0]?.id ?? '';
    const message = await client.query<{ id: string }>(
      `INSERT INTO rag.messages (instance_id, conversation_id, owner_key, role, content)
       VALUES ($1, $2, $3, 'user', 'hello') RETURNING id`,
      [instanceA, conversationA, OWNER],
    );
    const messageA = message.rows[0]?.id ?? '';
    await client.query(
      'INSERT INTO rag.feedback (instance_id, message_id, owner_key, rating) VALUES ($1, $2, $3, 1)',
      [instanceA, messageA, OWNER],
    );
    await client.query("SELECT rag.consume_usage('{instance}', 1, 1)");
    return { conversationA, messageA };
  });
  seed = { instanceA, versionA: versionId, documentA, ...ids };

  const result = await admin.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'rag' ORDER BY tablename",
  );
  tables = result.rows.map((row) => row.tablename);
});

afterAll(async () => {
  await Promise.all([admin.end(), roles.rag_runtime.end(), roles.rag_ingest.end()]);
});

type Outcome = `${number} rows` | 'denied' | `error ${string}`;

// Runs one statement as `pool`'s role, with instance B's context or none, and always rolls back.
async function attempt(
  pool: pg.Pool,
  context: 'instance-b' | 'none',
  sql: string,
  values: unknown[] = [],
): Promise<Outcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (context === 'instance-b') {
      await client.query(
        `SELECT set_config('rag.instance_id', $1, true), set_config('rag.tenant_key', '_', true),
                set_config('rag.access_tags', 'public', true), set_config('rag.owner_key', $2, true)`,
        [instanceB, OWNER],
      );
    }
    try {
      const result = await client.query<{ count?: string }>(sql, values);
      const rows = sql.startsWith('SELECT count')
        ? Number(result.rows[0]?.count)
        : (result.rowCount ?? 0);
      return `${rows} rows`;
    } catch (error) {
      const code = sqlState(error);
      return code === '42501' ? 'denied' : `error ${code ?? String(error)}`;
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

// A column the role may update, so the UPDATE below reaches row-level security; otherwise the
// first column, which the role is then denied.
async function columnToUpdate(role: string, table: string): Promise<string> {
  const result = await admin.query<{ attname: string }>(
    `SELECT attname FROM pg_attribute
     WHERE attrelid = $2::regclass AND attnum > 0 AND NOT attisdropped
     ORDER BY has_column_privilege($1, attrelid, attnum, 'UPDATE') DESC, attnum LIMIT 1`,
    [role, `rag.${table}`],
  );
  return result.rows[0]?.attname ?? 'id';
}

describe('every rag table', () => {
  it('is classified in this test', () => {
    expect(tables).toEqual(Object.keys(expectations).sort());
  });

  it('holds seeded rows, so zero visible rows below means they were filtered', async () => {
    for (const table of tables) {
      const expectation = expectations[table];
      const filter =
        expectation?.kind === 'instance' ? `WHERE ${expectation.column ?? 'instance_id'} = $1` : '';
      const result = await admin.query<{ count: string }>(
        `SELECT count(*) FROM rag.${table} ${filter}`,
        filter ? [instanceA] : [],
      );
      expect(Number(result.rows[0]?.count), table).toBeGreaterThan(0);
    }
  });

  it.each(Object.keys(roles) as (keyof typeof roles)[])(
    'hides instance A from %s under another instance or no context, and rejects writes',
    async (role) => {
      const pool = roles[role];
      const outcomes: Record<string, Record<string, Outcome>> = {};
      for (const table of tables) {
        const expectation = expectations[table];
        if (!expectation) continue;
        const ownRows =
          expectation.kind === 'instance'
            ? `WHERE ${expectation.column ?? 'instance_id'} = $1`
            : '';
        const ownValues = ownRows ? [instanceA] : [];
        const column = await columnToUpdate(role, table);
        const [insertSql, insertValues] = expectation.insert(seed);
        const result: Record<string, Outcome> = {
          insertAsB: await attempt(pool, 'instance-b', insertSql, insertValues),
          insertWithoutContext: await attempt(pool, 'none', insertSql, insertValues),
          updateAsB: await attempt(
            pool,
            'instance-b',
            `UPDATE rag.${table} SET ${column} = ${column} ${ownRows}`,
            ownValues,
          ),
          deleteAsB: await attempt(
            pool,
            'instance-b',
            `DELETE FROM rag.${table} ${ownRows}`,
            ownValues,
          ),
          readWithoutContext: await attempt(pool, 'none', `SELECT count(*) FROM rag.${table}`),
        };
        // Global rows are meant to be visible to every instance; all others must stay hidden.
        if (expectation.kind !== 'global') {
          result.readAsB = await attempt(
            pool,
            'instance-b',
            `SELECT count(*) FROM rag.${table} ${ownRows}`,
            ownValues,
          );
        }
        outcomes[table] = result;
      }

      const leaks = Object.entries(outcomes).flatMap(([table, result]) =>
        Object.entries(result)
          .filter(([, outcome]) => outcome !== '0 rows' && outcome !== 'denied')
          .map(([check, outcome]) => `${table}.${check}: ${outcome}`),
      );
      expect(leaks).toEqual([]);
      for (const check of Object.values(outcomes)) {
        expect(check.insertAsB).toBe('denied');
        expect(check.insertWithoutContext).toBe('denied');
      }
    },
  );
});
