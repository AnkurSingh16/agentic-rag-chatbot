import { describe, expect, it } from 'vitest';
import { ChatbotError, activateVersion, evalGateFailure } from '../src/index.js';
import { MemoryStore } from './memory-store.js';

const HASH = 'e'.repeat(64);

async function storeWithVersion(): Promise<{ store: MemoryStore; versionId: string }> {
  const store = new MemoryStore();
  await store.ensureInstance('help');
  const versionId = await store.createIndexVersion('help', {
    embeddingProvider: 'mock',
    embeddingModel: 'mock-hash-v1',
    embeddingDimensions: 384,
    chunkerHash: HASH,
    configHash: HASH,
  });
  await store.markReady('help', versionId, { documents: 1, chunks: 1 });
  return { store, versionId };
}

function evalRun(passed: boolean, model = 'mock-hash-v1', provider = 'mock') {
  return { embeddingProvider: provider, embeddingModel: model, passed, metrics: {} };
}

async function failure(promise: Promise<unknown>): Promise<ChatbotError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChatbotError) return error;
    throw error;
  }
  throw new Error('Expected a ChatbotError');
}

describe('activateVersion', () => {
  it('activates a version whose latest eval passed with the same provider and model', async () => {
    const { store, versionId } = await storeWithVersion();
    await store.recordEvalRun('help', versionId, evalRun(true));
    const events: unknown[] = [];
    const result = await activateVersion({
      store,
      instanceId: 'help',
      versionId,
      operator: 'ankur',
      log: (event) => events.push(event),
    });
    expect(result).toEqual({ versionId, previousVersionId: null, forced: false });
    expect(events).toEqual([
      {
        event: 'index.activated',
        instanceId: 'help',
        versionId,
        previousVersionId: null,
        forced: false,
        operator: 'ankur',
      },
    ]);
    expect(store.activations).toEqual([
      { instanceId: 'help', versionId, force: false, reason: undefined, operator: 'ankur' },
    ]);
  });

  it.each([
    ['no eval run', [], 'it has no eval run'],
    ['a failed latest run', [evalRun(true), evalRun(false)], 'failed'],
    ['another model', [evalRun(true, 'voyage-3.5')], 'used mock/voyage-3.5'],
    ['another provider', [evalRun(true, 'mock-hash-v1', 'voyage')], 'used voyage/mock-hash-v1'],
  ])('refuses a version with %s', async (_label, runs, reason) => {
    const { store, versionId } = await storeWithVersion();
    for (const run of runs) await store.recordEvalRun('help', versionId, run);
    const error = await failure(
      activateVersion({
        store,
        instanceId: 'help',
        versionId,
        operator: 'x',
        log: () => undefined,
      }),
    );
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain(reason);
    expect(error.message).toContain('--force --reason');
    expect(store.calls).not.toContain('activate');
  });

  it('skips the gate with --force and a reason, logging the operator and reason', async () => {
    const { store, versionId } = await storeWithVersion();
    const events: Record<string, unknown>[] = [];
    const result = await activateVersion({
      store,
      instanceId: 'help',
      versionId,
      force: true,
      reason: '  demo data, no eval harness yet ',
      operator: 'ankur',
      log: (event) => events.push({ ...event }),
    });
    expect(result.forced).toBe(true);
    expect(events[0]).toEqual({
      event: 'index.activation_forced',
      instanceId: 'help',
      versionId,
      operator: 'ankur',
      reason: 'demo data, no eval harness yet',
      gate: 'it has no eval run',
    });
    expect(store.activations).toEqual([
      {
        instanceId: 'help',
        versionId,
        force: true,
        reason: 'demo data, no eval harness yet',
        operator: 'ankur',
      },
    ]);
  });

  it('records a passing gate on a forced activation', async () => {
    const { store, versionId } = await storeWithVersion();
    await store.recordEvalRun('help', versionId, evalRun(true));
    const events: Record<string, unknown>[] = [];
    await activateVersion({
      store,
      instanceId: 'help',
      versionId,
      force: true,
      reason: 'r',
      operator: 'o',
      log: (event) => events.push({ ...event }),
    });
    expect(events[0]?.gate).toBe('passed');
  });

  it.each([undefined, '', '   '])('requires a reason with --force (%j)', async (reason) => {
    const { store, versionId } = await storeWithVersion();
    const error = await failure(
      activateVersion({
        store,
        instanceId: 'help',
        versionId,
        force: true,
        ...(reason === undefined ? {} : { reason }),
        operator: 'o',
        log: () => undefined,
      }),
    );
    expect(error.message).toBe('--force needs --reason explaining why');
  });

  it('refuses a reason longer than the activation log allows', async () => {
    const { store, versionId } = await storeWithVersion();
    const error = await failure(
      activateVersion({
        store,
        instanceId: 'help',
        versionId,
        force: true,
        reason: 'x'.repeat(1001),
        operator: 'o',
        log: () => undefined,
      }),
    );
    expect(error.message).toBe('--reason must be at most 1000 characters');
    expect(store.calls).not.toContain('activate');
  });

  it.each(['', '   ', 'o'.repeat(129)])('refuses an unusable operator name (%j)', async (name) => {
    const { store, versionId } = await storeWithVersion();
    await store.recordEvalRun('help', versionId, evalRun(true));
    const error = await failure(
      activateVersion({
        store,
        instanceId: 'help',
        versionId,
        operator: name,
        log: () => undefined,
      }),
    );
    expect(error.message).toContain('--operator');
    expect(store.calls).not.toContain('activate');
  });

  it('rolls back to a retired version that passed its eval', async () => {
    const { store, versionId: first } = await storeWithVersion();
    await store.recordEvalRun('help', first, evalRun(true));
    const second = await store.createIndexVersion('help', {
      embeddingProvider: 'mock',
      embeddingModel: 'mock-hash-v1',
      embeddingDimensions: 384,
      chunkerHash: HASH,
      configHash: HASH,
    });
    await store.markReady('help', second, { documents: 1, chunks: 1 });
    await store.recordEvalRun('help', second, evalRun(true));
    const options = { store, instanceId: 'help', operator: 'o', log: () => undefined };
    await activateVersion({ ...options, versionId: first });
    await activateVersion({ ...options, versionId: second });
    expect(await activateVersion({ ...options, versionId: first })).toMatchObject({
      previousVersionId: second,
    });
  });

  it('reports unknown and non-activatable versions', async () => {
    const { store, versionId } = await storeWithVersion();
    const options = { store, instanceId: 'help', operator: 'o', log: () => undefined };
    expect(await failure(activateVersion({ ...options, versionId: 'nope' }))).toMatchObject({
      code: 'not_found',
    });
    await store.recordEvalRun('help', versionId, evalRun(true));
    await activateVersion({ ...options, versionId });
    const error = await failure(activateVersion({ ...options, versionId }));
    expect(error.message).toContain('is active; only ready or retired versions');
  });
});

describe('evalGateFailure', () => {
  it('passes only a matching, passing latest run', async () => {
    const { store, versionId } = await storeWithVersion();
    await store.recordEvalRun('help', versionId, evalRun(true));
    const version = await store.getVersion('help', versionId);
    expect(version && evalGateFailure(version)).toBeUndefined();
  });
});
