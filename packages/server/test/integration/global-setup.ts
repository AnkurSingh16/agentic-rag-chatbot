import pg from 'pg';

/**
 * Empties the test database before the suite runs. Every test writes uniquely named instances, so
 * without this the shared tables grow across runs, and the HNSW index then returns no rows for a
 * small instance (the isolation test failed on a database with about 1,000 leftover chunks).
 * Only the loopback test database is touched, and the migration history is kept.
 */
export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_ADMIN_URL;
  if (!url) return;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'rag' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'`,
    );
    if (tables.rows.length > 0) {
      const names = tables.rows.map((row) => `rag.${row.table_name}`).join(', ');
      await client.query(`TRUNCATE ${names} CASCADE`);
    }
  } finally {
    await client.end();
  }
}
