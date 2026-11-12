import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChatbotError,
  EMBEDDING_BATCH_SIZE,
  createMockEmbeddingProvider,
  instanceConfigSchema,
  loadInstanceConfig,
  resolveEmbeddingConfig,
  train,
} from '../src/index.js';
import type { EmbeddingProvider, InstanceConfig, InstanceConfigInput } from '../src/index.js';
import { MemoryStore } from './memory-store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function instanceDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'core-train-'));
  directories.push(dir);
  await writeFiles(dir, files);
  return dir;
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
}

function config(overrides: Partial<InstanceConfigInput> = {}): InstanceConfig {
  return instanceConfigSchema.parse({
    id: 'help',
    displayName: 'Help',
    persona: { systemPrompt: 'Answer.', answerStyle: 'Short.', fallback: { message: 'No.' } },

    embedding: { provider: 'mock', model: 'mock-hash-v1' },
    auth: { mode: 'public' },
    allowedOrigins: ['http://localhost:5173'],
    sources: [{ type: 'folder', path: 'data' }],
    ...overrides,
  });
}

function countingEmbeddings(): EmbeddingProvider & { batches: number[] } {
  const inner = createMockEmbeddingProvider();
  const batches: number[] = [];
  return {
    provider: inner.provider,
    model: inner.model,
    dimensions: inner.dimensions,
    batches,
    embed: (texts, signal) => {
      batches.push(texts.length);
      return inner.embed(texts, signal);
    },
  };
}

const HASH = 'c'.repeat(64);
const noFetch = () => Promise.reject(new Error('no network'));

function run(
  dir: string,
  store: MemoryStore,
  options: {
    config?: InstanceConfig;
    embeddings?: EmbeddingProvider;
    signal?: AbortSignal;
    log?: (message: string) => void;
  } = {},
) {
  return train({
    config: options.config ?? config(),
    configHash: HASH,
    sources: { baseDir: dir, fetch: noFetch },
    store,
    embeddings: options.embeddings ?? countingEmbeddings(),
    signal: options.signal ?? new AbortController().signal,
    ...(options.log ? { log: options.log } : {}),
  });
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

describe('train', () => {
  it('writes a ready version with documents in source order and the version settings', async () => {
    const dir = await instanceDir({
      'data/b.md': '# Beta\n\nSecond page.',
      'data/a.md': '# Alpha\n\nFirst page.',
      'data/nested/c.txt': 'Plain text page.',
    });
    const store = new MemoryStore();
    const result = await run(dir, store);

    expect(result).toEqual({
      versionId: store.versions[0]?.id,
      documents: 3,
      chunks: 3,
      embeddedChunks: 3,
      reusedChunks: 0,
      prunedVersions: [],
    });
    const version = store.versions[0];
    expect(version).toMatchObject({
      instanceId: 'help',
      status: 'ready',
      embeddingProvider: 'mock',
      embeddingModel: 'mock-hash-v1',
      embeddingDimensions: 384,
      configHash: HASH,
      documentCount: 3,
      chunkCount: 3,
    });
    expect(version?.chunkerHash).toMatch(/^[0-9a-f]{64}$/);
    expect(version?.documents.map((entry) => entry.document)).toEqual([
      expect.objectContaining({ sourceUri: 'data/a.md', title: 'Alpha', accessTags: ['public'] }),
      expect.objectContaining({ sourceUri: 'data/b.md', title: 'Beta', tenantKey: '_' }),
      expect.objectContaining({ sourceUri: 'data/nested/c.txt', title: 'c' }),
    ]);
    expect(version?.documents[0]?.chunks[0]).toMatchObject({
      ordinal: 0,
      headingPath: ['Alpha'],
      content: 'Alpha\n\nFirst page.',
    });
    expect(version?.documents[0]?.chunks[0]?.embedding).toHaveLength(384);
    expect(store.calls.indexOf('cacheEmbeddings')).toBeLessThan(
      store.calls.indexOf('createIndexVersion'),
    );
  });

  it('produces identical versions from identical inputs', async () => {
    const dir = await instanceDir({ 'data/a.md': '# A\n\nText.', 'data/b.md': '# B\n\nMore.' });
    const first = new MemoryStore();
    const second = new MemoryStore();
    await run(dir, first);
    await run(dir, second);
    expect(second.versions[0]?.documents).toEqual(first.versions[0]?.documents);
  });

  it('reuses cached embeddings on the next run and embeds only changed chunks', async () => {
    const dir = await instanceDir({
      'data/a.md': '# A\n\nUnchanged.',
      'data/b.md': '# B\n\nWill change.',
    });
    const store = new MemoryStore();
    await run(dir, store);

    const unchanged = countingEmbeddings();
    expect(await run(dir, store, { embeddings: unchanged })).toMatchObject({
      chunks: 2,
      embeddedChunks: 0,
      reusedChunks: 2,
    });
    expect(unchanged.batches).toEqual([]);

    await writeFiles(dir, { 'data/b.md': '# B\n\nChanged now.' });
    const changed = countingEmbeddings();
    expect(await run(dir, store, { embeddings: changed })).toMatchObject({
      embeddedChunks: 1,
      reusedChunks: 1,
    });
    expect(changed.batches).toEqual([1]);
  });

  it('embeds new chunks in batches of 64', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 71; i++) files[`data/p${String(i).padStart(2, '0')}.md`] = `Page ${i}.`;
    const dir = await instanceDir(files);
    const embeddings = countingEmbeddings();
    const result = await run(dir, new MemoryStore(), { embeddings });
    expect(EMBEDDING_BATCH_SIZE).toBe(64);
    expect(embeddings.batches).toEqual([64, 7]);
    expect(result.chunks).toBe(71);
  });

  it('counts a chunk repeated in two documents as embedded once', async () => {
    const dir = await instanceDir({ 'data/a.txt': 'Same text.', 'data/b/a.txt': 'Same text.' });
    const embeddings = countingEmbeddings();
    const result = await run(dir, new MemoryStore(), { embeddings });
    expect(embeddings.batches).toEqual([1]);
    expect(result).toMatchObject({ chunks: 2, embeddedChunks: 2, reusedChunks: 0 });
  });

  it('takes access tags from front-matter, defaulting to the authenticated tags', async () => {
    const dir = await instanceDir({
      'data/open.md': '# Open\n\nFor everyone signed in.',
      'data/hr.md': '---\naccess: [hr, managers, hr]\n---\n# HR\n\nPolicies.',
    });
    const store = new MemoryStore();
    await run(dir, store, {
      config: config({
        auth: {
          mode: 'authenticated',
          issuer: 'https://login.example.com/',
          audience: 'help',
          defaultTags: ['staff', 'all'],
        },
      }),
    });
    const documents = store.versions[0]?.documents.map((entry) => entry.document);
    expect(documents?.map((d) => [d.sourceUri, d.accessTags])).toEqual([
      ['data/hr.md', ['hr', 'managers']],
      ['data/open.md', ['all', 'staff']],
    ]);
    expect(store.versions[0]?.documents[0]?.chunks[0]?.content).toBe('HR\n\nPolicies.');
  });

  it('fails an rbac instance listing every document without access tags, before writing', async () => {
    const dir = await instanceDir({
      'data/tagged.md': '---\naccess: [faq]\n---\n# Tagged\n\nOk.',
      'data/untagged-1.md': '# One\n\nNo tags.',
      'data/untagged-2.txt': 'No tags either.',
    });
    const store = new MemoryStore();
    const error = await failure(
      run(dir, store, {
        config: config({
          auth: {
            mode: 'rbac',
            issuer: 'https://login.example.com/',
            audience: 'help',
            roleClaim: 'roles',
            roles: { member: ['docs:read:faq'] },
          },
        }),
      }),
    );
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('data/untagged-1.md, data/untagged-2.txt');
    expect(error.message).not.toContain('tagged.md,');
    expect(store.calls).toEqual([]);
  });

  it('takes rbac tags from text-file front-matter and HTML meta tags, and fails closed without them', async () => {
    const rbac = {
      mode: 'rbac',
      issuer: 'https://login.example.com/',
      audience: 'help',
      roleClaim: 'roles',
      roles: { member: ['docs:read:faq', 'docs:read:staff'] },
    } as const;
    const dir = await instanceDir({ 'data/notes.txt': '---\naccess: [staff]\n---\nShift notes.' });
    const html = (meta: string) => () =>
      Promise.resolve(
        new Response(
          `<html><head>${meta}<title>Page</title></head><body><p>Body.</p></body></html>`,
          {
            headers: { 'content-type': 'text/html' },
          },
        ),
      );
    const pages: Record<string, () => Promise<Response>> = {
      'https://docs.example/tagged': html('<meta name="rag-access" content="faq">'),
      'https://docs.example/untagged': html(''),
    };
    const trainWith = (urls: string[], store: MemoryStore) =>
      train({
        config: config({
          auth: rbac,
          sources: [
            { type: 'folder', path: 'data' },
            { type: 'urls', urls },
          ],
        }),
        configHash: HASH,
        sources: {
          baseDir: dir,
          fetch: (url) => pages[url]?.() ?? Promise.reject(new Error('unreachable')),
          lookup: () => Promise.resolve([{ address: '192.0.2.10' }]),
        },
        store,
        embeddings: countingEmbeddings(),
        signal: new AbortController().signal,
      });

    const store = new MemoryStore();
    await trainWith(['https://docs.example/tagged'], store);
    const documents = store.versions[0]?.documents.map((entry) => entry.document);
    expect(documents?.map((d) => [d.sourceUri, d.accessTags])).toEqual([
      ['data/notes.txt', ['staff']],
      ['https://docs.example/tagged', ['faq']],
    ]);
    const notes = store.versions[0]?.documents[0]?.chunks[0]?.content;
    expect(notes).toContain('Shift notes.');
    expect(notes).not.toContain('access');

    const untagged = new MemoryStore();
    const error = await failure(
      trainWith(['https://docs.example/tagged', 'https://docs.example/untagged'], untagged),
    );
    expect(error.message).toContain('missing in: https://docs.example/untagged');
    expect(untagged.calls).toEqual([]);
  });

  it('rejects tags other than public on a public instance', async () => {
    const dir = await instanceDir({ 'data/a.md': '---\naccess: [internal]\n---\n# A\n\nText.' });
    const error = await failure(run(dir, new MemoryStore()));
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('data/a.md (internal)');
  });

  it('accepts an explicit public tag on a public instance', async () => {
    const dir = await instanceDir({ 'data/a.md': '---\naccess: [public]\n---\n# A\n\nText.' });
    expect((await run(dir, new MemoryStore())).documents).toBe(1);
  });

  it('refuses an embedding provider that does not match the config', async () => {
    const dir = await instanceDir({ 'data/a.md': '# A\n\nText.' });
    const embeddings = createMockEmbeddingProvider({ model: 'other-model' });
    const error = await failure(run(dir, new MemoryStore(), { embeddings }));
    expect(error.code).toBe('invalid_config');
    expect(error.message).toContain('mock/mock-hash-v1/384');
  });

  it('skips documents without text and fails when nothing is left', async () => {
    const dir = await instanceDir({ 'data/empty.md': '---\naccess: [public]\n---\n\n' });
    const messages: string[] = [];
    const error = await failure(run(dir, new MemoryStore(), { log: (m) => messages.push(m) }));
    expect(error.code).toBe('invalid_config');
    expect(messages).toEqual(['Skipped data/empty.md: no text to index']);
  });

  it('deletes the unfinished version when writing fails and keeps cached embeddings', async () => {
    const dir = await instanceDir({ 'data/a.md': '# A\n\nOne.', 'data/b.md': '# B\n\nTwo.' });
    const store = new MemoryStore();
    let inserts = 0;
    store.insertDocument = function (this: MemoryStore, ...args) {
      if (++inserts === 2) return Promise.reject(new Error('disk full'));
      return MemoryStore.prototype.insertDocument.apply(this, args);
    };
    const error = await failure(run(dir, store));
    expect(error.message).toBe('disk full');
    expect(store.versions).toEqual([]);
    expect(store.cache.size).toBe(2);
  });

  it('logs and rethrows the original error when cleanup also fails', async () => {
    const dir = await instanceDir({ 'data/a.md': '# A\n\nOne.' });
    const store = new MemoryStore();
    store.markReady = () => Promise.reject(new Error('lost connection'));
    store.deleteVersion = () => Promise.reject(new Error('still lost'));
    const messages: string[] = [];
    const error = await failure(run(dir, store, { log: (m) => messages.push(m) }));
    expect(error.message).toBe('lost connection');
    expect(messages.at(-1)).toMatch(/^Could not delete unfinished version .*: still lost$/);
  });

  it('rejects vectors of the wrong size from the provider', async () => {
    const dir = await instanceDir({ 'data/a.md': '# A\n\nOne.' });
    const embeddings: EmbeddingProvider = {
      ...createMockEmbeddingProvider(),
      embed: () => Promise.resolve([[1, 2, 3]]),
    };
    const error = await failure(run(dir, new MemoryStore(), { embeddings }));
    expect(error.code).toBe('provider_unavailable');
  });

  it('wraps provider failures', async () => {
    const dir = await instanceDir({ 'data/a.md': '# A\n\nOne.' });
    const embeddings: EmbeddingProvider = {
      ...createMockEmbeddingProvider(),
      embed: () => Promise.reject(new Error('503')),
    };
    const error = await failure(run(dir, new MemoryStore(), { embeddings }));
    expect(error).toMatchObject({ code: 'provider_unavailable', message: '503' });
  });

  it('stops when the signal is aborted', async () => {
    const dir = await instanceDir({ 'data/a.md': '# A\n\nOne.' });
    const controller = new AbortController();
    controller.abort();
    await expect(run(dir, new MemoryStore(), { signal: controller.signal })).rejects.toThrow();
  });

  it('keeps the active version and the three newest ready or retired versions', async () => {
    const dir = await instanceDir({ 'data/a.md': '# A\n\nRun.' });
    const store = new MemoryStore();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      await writeFiles(dir, { 'data/a.md': `# A\n\nRun ${i}.` });
      const result = await run(dir, store);
      ids.push(result.versionId);
      if (i === 0) {
        await store.activate('help', result.versionId, {
          force: true,
          reason: 'test',
          operator: 'tester',
        });
      }
      if (i === 4) expect(result.prunedVersions).toEqual([ids[1]]);
    }
    expect(store.versions.map((v) => [v.id, v.status])).toEqual([
      [ids[0], 'active'],
      [ids[2], 'ready'],
      [ids[3], 'ready'],
      [ids[4], 'ready'],
    ]);
  });

  it('logs instead of failing when pruning fails', async () => {
    const dir = await instanceDir({ 'data/a.md': '# A\n\nRun.' });
    const store = new MemoryStore();
    store.listVersions = () => Promise.reject(new Error('timeout'));
    const messages: string[] = [];
    const result = await run(dir, store, { log: (m) => messages.push(m) });
    expect(result.prunedVersions).toEqual([]);
    expect(messages.at(-1)).toBe('Could not delete old versions: timeout');
  });

  it('trains the demo instance as a public instance', async () => {
    const dir = fileURLToPath(new URL('../../../instances/demo/', import.meta.url));
    const loaded = loadInstanceConfig(await readFile(join(dir, 'instance.yaml'), 'utf8'), {});
    const store = new MemoryStore();
    const embedding = resolveEmbeddingConfig(loaded.config.embedding, {
      EMBEDDING_PROVIDER: 'mock',
    });
    const result = await train({
      config: { ...loaded.config, embedding },
      configHash: loaded.configHash,
      sources: { baseDir: dir, fetch: noFetch },
      store,
      embeddings: createMockEmbeddingProvider(),
      signal: new AbortController().signal,
    });
    expect(result.documents).toBe(8);
    const tags = store.versions[0]?.documents.flatMap((entry) => entry.document.accessTags);
    expect(new Set(tags)).toEqual(new Set(['public']));
  });
});
