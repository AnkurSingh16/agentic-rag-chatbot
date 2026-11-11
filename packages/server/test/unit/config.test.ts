import { describe, expect, it } from 'vitest';
import { readMigrateCliConfig } from '../../src/store/config.js';

const env = {
  DATABASE_ADMIN_URL: 'postgres://admin:secret@127.0.0.1:5432/rag',
  RAG_RUNTIME_PASSWORD: 'runtime-password-for-tests',
  RAG_INGEST_PASSWORD: 'ingest-password-for-tests',
};

describe('readMigrateCliConfig', () => {
  it('reads the admin URL and role passwords for a loopback database', () => {
    expect(readMigrateCliConfig(env, [])).toEqual({
      adminUrl: env.DATABASE_ADMIN_URL,
      runtimePassword: env.RAG_RUNTIME_PASSWORD,
      ingestPassword: env.RAG_INGEST_PASSWORD,
    });
  });

  it('refuses a remote host unless --allow-remote is passed', () => {
    const remote = { ...env, DATABASE_ADMIN_URL: 'postgresql://admin:secret@db.example.com/rag' };
    expect(() => readMigrateCliConfig(remote, [])).toThrow(/--allow-remote/);
    expect(readMigrateCliConfig(remote, ['--allow-remote']).adminUrl).toBe(
      remote.DATABASE_ADMIN_URL,
    );
  });

  it('rejects missing settings, bad URLs and unknown arguments', () => {
    expect(() => readMigrateCliConfig({ ...env, DATABASE_ADMIN_URL: undefined }, [])).toThrow(
      /DATABASE_ADMIN_URL is not set/,
    );
    expect(() => readMigrateCliConfig({ ...env, RAG_INGEST_PASSWORD: '' }, [])).toThrow(
      /RAG_INGEST_PASSWORD is not set/,
    );
    expect(() => readMigrateCliConfig({ ...env, DATABASE_ADMIN_URL: 'not a url' }, [])).toThrow(
      /not a valid URL/,
    );
    expect(() =>
      readMigrateCliConfig({ ...env, DATABASE_ADMIN_URL: 'mysql://127.0.0.1/rag' }, []),
    ).toThrow(/postgres:\/\//);
    expect(() => readMigrateCliConfig(env, ['--force'])).toThrow(/Unknown argument: --force/);
  });
});
