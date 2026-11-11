import { createHash } from 'node:crypto';
import { EMBEDDING_DIMENSIONS } from '../config/schema.js';
import type { EmbeddingProvider, Reranker } from './types.js';

export const MOCK_EMBEDDING_MODEL = 'mock-hash-v1';

const WORD = /[\p{L}\p{N}]+/gu;

// Each lower-cased word adds weight to one hashed dimension, so texts that
// share words point in similar directions. Weights are never negative, so the
// vector cannot cancel out to zero and can always be normalised.
function hashedVector(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  // Text with no words still needs a unit vector; the empty token gives it a fixed one.
  for (const word of text.toLowerCase().match(WORD) ?? ['']) {
    const index = createHash('sha256').update(word).digest().readUInt32BE(0) % EMBEDDING_DIMENSIONS;
    vector[index] = (vector[index] ?? 0) + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / norm);
}

/**
 * A deterministic embedding provider for tests and offline development
 * (ADR 0008). Vectors are L2-normalised and have 384 dimensions. It makes no
 * network calls and has no semantic understanding beyond shared words.
 */
export function createMockEmbeddingProvider(options: { model?: string } = {}): EmbeddingProvider {
  return {
    provider: 'mock',
    model: options.model ?? MOCK_EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    embed: (texts, signal) =>
      new Promise((resolve) => {
        signal.throwIfAborted();
        resolve(texts.map(hashedVector));
      }),
  };
}

/** The default reranker: keeps the retrieval order. */
export const noopReranker: Reranker = {
  rerank: (_query, candidates) => Promise.resolve([...candidates]),
};
