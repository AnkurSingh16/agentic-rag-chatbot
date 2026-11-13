import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { isChatbotError } from '@agentic-rag/core';
import { withInstanceTransaction } from '../../src/store/transaction.js';

// These tests create roles and run migrations, so they only ever target a loopback database.
function readUrl(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      'Set TEST_DATABASE_ADMIN_URL, TEST_DATABASE_URL and TEST_DATABASE_INGEST_URL to run the PostgreSQL integration tests',
    );
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)) {
    throw new Error(`${name} must point at a loopback database`);
  }
  return value;
}

export const adminUrl = readUrl('TEST_DATABASE_ADMIN_URL');
export const runtimeUrl = readUrl('TEST_DATABASE_URL');
export const ingestUrl = readUrl('TEST_DATABASE_INGEST_URL');

// The role passwords the runner needs are the ones the test URLs log in with.
export const rolePasswords = {
  runtimePassword: decodeURIComponent(new URL(runtimeUrl).password),
  ingestPassword: decodeURIComponent(new URL(ingestUrl).password),
};

export function createPool(url: string, max = 2): pg.Pool {
  return new pg.Pool({ connectionString: url, max });
}

export function uniqueInstanceId(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

/** A unit vector along one axis, as a pgvector literal. */
export function axisVector(axis: number, size = 384): string {
  const values = Array.from({ length: size }, (_, i) => (i === axis ? 1 : 0));
  return `[${values.join(',')}]`;
}

/** The SQLSTATE of a failed query, read through the ChatbotError wrapper. */
export function sqlState(error: unknown): string | undefined {
  const cause: unknown = isChatbotError(error) ? error.cause : error;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    return String(cause.code);
  }
  return undefined;
}

export async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to fail');
}

export interface SeedDocument {
  label: string;
  tenantKey: string;
  accessTags: string[];
  content: string;
  axis: number;
}

const HASH = 'a'.repeat(64);

export function ingest<T>(
  pool: pg.Pool,
  instanceId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withInstanceTransaction(pool, { instanceId, tenantKey: '_', accessTags: [] }, fn);
}

/** Creates a ready index version holding `documents`, each with one chunk. */
export async function createReadyVersion(
  pool: pg.Pool,
  instanceId: string,
  documents: readonly SeedDocument[],
): Promise<{ versionId: string; chunkIds: Record<string, string> }> {
  return ingest(pool, instanceId, async (client) => {
    await client.query('INSERT INTO rag.instances (id) VALUES ($1) ON CONFLICT DO NOTHING', [
      instanceId,
    ]);
    const version = await client.query<{ id: string }>(
      `INSERT INTO rag.index_versions
         (instance_id, embedding_provider, embedding_model, embedding_dimensions, chunker_hash, config_hash)
       VALUES ($1, 'mock', 'mock-384', 384, $2, $2) RETURNING id`,
      [instanceId, HASH],
    );
    const versionId = version.rows[0]?.id ?? '';
    const chunkIds: Record<string, string> = {};
    for (const doc of documents) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO rag.documents
           (instance_id, index_version_id, source_uri, title, content_sha256, tenant_key, access_tags)
         VALUES ($1, $2, $3, $3, $4, $5, $6) RETURNING id`,
        [instanceId, versionId, `test://${doc.label}`, HASH, doc.tenantKey, doc.accessTags],
      );
      const chunk = await client.query<{ id: string }>(
        `INSERT INTO rag.chunks
           (instance_id, index_version_id, document_id, ordinal, content, embedding, tenant_key, access_tags)
         VALUES ($1, $2, $3, 0, $4, $5::vector, $6, $7) RETURNING id`,
        [
          instanceId,
          versionId,
          inserted.rows[0]?.id,
          doc.content,
          axisVector(doc.axis),
          doc.tenantKey,
          doc.accessTags,
        ],
      );
      chunkIds[doc.label] = chunk.rows[0]?.id ?? '';
    }
    await client.query(
      `UPDATE rag.index_versions SET status = 'ready', document_count = $2, chunk_count = $2 WHERE id = $1`,
      [versionId, documents.length],
    );
    return { versionId, chunkIds };
  });
}

/** The configuration fingerprint the test chat runs record and activation checks (migration 0010). */
export const TEST_FINGERPRINT = 'f'.repeat(64);

export interface ActivationArgs {
  force: boolean | null;
  reason: string | null;
  operator: string | null;
  configFingerprint?: string | null;
}

// Forced by default so tests about pointers and isolation need no eval run; the eval gate has
// its own tests.
const FORCED: ActivationArgs = { force: true, reason: 'integration test', operator: 'tester' };

export function activate(
  pool: pg.Pool,
  instanceId: string,
  versionId: string,
  args: ActivationArgs = FORCED,
): Promise<string | null> {
  return ingest(pool, instanceId, async (client) => {
    const result = await client.query<{ previous: string | null }>(
      'SELECT rag.activate_index_version($1, $2, $3, $4, $5, $6) AS previous',
      [
        instanceId,
        versionId,
        args.force,
        args.reason,
        args.operator,
        args.configFingerprint === undefined ? TEST_FINGERPRINT : args.configFingerprint,
      ],
    );
    return result.rows[0]?.previous ?? null;
  });
}

/** Records one eval run of a single harness, so a test can make one harness fail on its own. */
export function recordHarnessEval(
  pool: pg.Pool,
  instanceId: string,
  versionId: string,
  harness: 'retrieval' | 'chat',
  passed: boolean,
): Promise<void> {
  return ingest(pool, instanceId, async (client) => {
    await client.query(
      `INSERT INTO rag.eval_runs (instance_id, index_version_id, embedding_provider, embedding_model, passed, metrics)
       VALUES ($1, $2, 'mock', 'mock-384', $3, jsonb_build_object('harness', $4::text, 'configFingerprint', $5::text))`,
      [instanceId, versionId, passed, harness, TEST_FINGERPRINT],
    );
  });
}

/**
 * Records a retrieval and a chat eval run for a version created by {@link createReadyVersion}.
 * Activation needs the latest run of each harness to pass (ADR 0009).
 */
export function recordEval(
  pool: pg.Pool,
  instanceId: string,
  versionId: string,
  passed: boolean,
  model = 'mock-384',
): Promise<void> {
  return ingest(pool, instanceId, async (client) => {
    for (const harness of ['retrieval', 'chat']) {
      await client.query(
        `INSERT INTO rag.eval_runs (instance_id, index_version_id, embedding_provider, embedding_model, passed, metrics)
         VALUES ($1, $2, 'mock', $3, $4, jsonb_build_object('harness', $5::text, 'configFingerprint', $6::text))`,
        [instanceId, versionId, model, passed, harness, TEST_FINGERPRINT],
      );
    }
  });
}
