import { describe, expect, it } from 'vitest';
import {
  FAKE_EMBEDDING_MODEL,
  createFakeEmbeddingProvider,
  noopReranker,
} from '../src/providers/fake.js';

const signal = new AbortController().signal;

function cosine(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, value, i) => sum + value * (b[i] ?? 0), 0);
}

function norm(vector: readonly number[]): number {
  return Math.sqrt(cosine(vector, vector));
}

describe('createFakeEmbeddingProvider', () => {
  const provider = createFakeEmbeddingProvider();

  it('describes itself as the fake 1024-dimension provider', () => {
    expect(provider.provider).toBe('fake');
    expect(provider.model).toBe(FAKE_EMBEDDING_MODEL);
    expect(provider.dimensions).toBe(1024);
    expect(createFakeEmbeddingProvider({ model: 'custom' }).model).toBe('custom');
  });

  it('returns one 1024-dimension vector per text, in order', async () => {
    const vectors = await provider.embed(['alpha', 'beta', 'gamma'], signal);
    expect(vectors).toHaveLength(3);
    for (const vector of vectors) expect(vector).toHaveLength(1024);
    const [alpha] = await provider.embed(['alpha'], signal);
    expect(vectors[0]).toEqual(alpha);
  });

  it('is deterministic across calls and provider instances', async () => {
    const text = 'How do I reset my password?';
    const first = await provider.embed([text], signal);
    const second = await createFakeEmbeddingProvider().embed([text], signal);
    expect(second).toEqual(first);
  });

  it('returns L2-normalised vectors, including for text with no words', async () => {
    const vectors = await provider.embed(['one two two three', '', '?!', 'Ünïcödé 東京'], signal);
    for (const vector of vectors) expect(norm(vector)).toBeCloseTo(1, 10);
  });

  it('ignores case and punctuation', async () => {
    const [a, b] = await provider.embed(['Reset Password!', 'reset, password'], signal);
    expect(a).toEqual(b);
  });

  it('ranks texts that share more words as more similar', async () => {
    const [query, close, partial, unrelated] = await provider.embed(
      [
        'reset account password',
        'how to reset your account password',
        'account settings page',
        'shipping rates for international orders',
      ],
      signal,
    );
    if (!query || !close || !partial || !unrelated) throw new Error('missing vectors');
    const scores = [cosine(query, close), cosine(query, partial), cosine(query, unrelated)];
    expect(scores[0]).toBeGreaterThan(scores[1] ?? 1);
    expect(scores[1]).toBeGreaterThan(scores[2] ?? 1);
  });

  it('returns an empty list for no texts', async () => {
    await expect(provider.embed([], signal)).resolves.toEqual([]);
  });

  it('rejects when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('client disconnected'));
    await expect(provider.embed(['text'], controller.signal)).rejects.toThrow(
      'client disconnected',
    );
  });
});

describe('noopReranker', () => {
  it('keeps the order and returns a new array', async () => {
    const candidates = [
      { content: 'b', id: 2 },
      { content: 'a', id: 1 },
    ];
    const result = await noopReranker.rerank('query', candidates, signal);
    expect(result).toEqual(candidates);
    expect(result).not.toBe(candidates);
  });
});
