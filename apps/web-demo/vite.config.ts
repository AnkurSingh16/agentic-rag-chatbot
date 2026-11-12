import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
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
