import { userInfo } from 'node:os';
import pg from 'pg';
import { createPostgresIngestStore, migrate } from '@agentic-rag/server';
import { run } from './cli.js';

// Variables already set in the shell win over .env, as with `node --env-file`.
try {
  process.loadEnvFile('.env');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const controller = new AbortController();
process.once('SIGINT', () => {
  controller.abort();
});

process.exitCode = await run(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  openIngestStore: (url) => {
    const pool = new pg.Pool({ connectionString: url, max: 2, application_name: 'ragctl' });
    return { store: createPostgresIngestStore(pool), close: () => pool.end() };
  },
  migrate: async (config) => {
    const client = new pg.Client({
      connectionString: config.adminUrl,
      connectionTimeoutMillis: 5000,
      application_name: 'ragctl-migrate',
    });
    await client.connect();
    try {
      return await migrate(client, config);
    } finally {
      await client.end();
    }
  },
  fetch: (url, init) => fetch(url, init),
  operator: process.env.USER ?? userInfo().username,
  signal: controller.signal,
});
