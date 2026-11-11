import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate, migrationsDirectory } from '../../src/store/migrate.js';
import { verifyRuntimeRole } from '../../src/store/transaction.js';
import { adminUrl, createPool, ingestUrl, rolePasswords, runtimeUrl } from './database.js';

const admin = new pg.Client({ connectionString: adminUrl });
const runtime = createPool(runtimeUrl);
const ingest = createPool(ingestUrl);

beforeAll(async () => {
  await admin.connect();
  await migrate(admin, rolePasswords);
});

afterAll(async () => {
  await Promise.all([admin.end(), runtime.end(), ingest.end()]);
});

describe('migration runner', () => {
  it('records every migration with its checksum and applies nothing on a second run', async () => {
    expect(await migrate(admin, rolePasswords)).toEqual({ applied: [] });

    const files = await loadMigrations();
    const history = await admin.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM rag.schema_migrations ORDER BY name',
    );
    expect(history.rows).toEqual(files.map(({ name, checksum }) => ({ name, checksum })));
  });

  it('refuses to run when an applied migration was modified, and changes nothing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rag-migrations-'));
    try {
      await cp(migrationsDirectory, directory, { recursive: true });
      const first = join(directory, '0001_corpus_and_index_versions.sql');
      await writeFile(first, `${await readFile(first, 'utf8')}\n-- edited after it was applied\n`);
      const before = await admin.query(
        'SELECT name, checksum FROM rag.schema_migrations ORDER BY name',
      );

      await expect(migrate(admin, { ...rolePasswords, directory })).rejects.toThrow(
        /Applied migration was modified: 0001_corpus_and_index_versions.sql/,
      );

      const after = await admin.query(
        'SELECT name, checksum FROM rag.schema_migrations ORDER BY name',
      );
      expect(after.rows).toEqual(before.rows);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('database roles', () => {
  it('creates no role with superuser, BYPASSRLS, inheritance or role-management rights', async () => {
    const roles = await admin.query<Record<string, unknown>>(
      `SELECT rolname, rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb, rolreplication,
              rolcanlogin
       FROM pg_roles WHERE rolname IN ('rag_migrator', 'rag_runtime', 'rag_ingest') ORDER BY rolname`,
    );
    expect(roles.rows).toEqual(
      ['rag_ingest', 'rag_migrator', 'rag_runtime'].map((rolname) => ({
        rolname,
        rolsuper: false,
        rolbypassrls: false,
        rolinherit: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolcanlogin: rolname !== 'rag_migrator',
      })),
    );
  });

  it('accepts the runtime pool and rejects administrator and ingest credentials', async () => {
    await expect(verifyRuntimeRole(runtime)).resolves.toBeUndefined();
    await expect(verifyRuntimeRole(ingest)).rejects.toThrow(/is_runtime_role/);
    await expect(verifyRuntimeRole(admin)).rejects.toThrow(/not_superuser/);
  });

  it('puts every rag table under forced row-level security, owned by rag_migrator', async () => {
    const tables = await admin.query<{ relname: string; forced: boolean; owner: string }>(
      `SELECT c.relname, c.relrowsecurity AND c.relforcerowsecurity AS forced,
              pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c WHERE c.relnamespace = 'rag'::regnamespace AND c.relkind IN ('r', 'p')
       ORDER BY c.relname`,
    );
    expect(tables.rows.map((t) => t.relname)).toEqual([
      'chunks',
      'conversations',
      'documents',
      'embedding_cache',
      'eval_runs',
      'feedback',
      'index_versions',
      'instances',
      'messages',
      'schema_migrations',
      'usage_counters',
      'usage_global',
    ]);
    for (const table of tables.rows) {
      expect(table, table.relname).toMatchObject({ forced: true, owner: 'rag_migrator' });
    }
  });

  it('pins search_path with pg_temp last on every rag function and limits who can call definers', async () => {
    const functions = await admin.query<{
      proname: string;
      config: string[] | null;
      definer: boolean;
    }>(
      `SELECT proname, proconfig AS config, prosecdef AS definer
       FROM pg_proc WHERE pronamespace = 'rag'::regnamespace ORDER BY proname`,
    );
    for (const fn of functions.rows) {
      const searchPath = fn.config?.find((setting) => setting.startsWith('search_path='));
      expect(searchPath, fn.proname).toMatch(/^search_path=pg_catalog, (rag, )?pg_temp$/);
    }
    expect(functions.rows.filter((fn) => fn.definer).map((fn) => fn.proname)).toEqual([
      'activate_index_version',
    ]);

    const execute = await admin.query<Record<string, boolean>>(
      `SELECT has_function_privilege('rag_ingest', 'rag.activate_index_version(text, uuid)', 'EXECUTE') AS ingest_activate,
              has_function_privilege('rag_runtime', 'rag.activate_index_version(text, uuid)', 'EXECUTE') AS runtime_activate`,
    );
    expect(execute.rows[0]).toEqual({
      ingest_activate: true,
      runtime_activate: false,
    });
  });
});
