import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/index.ts',
        '**/*.d.ts',
        // Process entry point: wires env, a pg connection and stdout around readMigrateCliConfig
        // and migrate, which are unit-tested. The CI integration job runs it against PostgreSQL.
        'packages/server/src/store/migrate-cli.ts',
        // Same for ragctl: wires env, pg pools and stdio around run(), which is unit-tested.
        'packages/cli/src/main.ts',
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
