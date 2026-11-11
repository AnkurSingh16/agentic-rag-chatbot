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
  recordEval,
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
         VALUES ($1, 'mock', 'mock-384', 384, $2, $2) RETURNING id`,
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

  it('keeps a ready version immutable to the ingest role', async () => {
    const { versionId } = await createReadyVersion(ingestPool, instanceId, page('Frozen', 5));
    const edits = await ingest(ingestPool, instanceId, async (client) => {
      const reopen = await client.query(
        "UPDATE rag.index_versions SET status = 'building' WHERE id = $1",
        [versionId],
      );
      const recount = await client.query(
        'UPDATE rag.index_versions SET document_count = 99, chunk_count = 99 WHERE id = $1',
        [versionId],
      );
      const row = await client.query<{ status: string; document_count: number }>(
        'SELECT status, document_count FROM rag.index_versions WHERE id = $1',
        [versionId],
      );
      return { reopened: reopen.rowCount, recounted: recount.rowCount, row: row.rows[0] };
    });
    expect(edits).toEqual({
      reopened: 0,
      recounted: 0,
      row: { status: 'ready', document_count: 1 },
    });
  });

  it('requires the caller to be in the same instance context', async () => {
    const otherInstance = uniqueInstanceId('ver-ctx');
    const { versionId } = await createReadyVersion(ingestPool, otherInstance, page('Context', 4));
    const mismatched = ingest(ingestPool, instanceId, (client) =>
      client.query('SELECT rag.activate_index_version($1, $2, true, $3, $4)', [
        otherInstance,
        versionId,
        'r',
        'o',
      ]),
    );
    expect(sqlState(await failureOf(mismatched))).toBe('42501');
  });

  it('is not executable by the runtime role', async () => {
    const { active } = await state();
    const attempt = withInstanceTransaction(
      runtime,
      { instanceId, tenantKey: '_', accessTags: ['public'] },
      (client) =>
        client.query('SELECT rag.activate_index_version($1, $2, true, $3, $4)', [
          instanceId,
          active,
          'r',
          'o',
        ]),
    );
    expect(sqlState(await failureOf(attempt))).toBe('42501');
  });
});

describe('eval gate on activation', () => {
  const gateInstance = uniqueInstanceId('gate');
  const gated = { force: false, reason: null, operator: 'ankur' };

  function log() {
    return ingest(ingestPool, gateInstance, async (client) => {
      const result = await client.query<{
        index_version_id: string;
        forced: boolean;
        reason: string | null;
        operator: string;
      }>('SELECT index_version_id, forced, reason, operator FROM rag.activation_log ORDER BY id');
      return result.rows;
    });
  }

  async function activeVersion(): Promise<string | null> {
    return ingest(ingestPool, gateInstance, async (client) => {
      const result = await client.query<{ active: string | null }>(
        'SELECT active_index_version_id AS active FROM rag.instances',
      );
      return result.rows[0]?.active ?? null;
    });
  }

  async function gateFailure(versionId: string): Promise<string> {
    const error = await failureOf(activate(ingestPool, gateInstance, versionId, gated));
    expect(sqlState(error)).toBe('55000');
    return (error as Error).message;
  }

  it('refuses a version without a passing eval run for its own embedding model', async () => {
    const { versionId } = await createReadyVersion(ingestPool, gateInstance, page('Gated', 6));
    expect(await gateFailure(versionId)).toContain('has no eval run');

    await recordEval(ingestPool, gateInstance, versionId, false);
    expect(await gateFailure(versionId)).toContain('failed');

    await recordEval(ingestPool, gateInstance, versionId, true, 'voyage-3.5');
    expect(await gateFailure(versionId)).toContain('used mock/voyage-3.5');

    expect(await activeVersion()).toBeNull();
    expect(await log()).toEqual([]);
  });

  it('activates after a passing run and logs it as not forced', async () => {
    const { versionId } = await createReadyVersion(ingestPool, gateInstance, page('Passed', 7));
    await recordEval(ingestPool, gateInstance, versionId, true);
    expect(await activate(ingestPool, gateInstance, versionId, gated)).toBeNull();
    expect(await activeVersion()).toBe(versionId);
    expect(await log()).toEqual([
      { index_version_id: versionId, forced: false, reason: null, operator: 'ankur' },
    ]);
  });

  it('judges only the latest eval run', async () => {
    const { versionId } = await createReadyVersion(ingestPool, gateInstance, page('Latest', 8));
    await recordEval(ingestPool, gateInstance, versionId, true);
    await recordEval(ingestPool, gateInstance, versionId, false);
    expect(await gateFailure(versionId)).toContain('failed');
  });

  it('skips the gate only when forced with a reason, and logs the reason', async () => {
    const { versionId } = await createReadyVersion(ingestPool, gateInstance, page('Forced', 9));
    const before = await activeVersion();
    for (const reason of [null, '', '   ']) {
      const error = await failureOf(
        activate(ingestPool, gateInstance, versionId, { force: true, reason, operator: 'ankur' }),
      );
      expect(sqlState(error), String(reason)).toBe('22023');
    }
    for (const args of [
      { force: null, reason: null, operator: 'ankur' },
      { force: false, reason: null, operator: null },
      { force: true, reason: 'r', operator: '  ' },
    ]) {
      expect(sqlState(await failureOf(activate(ingestPool, gateInstance, versionId, args)))).toBe(
        '22023',
      );
    }
    expect(await activeVersion()).toBe(before);

    const forced = { force: true, reason: '  no eval harness yet ', operator: 'ankur' };
    expect(await activate(ingestPool, gateInstance, versionId, forced)).toBe(before);
    expect((await log()).at(-1)).toEqual({
      index_version_id: versionId,
      forced: true,
      reason: 'no eval harness yet',
      operator: 'ankur',
    });
  });

  it('removes the ungated two-argument function', async () => {
    const { versionId } = await createReadyVersion(ingestPool, gateInstance, page('Old', 10));
    const attempt = ingest(ingestPool, gateInstance, (client) =>
      client.query('SELECT rag.activate_index_version($1, $2)', [gateInstance, versionId]),
    );
    expect(sqlState(await failureOf(attempt))).toBe('42883');
  });

  it('lets the ingest role add log rows but not choose their time, and hides the log from runtime', async () => {
    const { versionId } = await createReadyVersion(ingestPool, gateInstance, page('Log', 11));
    const backdated = ingest(ingestPool, gateInstance, (client) =>
      client.query(
        `INSERT INTO rag.activation_log (instance_id, index_version_id, forced, operator, activated_at)
         VALUES ($1, $2, false, 'x', now() - interval '1 year')`,
        [gateInstance, versionId],
      ),
    );
    expect(sqlState(await failureOf(backdated))).toBe('42501');

    const unexplained = ingest(ingestPool, gateInstance, (client) =>
      client.query(
        `INSERT INTO rag.activation_log (instance_id, index_version_id, forced, operator)
         VALUES ($1, $2, true, 'x')`,
        [gateInstance, versionId],
      ),
    );
    expect(sqlState(await failureOf(unexplained))).toBe('23514');

    const read = withInstanceTransaction(
      runtime,
      { instanceId: gateInstance, tenantKey: '_', accessTags: ['public'] },
      (client) => client.query('SELECT count(*) FROM rag.activation_log'),
    );
    expect(sqlState(await failureOf(read))).toBe('42501');
  });
});
