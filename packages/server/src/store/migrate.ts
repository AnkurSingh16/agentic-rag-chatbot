import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatbotError, isChatbotError, toChatbotError } from '@agentic-rag/core';
import type { Queryable } from './queryable.js';

/** Directory holding the platform's SQL migrations, valid from both `src` and `dist`. */
export const migrationsDirectory = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

/** A migration file read from disk. */
export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

/** A row of `rag.schema_migrations`. */
export interface AppliedMigration {
  name: string;
  checksum: string;
}

/** Login passwords for the roles the runner creates when they do not exist yet. */
export interface MigrateOptions {
  runtimePassword: string;
  ingestPassword: string;
  directory?: string;
}

/** Names of the migrations applied by this run, in order. */
export interface MigrateResult {
  applied: string[];
}

const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/;

// Any constant works as long as every runner uses the same one.
const MIGRATION_LOCK_KEY = 7_245_013_001;

/** Reads every `.sql` file in `directory`, sorted by name, with its SHA-256 checksum. */
export async function loadMigrations(
  directory: string = migrationsDirectory,
): Promise<Migration[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(join(directory, name), 'utf8');
      return { name, sql, checksum: sha256(sql) };
    }),
  );
}

/**
 * Validates the files against the recorded history and returns the migrations still to apply.
 *
 * Refuses badly named or duplicate-numbered files, applied migrations that are missing or whose
 * contents changed, and new files that sort before an applied one.
 */
export function planMigrations(
  files: readonly Migration[],
  applied: readonly AppliedMigration[],
): Migration[] {
  const numbers = new Set<string>();
  for (const file of files) {
    const match = MIGRATION_FILE.exec(file.name);
    if (!match?.[1]) {
      throw new ChatbotError('invalid_config', `Migration file name is invalid: ${file.name}`);
    }
    if (numbers.has(match[1])) {
      throw new ChatbotError('invalid_config', `Migration number ${match[1]} is used twice`);
    }
    numbers.add(match[1]);
  }

  const byName = new Map(files.map((file) => [file.name, file]));
  for (const entry of applied) {
    const file = byName.get(entry.name);
    if (!file) {
      throw new ChatbotError('invalid_config', `Applied migration is missing: ${entry.name}`);
    }
    if (file.checksum !== entry.checksum) {
      throw new ChatbotError(
        'invalid_config',
        `Applied migration was modified: ${entry.name}. Add a new migration instead.`,
      );
    }
  }

  const appliedNames = new Set(applied.map((entry) => entry.name));
  const latestApplied = applied.reduce(
    (latest, entry) => (entry.name > latest ? entry.name : latest),
    '',
  );
  const pending = files.filter((file) => !appliedNames.has(file.name));
  const outOfOrder = pending.find((file) => file.name < latestApplied);
  if (outOfOrder) {
    throw new ChatbotError(
      'invalid_config',
      `Migration ${outOfOrder.name} sorts before the applied ${latestApplied}`,
    );
  }
  return pending;
}

/**
 * Applies pending migrations in one transaction under an advisory lock.
 *
 * `client` must be a dedicated connection with administrator rights: it creates the database
 * roles, the `rag` schema and the `vector` extension, then runs each migration as `rag_migrator`
 * so that role owns every object. Existing roles are checked, never altered.
 */
export async function migrate(client: Queryable, options: MigrateOptions): Promise<MigrateResult> {
  validatePasswords(options.runtimePassword, options.ingestPassword);
  const files = await loadMigrations(options.directory);

  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await ensureRoles(client, options);
    await prepareSchema(client);

    const history = await client.query<AppliedMigration>(
      'SELECT name, checksum FROM rag.schema_migrations ORDER BY name',
    );
    const pending = planMigrations(files, history.rows);
    for (const migration of pending) {
      await client.query(migration.sql);
      await client.query('INSERT INTO rag.schema_migrations (name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
    }

    await client.query('COMMIT');
    return { applied: pending.map((migration) => migration.name) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw isChatbotError(error) ? error : toChatbotError(error);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validatePasswords(runtimePassword: string, ingestPassword: string): void {
  for (const [name, password] of [
    ['runtime', runtimePassword],
    ['ingest', ingestPassword],
  ] as const) {
    if (password.length < 16 || password.length > 256) {
      throw new ChatbotError(
        'invalid_config',
        `The ${name} role password must have 16 to 256 characters`,
      );
    }
  }
  if (runtimePassword === ingestPassword) {
    throw new ChatbotError(
      'invalid_config',
      'The runtime and ingest roles need different passwords',
    );
  }
}

type RoleName = 'rag_migrator' | 'rag_runtime' | 'rag_ingest';

interface RoleState {
  rolname: RoleName;
  safe: boolean;
  can_login: boolean;
  has_members: boolean;
}

const ROLE_ATTRIBUTES = 'NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION';

async function ensureRoles(client: Queryable, options: MigrateOptions): Promise<void> {
  const existing = await client.query<RoleState>(
    `SELECT r.rolname, r.rolcanlogin AS can_login,
       NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolinherit AND NOT r.rolcreatedb
         AND NOT r.rolcreaterole AND NOT r.rolreplication
         AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS safe,
       EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r.oid) AS has_members
     FROM pg_roles r WHERE r.rolname IN ('rag_migrator', 'rag_runtime', 'rag_ingest')`,
  );
  const state = new Map(existing.rows.map((row) => [row.rolname, row]));

  const migrator = state.get('rag_migrator');
  // Administrators may be members of rag_migrator so they can act as the schema owner.
  if (migrator && (!migrator.safe || migrator.can_login)) {
    throw new ChatbotError('invalid_config', 'Existing role rag_migrator has unsafe attributes');
  }
  if (!migrator) {
    await client.query(`CREATE ROLE rag_migrator NOLOGIN ${ROLE_ATTRIBUTES}`);
  }

  for (const [name, password] of [
    ['rag_runtime', options.runtimePassword],
    ['rag_ingest', options.ingestPassword],
  ] as const) {
    const role = state.get(name);
    if (role && (!role.safe || !role.can_login || role.has_members)) {
      throw new ChatbotError('invalid_config', `Existing role ${name} has unsafe attributes`);
    }
    if (!role) {
      // The password travels as a bind parameter and the CREATE ROLE runs inside a DO block,
      // so it never appears in client-side SQL or in statement logs.
      await client.query("SELECT set_config('rag.bootstrap_password', $1, true)", [password]);
      await client.query(
        `DO $$ BEGIN EXECUTE format('CREATE ROLE ${name} LOGIN ${ROLE_ATTRIBUTES} PASSWORD %L',
           current_setting('rag.bootstrap_password')); END $$`,
      );
      await client.query("SELECT set_config('rag.bootstrap_password', '', true)");
    }
  }

  const membership = await client.query<{ can_set: boolean }>(
    "SELECT pg_has_role(current_user, 'rag_migrator', 'SET') AS can_set",
  );
  if (membership.rows[0]?.can_set !== true) {
    await client.query('GRANT rag_migrator TO CURRENT_USER');
  }
}

async function prepareSchema(client: Queryable): Promise<void> {
  await client.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await client.query('CREATE SCHEMA IF NOT EXISTS rag AUTHORIZATION rag_migrator');
  const owner = await client.query<{ owner: string }>(
    "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'rag'",
  );
  if (owner.rows[0]?.owner !== 'rag_migrator') {
    throw new ChatbotError('invalid_config', 'Schema rag exists but is not owned by rag_migrator');
  }

  // Both settings end with the transaction. The fixed search_path makes unqualified names in
  // migrations, such as the vector type, resolve the same way for every administrator.
  await client.query('SET LOCAL ROLE rag_migrator');
  await client.query('SET LOCAL search_path = pg_catalog, public');
  await client.query(
    `CREATE TABLE IF NOT EXISTS rag.schema_migrations (
       name text PRIMARY KEY,
       checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}
