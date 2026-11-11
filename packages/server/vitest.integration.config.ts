import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@agentic-rag/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'server-integration',
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/integration/**/*.test.ts'],
    // All files share one database and one migration history.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
