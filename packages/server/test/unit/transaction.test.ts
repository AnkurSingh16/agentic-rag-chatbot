import { describe, expect, it } from 'vitest';
import { ChatbotError } from '@agentic-rag/core';
import { verifyRuntimeRole, withInstanceTransaction } from '../../src/store/transaction.js';
import { FakeClient, type Responder } from './fake-client.js';

const access = { instanceId: 'portfolio', tenantKey: '_', accessTags: ['public', 'faq'] };

function poolOf(client: FakeClient) {
  let connects = 0;
  return {
    connect: () => {
      connects++;
      return Promise.resolve(client);
    },
    connects: () => connects,
  };
}

describe('withInstanceTransaction', () => {
  it('sets the access context locally inside a repeatable-read transaction and commits', async () => {
    const client = new FakeClient();
    const result = await withInstanceTransaction(
      poolOf(client),
      { ...access, ownerKey: 'abc' },
      (c) => c.query('SELECT 1').then(() => 'done'),
    );

    expect(result).toBe('done');
    const [begin, context, work, commit] = client.calls;
    expect(begin?.text).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ');
    expect(context?.text).toContain("set_config('rag.instance_id', $1, true)");
    expect(context?.text).toContain("set_config('hnsw.iterative_scan', 'relaxed_order', true)");
    expect(context?.text).toContain("set_config('hnsw.ef_search', '100', true)");
    expect(context?.values).toEqual(['portfolio', '_', 'public,faq', 'abc']);
    expect(work?.text).toBe('SELECT 1');
    expect(commit?.text).toBe('COMMIT');
    expect(client.released).toEqual([false]);
  });

  it('clears the owner and tags when none are given', async () => {
    const client = new FakeClient();
    await withInstanceTransaction(poolOf(client), { ...access, accessTags: [] }, () =>
      Promise.resolve(),
    );
    expect(client.calls[1]?.values).toEqual(['portfolio', '_', '', '']);
  });

  it('rolls back, returns the connection and rethrows when the work fails', async () => {
    const client = new FakeClient();
    const failure = new ChatbotError('forbidden', 'nope');
    await expect(
      withInstanceTransaction(poolOf(client), access, () => Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(client.texts().at(-1)).toBe('ROLLBACK');
    expect(client.released).toEqual([false]);
  });

  it('wraps database errors and keeps the original on cause', async () => {
    const dbError = Object.assign(new Error('permission denied for table chunks'), {
      code: '42501',
    });
    const client = new FakeClient((text) => (text.startsWith('INSERT') ? dbError : []));
    const error: unknown = await withInstanceTransaction(poolOf(client), access, (c) =>
      c.query('INSERT INTO rag.chunks DEFAULT VALUES'),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatbotError);
    expect((error as ChatbotError).cause).toBe(dbError);
  });

  it('destroys the connection when rollback fails', async () => {
    const client = new FakeClient((text) =>
      text === 'ROLLBACK' || text === 'COMMIT' ? new Error('connection lost') : [],
    );
    await expect(
      withInstanceTransaction(poolOf(client), access, () => Promise.resolve()),
    ).rejects.toThrow('connection lost');
    expect(client.released).toEqual([true]);
  });

  it.each([
    [{ ...access, instanceId: 'Bad ID' }, /Instance ID/],
    [{ ...access, tenantKey: '' }, /Tenant key/],
    [{ ...access, accessTags: ['faq,internal'] }, /Access tags/],
    [{ ...access, accessTags: [''] }, /Access tags/],
    [{ ...access, ownerKey: '' }, /Owner key/],
  ])('rejects an invalid access context before connecting (%#)', async (bad, message) => {
    const pool = poolOf(new FakeClient());
    await expect(withInstanceTransaction(pool, bad, () => Promise.resolve())).rejects.toThrow(
      message,
    );
    expect(pool.connects()).toBe(0);
  });
});

describe('verifyRuntimeRole', () => {
  const safe = {
    role_name: 'rag_runtime',
    is_runtime_role: true,
    not_superuser: true,
    no_bypassrls: true,
    no_role_admin: true,
    no_inherit: true,
    no_memberships: true,
    no_create: true,
    rls_forced: true,
  };
  const answering =
    (row: object | undefined): Responder =>
    () =>
      row ? [row] : [];

  it('accepts a runtime role with no elevated rights', async () => {
    await expect(verifyRuntimeRole(new FakeClient(answering(safe)))).resolves.toBeUndefined();
  });

  it('names every failed check', async () => {
    const row = { ...safe, role_name: 'postgres', is_runtime_role: false, no_bypassrls: false };
    await expect(verifyRuntimeRole(new FakeClient(answering(row)))).rejects.toThrow(
      'Database role postgres is not a safe runtime role: is_runtime_role, no_bypassrls',
    );
  });

  it('fails closed when the role cannot be read or the query fails', async () => {
    await expect(verifyRuntimeRole(new FakeClient(answering(undefined)))).rejects.toThrow(
      /Could not read/,
    );
    const error: unknown = await verifyRuntimeRole(
      new FakeClient(() => new Error('schema "rag" does not exist')),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatbotError);
  });
});
