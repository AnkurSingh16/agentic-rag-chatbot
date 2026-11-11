import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ChatbotError } from '@agentic-rag/core';
import {
  loadMigrations,
  migrate,
  planMigrations,
  type Migration,
} from '../../src/store/migrate.js';
import { FakeClient, type Responder } from './fake-client.js';

const runtimePassword = 'runtime-password-for-tests';
const ingestPassword = 'ingest-password-for-tests';

function file(name: string, sql = `SELECT '${name}';`): Migration {
  return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
}

interface DatabaseState {
  roles?: { rolname: string; safe: boolean; can_login: boolean; has_members: boolean }[];
  canSetMigrator?: boolean;
  schemaOwner?: string;
  history?: { name: string; checksum: string }[];
  failOn?: RegExp;
}

function database(state: DatabaseState = {}): Responder {
  return (text) => {
    if (state.failOn?.test(text)) return new Error('relation "rag.nope" does not exist');
    if (text.includes('FROM pg_roles r')) return state.roles ?? [];
    if (text.includes('pg_has_role')) return [{ can_set: state.canSetMigrator ?? true }];
    if (text.includes('pg_namespace')) return [{ owner: state.schemaOwner ?? 'rag_migrator' }];
    if (text.startsWith('SELECT name, checksum')) return state.history ?? [];
    return [];
  };
}

const safeRoles = [
  { rolname: 'rag_migrator', safe: true, can_login: false, has_members: true },
  { rolname: 'rag_runtime', safe: true, can_login: true, has_members: false },
  { rolname: 'rag_ingest', safe: true, can_login: true, has_members: false },
];

describe('planMigrations', () => {
  it('returns unapplied migrations in name order', () => {
    const files = [file('0001_a.sql'), file('0002_b.sql'), file('0003_c.sql')];
    const applied = [{ name: '0001_a.sql', checksum: files[0]?.checksum ?? '' }];
    expect(planMigrations(files, applied).map((m) => m.name)).toEqual(['0002_b.sql', '0003_c.sql']);
  });

  it('refuses an applied migration whose contents changed', () => {
    const files = [file('0001_a.sql', 'SELECT 2;')];
    const applied = [{ name: '0001_a.sql', checksum: file('0001_a.sql', 'SELECT 1;').checksum }];
    expect(() => planMigrations(files, applied)).toThrow(/was modified: 0001_a.sql/);
  });

  it('refuses when an applied migration is missing from disk', () => {
    expect(() => planMigrations([], [{ name: '0001_a.sql', checksum: 'x' }])).toThrow(
      /Applied migration is missing/,
    );
  });

  it('refuses a new migration that sorts before an applied one', () => {
    const files = [file('0001_a.sql'), file('0002_b.sql')];
    const applied = [{ name: '0002_b.sql', checksum: files[1]?.checksum ?? '' }];
    expect(() => planMigrations(files, applied)).toThrow(
      /0001_a.sql sorts before the applied 0002_b.sql/,
    );
  });

  it('refuses badly named files and reused numbers', () => {
    expect(() => planMigrations([file('1_a.sql')], [])).toThrow(/name is invalid/);
    expect(() => planMigrations([file('0001_a.sql'), file('0001_b.sql')], [])).toThrow(
      /used twice/,
    );
  });
});

describe('loadMigrations', () => {
  it('loads the shipped migrations with their SHA-256 checksums', async () => {
    const files = await loadMigrations();
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const migration of files) {
      expect(migration.checksum).toBe(createHash('sha256').update(migration.sql).digest('hex'));
    }
    expect(planMigrations(files, [])).toHaveLength(files.length);
  });
});

describe('migrate', () => {
  it('creates missing roles without putting passwords in SQL text', async () => {
    const client = new FakeClient(database());
    const result = await migrate(client, { runtimePassword, ingestPassword });

    const texts = client.texts();
    expect(texts.some((t) => t.startsWith('CREATE ROLE rag_migrator NOLOGIN'))).toBe(true);
    expect(texts.filter((t) => t.includes("format('CREATE ROLE rag_"))).toHaveLength(2);
    expect(texts.join('\n')).not.toContain(runtimePassword);
    expect(texts.join('\n')).not.toContain(ingestPassword);
    const boundValues = client.calls.flatMap((call) => call.values ?? []);
    expect(boundValues).toContain(runtimePassword);
    expect(boundValues).toContain(ingestPassword);
    expect(result.applied.length).toBeGreaterThanOrEqual(4);
  });

  it('applies migrations as rag_migrator in one locked transaction and records checksums', async () => {
    const client = new FakeClient(database({ roles: safeRoles }));
    const result = await migrate(client, { runtimePassword, ingestPassword });
    const texts = client.texts();

    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toContain('pg_advisory_xact_lock');
    expect(texts.at(-1)).toBe('COMMIT');
    expect(texts.some((t) => t.startsWith('CREATE ROLE'))).toBe(false);
    expect(texts.indexOf('SET LOCAL ROLE rag_migrator')).toBeLessThan(
      texts.findIndex((t) => t.includes('CREATE TABLE rag.instances')),
    );
    const recorded = client.calls.filter((call) =>
      call.text.startsWith('INSERT INTO rag.schema_migrations'),
    );
    expect(recorded.map((call) => call.values?.[0])).toEqual(result.applied);
  });

  it('applies nothing when every migration is already recorded', async () => {
    const files = await loadMigrations();
    const history = files.map(({ name, checksum }) => ({ name, checksum }));
    const client = new FakeClient(database({ roles: safeRoles, history }));
    expect(await migrate(client, { runtimePassword, ingestPassword })).toEqual({ applied: [] });
  });

  it('rolls back and runs no migration when an applied file was modified', async () => {
    const history = [{ name: '0001_corpus_and_index_versions.sql', checksum: '0'.repeat(64) }];
    const client = new FakeClient(database({ roles: safeRoles, history }));
    await expect(migrate(client, { runtimePassword, ingestPassword })).rejects.toThrow(
      /was modified/,
    );
    expect(client.texts().at(-1)).toBe('ROLLBACK');
    expect(client.texts().some((t) => t.includes('CREATE TABLE rag.instances'))).toBe(false);
  });

  it('refuses existing roles with unsafe attributes', async () => {
    const unsafeRuntime = safeRoles.map((role) =>
      role.rolname === 'rag_runtime' ? { ...role, safe: false } : role,
    );
    await expect(
      migrate(new FakeClient(database({ roles: unsafeRuntime })), {
        runtimePassword,
        ingestPassword,
      }),
    ).rejects.toThrow(/rag_runtime has unsafe attributes/);

    const loginMigrator = safeRoles.map((role) =>
      role.rolname === 'rag_migrator' ? { ...role, can_login: true } : role,
    );
    await expect(
      migrate(new FakeClient(database({ roles: loginMigrator })), {
        runtimePassword,
        ingestPassword,
      }),
    ).rejects.toThrow(/rag_migrator has unsafe attributes/);
  });

  it('grants rag_migrator to an administrator that cannot assume it yet', async () => {
    const client = new FakeClient(database({ roles: safeRoles, canSetMigrator: false }));
    await migrate(client, { runtimePassword, ingestPassword });
    expect(client.texts()).toContain('GRANT rag_migrator TO CURRENT_USER');
  });

  it('refuses a rag schema owned by another role', async () => {
    const client = new FakeClient(database({ roles: safeRoles, schemaOwner: 'someone_else' }));
    await expect(migrate(client, { runtimePassword, ingestPassword })).rejects.toThrow(
      /not owned by rag_migrator/,
    );
  });

  it('wraps database errors and keeps the cause', async () => {
    const client = new FakeClient(
      database({ roles: safeRoles, failOn: /CREATE TABLE rag.instances/ }),
    );
    const error: unknown = await migrate(client, { runtimePassword, ingestPassword }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ChatbotError);
    expect((error as ChatbotError).cause).toBeInstanceOf(Error);
    expect(client.texts().at(-1)).toBe('ROLLBACK');
  });

  it('rejects short or shared passwords before connecting', async () => {
    const client = new FakeClient(database());
    await expect(migrate(client, { runtimePassword: 'short', ingestPassword })).rejects.toThrow(
      /runtime role password/,
    );
    await expect(
      migrate(client, { runtimePassword, ingestPassword: runtimePassword }),
    ).rejects.toThrow(/different passwords/);
    expect(client.calls).toHaveLength(0);
  });
});
