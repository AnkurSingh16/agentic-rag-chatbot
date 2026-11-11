import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/store/migrate.js';
import { withInstanceTransaction } from '../../src/store/transaction.js';
import {
  activate,
  adminUrl,
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
const ingestPool = createPool(ingestUrl);
const instanceId = uniqueInstanceId('ver');
const page = (content: string, axis: number) => [
  { label: content, tenantKey: '_', accessTags: ['public'], content, axis },
];

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await migrate(admin, rolePasswords);
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  await Promise.all([runtime.end(), ingestPool.end()]);
});

function state() {
  return withInstanceTransaction(
    runtime,
    { instanceId, tenantKey: '_', accessTags: ['public'] },
    async (client) => {
      const pointer = await client.query<{ active: string | null }>(
        'SELECT active_index_version_id AS active FROM rag.instances',
      );
      const versions = await client.query<{ id: string; status: string; activated: boolean }>(
        'SELECT id, status, activated_at IS NOT NULL AS activated FROM rag.index_versions',
      );
      const chunks = await client.query<{ content: string }>(
        `SELECT c.content FROM rag.chunks c
       JOIN rag.instances i ON i.active_index_version_id = c.index_version_id`,
      );
      return {
        active: pointer.rows[0]?.active ?? null,
        status: Object.fromEntries(versions.rows.map((v) => [v.id, v.status])),
        served: chunks.rows.map((row) => row.content),
      };
    },
  );
}

describe('index version activation', () => {
  it('moves the pointer, retires the previous version and supports rollback', async () => {
    const v1 = (await createReadyVersion(ingestPool, instanceId, page('Version one', 1))).versionId;
    expect(await activate(ingestPool, instanceId, v1)).toBeNull();
    expect(await state()).toEqual({
      active: v1,
      status: { [v1]: 'active' },
      served: ['Version one'],
    });

    const v2 = (await createReadyVersion(ingestPool, instanceId, page('Version two', 2))).versionId;
    expect(await activate(ingestPool, instanceId, v2)).toBe(v1);
    expect(await state()).toEqual({
      active: v2,
      status: { [v1]: 'retired', [v2]: 'active' },
      served: ['Version two'],
    });

    expect(await activate(ingestPool, instanceId, v1)).toBe(v2);
    expect(await state()).toEqual({
      active: v1,
      status: { [v1]: 'active', [v2]: 'retired' },
      served: ['Version one'],
    });
  });

  it('refuses versions that are building, already active or from another instance', async () => {
    const building = await ingest(ingestPool, instanceId, async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO rag.index_versions
           (instance_id, embedding_provider, embedding_model, embedding_dimensions, chunker_hash, config_hash)
         VALUES ($1, 'fake', 'fake-1024', 1024, $2, $2) RETURNING id`,
        [instanceId, 'd'.repeat(64)],
      );
      return result.rows[0]?.id ?? '';
    });
    expect(sqlState(await failureOf(activate(ingestPool, instanceId, building)))).toBe('55000');

    const before = await state();
    const active = before.active ?? '';
    expect(sqlState(await failureOf(activate(ingestPool, instanceId, active)))).toBe('55000');

    const otherInstance = uniqueInstanceId('ver-other');
    const foreign = (await createReadyVersion(ingestPool, otherInstance, page('Other', 3)))
      .versionId;
    expect(sqlState(await failureOf(activate(ingestPool, instanceId, foreign)))).toBe('P0002');
    expect(await state()).toEqual(before);
  });

  it('requires the caller to be in the same instance context', async () => {
    const otherInstance = uniqueInstanceId('ver-ctx');
    const { versionId } = await createReadyVersion(ingestPool, otherInstance, page('Context', 4));
    const mismatched = ingest(ingestPool, instanceId, (client) =>
      client.query('SELECT rag.activate_index_version($1, $2)', [otherInstance, versionId]),
    );
    expect(sqlState(await failureOf(mismatched))).toBe('42501');
  });

  it('is not executable by the runtime role', async () => {
    const { active } = await state();
    const attempt = withInstanceTransaction(
      runtime,
      { instanceId, tenantKey: '_', accessTags: ['public'] },
      (client) => client.query('SELECT rag.activate_index_version($1, $2)', [instanceId, active]),
    );
    expect(sqlState(await failureOf(attempt))).toBe('42501');
  });
});
