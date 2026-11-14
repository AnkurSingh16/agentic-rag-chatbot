import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activateVersion,
  createMockEmbeddingProvider,
  loadInstanceConfig,
  train,
} from '@agentic-rag/core';
import type { EmbeddingProvider, LoadedInstanceConfig } from '@agentic-rag/core';
import { createPostgresIngestStore } from '../../src/store/ingest-store.js';
import { migrate } from '../../src/store/migrate.js';
import { withInstanceTransaction } from '../../src/store/transaction.js';
import { adminUrl, createPool, ingestUrl, rolePasswords, runtimeUrl } from './database.js';
import { TEST_FINGERPRINT, uniqueInstanceId } from './database.js';

const runtime = createPool(runtimeUrl);
const ingestPool = createPool(ingestUrl);
const store = createPostgresIngestStore(ingestPool);
const directories: string[] = [];

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
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })));
});

function configFor(id: string, auth = 'auth:\n  mode: public'): LoadedInstanceConfig {
  return loadInstanceConfig(
    `id: ${id}
displayName: Test
persona:
  systemPrompt: Answer from the documents.
  answerStyle: Short.
  fallback:
    message: I cannot help with that.
models:
  chat: claude-haiku-5-5
embedding:
  provider: mock
  model: mock-hash-v1
${auth}
allowedOrigins:
  - http://localhost:5173
sources:
  - type: folder
    path: data
`,
    {},
  );
}

async function instanceDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rag-train-'));
  directories.push(dir);
  await mkdir(join(dir, 'data'));
  await writeFiles(dir, files);
  return dir;
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(dir, 'data', name), text);
  }
}

function countingEmbeddings(): EmbeddingProvider & { texts: number } {
  const inner = createMockEmbeddingProvider();
  const counter = {
    provider: inner.provider,
    model: inner.model,
    dimensions: inner.dimensions,
    texts: 0,
    embed: (texts: readonly string[], signal: AbortSignal) => {
      counter.texts += texts.length;
      return inner.embed(texts, signal);
    },
  };
  return counter;
}

function run(loaded: LoadedInstanceConfig, dir: string, embeddings = countingEmbeddings()) {
  return train({
    config: loaded.config,
    configHash: loaded.configHash,
    sources: { baseDir: dir, fetch: () => Promise.reject(new Error('no network in tests')) },
    store,
    embeddings,
    signal: new AbortController().signal,
  });
}

async function passEval(instanceId: string, versionId: string): Promise<void> {
  for (const harness of ['retrieval', 'chat'] as const) {
    await store.recordEvalRun(instanceId, versionId, {
      embeddingProvider: 'mock',
      embeddingModel: 'mock-hash-v1',
      passed: true,
      metrics: { harness, recallAt8: 1, configFingerprint: TEST_FINGERPRINT },
    });
  }
}

function activate(instanceId: string, versionId: string) {
  return activateVersion({
    store,
    instanceId,
    versionId,
    operator: 'integration-test',
    configFingerprint: TEST_FINGERPRINT,
    log: () => undefined,
  });
}

function servedContent(instanceId: string, accessTags: string[]): Promise<string[]> {
  return withInstanceTransaction(
    runtime,
    { instanceId, tenantKey: '_', accessTags },
    async (client) => {
      const result = await client.query<{ content: string }>(
        `SELECT c.content FROM rag.chunks c
         JOIN rag.instances i ON i.active_index_version_id = c.index_version_id
         ORDER BY c.content`,
      );
      return result.rows.map((row) => row.content);
    },
  );
}

const PAGES = {
  'install.md': '# Installing\n\nDownload the installer and run it.',
  'sync.md': '# Syncing\n\nNotes sync every five minutes when online.',
};

describe('training against PostgreSQL', () => {
  it('trains a ready version, gates activation on evals and rolls back', async () => {
    const id = uniqueInstanceId('train');
    const loaded = configFor(id);
    const dir = await instanceDir(PAGES);

    const first = await run(loaded, dir);
    expect(first).toMatchObject({ documents: 2, chunks: 2, embeddedChunks: 2, reusedChunks: 0 });
    const version = await store.getVersion(id, first.versionId);
    expect(version).toMatchObject({
      status: 'ready',
      embeddingProvider: 'mock',
      embeddingModel: 'mock-hash-v1',
      embeddingDimensions: 384,
      configHash: loaded.configHash,
      documentCount: 2,
      chunkCount: 2,
      latestEval: null,
    });

    await expect(activate(id, first.versionId)).rejects.toMatchObject({ code: 'invalid_input' });
    // The database holds the gate even for a caller that skips activateVersion.
    const bypass = store.activate(id, first.versionId, {
      force: false,
      reason: undefined,
      operator: 'x',
      configFingerprint: TEST_FINGERPRINT,
    });
    await expect(bypass).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(bypass).rejects.toThrow(/eval gate/);
    await passEval(id, first.versionId);
    expect(await activate(id, first.versionId)).toMatchObject({ previousVersionId: null });
    expect(await servedContent(id, ['public'])).toEqual([
      'Installing\n\nDownload the installer and run it.',
      'Syncing\n\nNotes sync every five minutes when online.',
    ]);

    await writeFiles(dir, { 'sync.md': '# Syncing\n\nNotes sync every minute when online.' });
    const second = await run(loaded, dir);
    await passEval(id, second.versionId);
    expect(await activate(id, second.versionId)).toMatchObject({
      previousVersionId: first.versionId,
    });
    expect(await servedContent(id, ['public'])).toContain(
      'Syncing\n\nNotes sync every minute when online.',
    );

    expect(await activate(id, first.versionId)).toMatchObject({
      previousVersionId: second.versionId,
    });
    expect(await servedContent(id, ['public'])).toContain(
      'Syncing\n\nNotes sync every five minutes when online.',
    );
    const statuses = Object.fromEntries(
      (await store.listVersions(id)).map((entry) => [entry.id, entry.status]),
    );
    expect(statuses).toEqual({ [first.versionId]: 'active', [second.versionId]: 'retired' });

    const log = await withInstanceTransaction(
      ingestPool,
      { instanceId: id, tenantKey: '_', accessTags: [] },
      async (client) => {
        const rows = await client.query<{ version: string; forced: boolean; operator: string }>(
          `SELECT index_version_id AS version, forced, operator FROM rag.activation_log
           ORDER BY id`,
        );
        return rows.rows;
      },
    );
    expect(log).toEqual([
      { version: first.versionId, forced: false, operator: 'integration-test' },
      { version: second.versionId, forced: false, operator: 'integration-test' },
      { version: first.versionId, forced: false, operator: 'integration-test' },
    ]);
  });

  it('reuses cached embeddings for unchanged chunks on the next run', async () => {
    const id = uniqueInstanceId('train-inc');
    const loaded = configFor(id);
    const dir = await instanceDir(PAGES);
    await run(loaded, dir);

    const unchanged = countingEmbeddings();
    expect(await run(loaded, dir, unchanged)).toMatchObject({
      chunks: 2,
      embeddedChunks: 0,
      reusedChunks: 2,
    });
    expect(unchanged.texts).toBe(0);

    await writeFiles(dir, { 'install.md': '# Installing\n\nUse the package manager instead.' });
    const changed = countingEmbeddings();
    expect(await run(loaded, dir, changed)).toMatchObject({ embeddedChunks: 1, reusedChunks: 1 });
    expect(changed.texts).toBe(1);
  });

  it('does not reuse another instance cache entries', async () => {
    const dir = await instanceDir(PAGES);
    await run(configFor(uniqueInstanceId('train-own')), dir);
    const other = countingEmbeddings();
    const result = await run(configFor(uniqueInstanceId('train-oth')), dir, other);
    expect(result).toMatchObject({ embeddedChunks: 2, reusedChunks: 0 });
    expect(other.texts).toBe(2);
  });

  it('stores chunks with their document tags, invisible to other tags and instances', async () => {
    const id = uniqueInstanceId('train-tag');
    const auth = `auth:
  mode: authenticated
  issuer: https://login.example.com/
  audience: test
  defaultTags: [staff]`;
    const loaded = configFor(id, auth);
    const dir = await instanceDir({
      'handbook.md': '# Handbook\n\nVisible to staff by default.',
      'payroll.md': '---\naccess: [payroll]\n---\n# Payroll\n\nVisible to payroll only.',
    });
    const result = await run(loaded, dir);
    await passEval(id, result.versionId);
    await activate(id, result.versionId);

    expect(await servedContent(id, ['staff'])).toEqual([
      'Handbook\n\nVisible to staff by default.',
    ]);
    expect(await servedContent(id, ['payroll'])).toEqual(['Payroll\n\nVisible to payroll only.']);
    expect(await servedContent(id, ['public'])).toEqual([]);

    const other = uniqueInstanceId('train-tag-b');
    await run(configFor(other), await instanceDir({ 'x.md': '# Other\n\nOther instance.' }));
    const crossInstance = await withInstanceTransaction(
      runtime,
      { instanceId: other, tenantKey: '_', accessTags: ['staff', 'payroll', 'public'] },
      async (client) => {
        const rows = await client.query<{ count: string }>(
          'SELECT count(*) FROM rag.chunks WHERE instance_id = $1',
          [id],
        );
        return rows.rows[0]?.count;
      },
    );
    expect(crossInstance).toBe('0');

    const stored = await withInstanceTransaction(
      ingestPool,
      { instanceId: id, tenantKey: '_', accessTags: [] },
      async (client) => {
        const rows = await client.query<{ source_uri: string; tags: string[]; tenant: string }>(
          `SELECT d.source_uri, c.access_tags AS tags, c.tenant_key AS tenant
           FROM rag.chunks c JOIN rag.documents d ON d.id = c.document_id
           WHERE c.index_version_id = $1 ORDER BY d.source_uri`,
          [result.versionId],
        );
        return rows.rows;
      },
    );
    expect(stored).toEqual([
      { source_uri: 'data/handbook.md', tags: ['staff'], tenant: '_' },
      { source_uri: 'data/payroll.md', tags: ['payroll'], tenant: '_' },
    ]);
  });

  it('keeps the active version and the three newest others', async () => {
    const id = uniqueInstanceId('train-keep');
    const loaded = configFor(id);
    const dir = await instanceDir(PAGES);
    const versions: string[] = [];
    for (let i = 0; i < 6; i++) {
      await writeFiles(dir, { 'counter.md': `# Counter\n\nRun number ${i}.` });
      const result = await run(loaded, dir);
      versions.push(result.versionId);
      if (i === 0) {
        await passEval(id, result.versionId);
        await activate(id, result.versionId);
      }
    }
    const kept = (await store.listVersions(id)).map((entry) => [entry.id, entry.status]);
    expect(kept).toEqual([
      [versions[5], 'ready'],
      [versions[4], 'ready'],
      [versions[3], 'ready'],
      [versions[0], 'active'],
    ]);
  });
});
