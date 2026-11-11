import { ChatbotError, toChatbotError } from '@agentic-rag/core';
import type { PooledClient, Queryable } from './queryable.js';

/** The access context a transaction runs under; RLS policies read it (ADR 0003). */
export interface InstanceAccess {
  instanceId: string;
  tenantKey: string;
  /** May be empty, which matches no corpus rows. */
  accessTags: readonly string[];
  /** Required to read or write conversations and messages. */
  ownerKey?: string;
}

const INSTANCE_ID = /^[a-z][a-z0-9-]{1,39}$/;
// Tags travel as one comma-separated setting, so a comma inside a tag would split it.
const ACCESS_TAG = /^[^,\s]{1,128}$/;

/**
 * Runs `fn` in a repeatable-read transaction whose access context is set with transaction-local
 * settings, so it cannot outlive the transaction or leak to the next user of the connection.
 *
 * Commits when `fn` resolves and rolls back when it throws. A connection whose rollback fails is
 * destroyed instead of returned to the pool. Callers must finish before any model call so no
 * connection is held during inference.
 */
export async function withInstanceTransaction<C extends PooledClient, T>(
  pool: { connect(): Promise<C> },
  access: InstanceAccess,
  fn: (client: C) => Promise<T>,
): Promise<T> {
  validateAccess(access);
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    // set_config(..., true) is SET LOCAL. The HNSW settings let filtering by RLS after the
    // index scan keep searching instead of returning too few rows (ADR 0006).
    await client.query(
      `SELECT set_config('rag.instance_id', $1, true),
              set_config('rag.tenant_key', $2, true),
              set_config('rag.access_tags', $3, true),
              set_config('rag.owner_key', $4, true),
              set_config('hnsw.iterative_scan', 'relaxed_order', true),
              set_config('hnsw.ef_search', '100', true)`,
      [access.instanceId, access.tenantKey, access.accessTags.join(','), access.ownerKey ?? ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    // Database errors keep their SQLSTATE on `cause`.
    throw toChatbotError(error);
  } finally {
    client.release(broken);
  }
}

function validateAccess(access: InstanceAccess): void {
  if (!INSTANCE_ID.test(access.instanceId)) {
    throw new ChatbotError('invalid_input', 'Instance ID is invalid');
  }
  if (access.tenantKey.length < 1 || access.tenantKey.length > 128) {
    throw new ChatbotError('invalid_input', 'Tenant key must have 1 to 128 characters');
  }
  if (!access.accessTags.every((tag) => ACCESS_TAG.test(tag))) {
    throw new ChatbotError(
      'invalid_input',
      'Access tags must be 1 to 128 characters without commas or spaces',
    );
  }
  if (
    access.ownerKey !== undefined &&
    (access.ownerKey.length < 1 || access.ownerKey.length > 128)
  ) {
    throw new ChatbotError('invalid_input', 'Owner key must have 1 to 128 characters');
  }
}

// SQL booleans can be NULL; anything but true counts as a failed check.
interface RoleCheck {
  role_name: string;
  is_runtime_role: boolean | null;
  not_superuser: boolean | null;
  no_bypassrls: boolean | null;
  no_role_admin: boolean | null;
  no_inherit: boolean | null;
  no_memberships: boolean | null;
  no_create: boolean | null;
  rls_forced: boolean | null;
}

/**
 * Fails closed unless the pool connects as `rag_runtime` with no superuser, `BYPASSRLS`,
 * role-management or `CREATE` rights, no role memberships in either direction, and every table in
 * schema `rag` under forced row-level security (ADR 0003).
 */
export async function verifyRuntimeRole(db: Queryable): Promise<void> {
  const result = await db
    .query<RoleCheck>(
      `SELECT current_user AS role_name,
       current_user = 'rag_runtime' AND session_user = 'rag_runtime' AS is_runtime_role,
       NOT r.rolsuper AS not_superuser,
       NOT r.rolbypassrls AS no_bypassrls,
       NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication AS no_role_admin,
       NOT r.rolinherit AS no_inherit,
       NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid)
         AS no_memberships,
       NOT has_database_privilege(current_user, current_database(), 'CREATE')
         AND NOT has_schema_privilege(current_user, 'public', 'CREATE')
         AND NOT has_schema_privilege(current_user, 'rag', 'CREATE') AS no_create,
       NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'rag' AND c.relkind IN ('r', 'p')
           AND NOT (c.relrowsecurity AND c.relforcerowsecurity)) AS rls_forced
     FROM pg_roles r WHERE r.rolname = current_user`,
    )
    .catch((error: unknown) => {
      throw toChatbotError(error);
    });
  const row = result.rows[0];
  if (!row) {
    throw new ChatbotError('invalid_config', 'Could not read the attributes of the database role');
  }
  const failed = (Object.keys(row) as (keyof RoleCheck)[]).filter(
    (key) => key !== 'role_name' && row[key] !== true,
  );
  if (failed.length > 0) {
    throw new ChatbotError(
      'invalid_config',
      `Database role ${row.role_name} is not a safe runtime role: ${failed.join(', ')}`,
    );
  }
}
