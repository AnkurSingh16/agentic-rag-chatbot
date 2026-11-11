import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      '@agentic-rag/core': fileURLToPath(
        new URL('../../packages/core/src/index.ts', import.meta.url),
      ),
      '@agentic-rag/server': fileURLToPath(
        new URL('../../packages/server/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    name: 'app-server',
    include: ['test/**/*.test.ts'],
  },
});
