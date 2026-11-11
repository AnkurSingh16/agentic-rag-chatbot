import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/index.ts',
        '**/*.d.ts',
        // Process entry point: wires env, a pg connection and stdout around readMigrateCliConfig
        // and migrate, which are unit-tested. The CI integration job runs it against PostgreSQL.
        'packages/server/src/store/migrate-cli.ts',
        // Same for ragctl: wires env, pg pools and stdio around run(), which is unit-tested.
        'packages/cli/src/main.ts',
        // Same for the server and the web demo: env, pools and the DOM root around tested modules.
        'apps/server/src/main.ts',
        'apps/web-demo/src/main.tsx',
      ],
      reporter: ['text', 'lcov', 'json-summary'],
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
      },
    },
  },
});
