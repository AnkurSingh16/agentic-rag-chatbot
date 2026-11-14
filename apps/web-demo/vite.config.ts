import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  // The widget is read from source, so the demo does not need the package built first.
  resolve: {
    alias: [
      {
        find: /^@agentic-rag\/react\/widget\.css$/,
        replacement: fileURLToPath(new URL('../../packages/react/src/widget.css', import.meta.url)),
      },
      {
        find: /^@agentic-rag\/react$/,
        replacement: fileURLToPath(new URL('../../packages/react/src/index.ts', import.meta.url)),
      },
    ],
  },
  // WEB_DEMO_PORT moves the demo off 5180; the instance's allowedOrigins must list the new origin.
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_DEMO_PORT ?? 5180),
    strictPort: true,
  },
  test: {
    name: 'web-demo',
    environment: 'jsdom',
    include: ['test/**/*.test.tsx'],
  },
});
