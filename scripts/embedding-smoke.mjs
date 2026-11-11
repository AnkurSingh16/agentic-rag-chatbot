// CI smoke test for the local embedding provider: downloads all-MiniLM-L6-v2 and checks that it
// returns 384-dimension vectors in which related sentences score higher than unrelated ones.
import { createLocalEmbeddingProvider } from '../packages/core/dist/index.js';

const provider = createLocalEmbeddingProvider({
  cacheDir: process.env.MODEL_CACHE_DIR || '.cache/models',
});
const [a, b, c] = await provider.embed(
  [
    'How do I export my notes to PDF?',
    'Notes can be exported as PDF files.',
    'The weather in the mountains was cold and windy.',
  ],
  new AbortController().signal,
);
const dot = (x, y) => x.reduce((sum, value, i) => sum + value * y[i], 0);
const related = dot(a, b);
const unrelated = dot(a, c);
console.log(
  JSON.stringify({ dimensions: a.length, related, unrelated, norm: Math.sqrt(dot(a, a)) }),
);
if (a.length !== 384 || b.length !== 384 || c.length !== 384) {
  throw new Error(`Expected 384 dimensions, got ${a.length}`);
}
if (!(related > unrelated)) {
  throw new Error(`Related sentences scored ${related}, unrelated ${unrelated}`);
}
