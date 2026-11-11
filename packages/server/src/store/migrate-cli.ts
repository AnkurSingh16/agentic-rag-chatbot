import pg from 'pg';
import { toChatbotError } from '@agentic-rag/core';
import { readMigrateCliConfig } from './config.js';
import { migrate } from './migrate.js';

try {
  const config = readMigrateCliConfig(process.env, process.argv.slice(2));
  const client = new pg.Client({
    connectionString: config.adminUrl,
    connectionTimeoutMillis: 5000,
    application_name: 'rag-migrate',
  });
  await client.connect();
  try {
    const result = await migrate(client, config);
    console.info(JSON.stringify({ event: 'database.migrated', applied: result.applied }));
  } finally {
    await client.end();
  }
} catch (error) {
  // Messages come from our own checks or from PostgreSQL; neither includes the connection URL.
  const failure = toChatbotError(error);
  console.error(
    JSON.stringify({
      event: 'database.migration_failed',
      code: failure.code,
      message: failure.message,
    }),
  );
  process.exitCode = 1;
}
