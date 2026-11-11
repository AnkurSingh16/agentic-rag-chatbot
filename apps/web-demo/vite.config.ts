import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: {
    name: 'web-demo',
    environment: 'jsdom',
    include: ['test/**/*.test.tsx'],
  },
});
