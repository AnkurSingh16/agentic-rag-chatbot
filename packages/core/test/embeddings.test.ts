import { describe, expect, it } from 'vitest';
import {
  ChatbotError,
  LOCAL_EMBEDDING_MODEL,
  createEmbeddingProvider,
  createLocalEmbeddingProvider,
  resolveEmbeddingConfig,
} from '../src/index.js';
import type { EmbeddingConfig, FeatureExtractor, PipelineFactory } from '../src/index.js';

const signal = new AbortController().signal;

function unit(axis: number): number[] {
  return Array.from({ length: 384 }, (_, i) => (i === axis ? 1 : 0));
}

function fakePipeline(
  output: (texts: string[]) => unknown = (texts) => texts.map((_, i) => unit(i)),
) {
  const loads: { model: string; cacheDir: string }[] = [];
  const calls: { texts: string[]; options: unknown }[] = [];
  const factory: PipelineFactory = (model, options) => {
    loads.push({ model, cacheDir: options.cacheDir });
    const extract: FeatureExtractor = (texts, extractOptions) => {
      calls.push({ texts, options: extractOptions });
      return Promise.resolve({ tolist: () => output(texts) });
    };
    return Promise.resolve(extract);
  };
  return { factory, loads, calls };
}

describe('createLocalEmbeddingProvider', () => {
  it('loads the pipeline once, with mean pooling and normalisation', async () => {
    const fake = fakePipeline();
    const provider = createLocalEmbeddingProvider({ pipelineFactory: fake.factory });
    expect(provider).toMatchObject({
      provider: 'local',
      model: LOCAL_EMBEDDING_MODEL,
      dimensions: 384,
    });
    expect(await provider.embed(['a', 'b'], signal)).toEqual([unit(0), unit(1)]);
    await provider.embed(['c'], signal);
    expect(await provider.embed([], signal)).toEqual([]);
    expect(fake.loads).toEqual([{ model: 'Xenova/all-MiniLM-L6-v2', cacheDir: '.cache/models' }]);
    expect(fake.calls[0]).toEqual({
      texts: ['a', 'b'],
      options: { pooling: 'mean', normalize: true },
    });
  });

  it('rejects output of the wrong shape', async () => {
    const provider = createLocalEmbeddingProvider({
      pipelineFactory: fakePipeline(() => [[1, 2, 3]]).factory,
    });
    await expect(provider.embed(['a'], signal)).rejects.toThrow('did not return 1 vectors of 384');
  });

  it('retries a failed model load on the next call and explains the offline option', async () => {
    let attempts = 0;
    const working = fakePipeline();
    const provider = createLocalEmbeddingProvider({
      pipelineFactory: (model, options) => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('fetch failed'))
          : working.factory(model, options);
      },
    });
    const error = await provider.embed(['a'], signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChatbotError);
    expect((error as ChatbotError).message).toContain(
      'set EMBEDDING_PROVIDER=mock to work offline',
    );
    expect(await provider.embed(['a'], signal)).toEqual([unit(0)]);
    const controller = new AbortController();
    controller.abort();
    await expect(provider.embed(['a'], controller.signal)).rejects.toThrow();
  });
});

describe('resolveEmbeddingConfig and createEmbeddingProvider', () => {
  const local: EmbeddingConfig = {
    provider: 'local',
    model: LOCAL_EMBEDDING_MODEL,
    dimensions: 384,
  };

  it('keeps the instance settings unless EMBEDDING_PROVIDER selects another provider', () => {
    expect(resolveEmbeddingConfig(local, {})).toBe(local);
    expect(resolveEmbeddingConfig(local, { EMBEDDING_PROVIDER: 'local' })).toBe(local);
    expect(resolveEmbeddingConfig(local, { EMBEDDING_PROVIDER: 'mock' })).toEqual({
      provider: 'mock',
      model: 'mock-hash-v1',
      dimensions: 384,
    });
    expect(() => resolveEmbeddingConfig(local, { EMBEDDING_PROVIDER: 'voyage' })).toThrow(
      'EMBEDDING_PROVIDER must be one of local, mock, got "voyage"',
    );
  });

  it('creates the selected provider with MODEL_CACHE_DIR', async () => {
    expect(
      createEmbeddingProvider({ EMBEDDING_PROVIDER: 'mock' }, { embedding: local }).provider,
    ).toBe('mock');
    const fake = fakePipeline();
    const provider = createEmbeddingProvider(
      { MODEL_CACHE_DIR: '/tmp/models' },
      { embedding: local },
      { pipelineFactory: fake.factory },
    );
    await provider.embed(['a'], signal);
    expect(fake.loads[0]?.cacheDir).toBe('/tmp/models');
    expect(createEmbeddingProvider({}, { embedding: local }).provider).toBe('local');
  });
});
