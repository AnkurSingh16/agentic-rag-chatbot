import { ChatbotError } from '@agentic-rag/core';

/** Settings for `migrate-cli`, read from the environment and arguments. */
export interface MigrateCliConfig {
  adminUrl: string;
  runtimePassword: string;
  ingestPassword: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Reads `DATABASE_ADMIN_URL`, `RAG_RUNTIME_PASSWORD` and `RAG_INGEST_PASSWORD`.
 *
 * Refuses a database host other than loopback unless `--allow-remote` is passed, so a shell that
 * still holds a hosted database URL is not migrated by accident.
 */
export function readMigrateCliConfig(
  env: Readonly<Record<string, string | undefined>>,
  args: readonly string[],
): MigrateCliConfig {
  const unknown = args.filter((arg) => arg !== '--allow-remote');
  if (unknown.length > 0) {
    throw new ChatbotError('invalid_input', `Unknown argument: ${unknown.join(' ')}`);
  }

  const adminUrl = required(env, 'DATABASE_ADMIN_URL');
  let url: URL;
  try {
    url = new URL(adminUrl);
  } catch {
    throw new ChatbotError('invalid_config', 'DATABASE_ADMIN_URL is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new ChatbotError('invalid_config', 'DATABASE_ADMIN_URL must be a postgres:// URL');
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) && !args.includes('--allow-remote')) {
    throw new ChatbotError(
      'invalid_config',
      'DATABASE_ADMIN_URL points at a non-loopback host; pass --allow-remote to migrate it',
    );
  }

  return {
    adminUrl,
    runtimePassword: required(env, 'RAG_RUNTIME_PASSWORD'),
    ingestPassword: required(env, 'RAG_INGEST_PASSWORD'),
  };
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (!value) throw new ChatbotError('invalid_config', `${name} is not set`);
  return value;
}
