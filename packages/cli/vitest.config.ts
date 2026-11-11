import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      '@agentic-rag/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@agentic-rag/server': fileURLToPath(new URL('../server/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'cli',
    include: ['test/**/*.test.ts'],
  },
});
