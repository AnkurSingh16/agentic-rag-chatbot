import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ChatbotError, loadInstanceConfig } from '@agentic-rag/core';
import type { Environment, FetchLike, IngestStore, LoadedInstanceConfig } from '@agentic-rag/core';
import type { MigrateCliConfig, MigrateResult } from '@agentic-rag/server';

/** An open ingest store and the function that releases its connections. */
export interface StoreHandle {
  store: IngestStore;
  close(): Promise<void>;
}

/** Everything a command touches outside its own logic, injected so commands can be tested. */
export interface CliContext {
  env: Environment;
  cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  openIngestStore(url: string): StoreHandle;
  migrate(config: MigrateCliConfig): Promise<MigrateResult>;
  fetch: FetchLike;
  /** Who is running the command when --operator is not given; recorded with every activation. */
  operator: string;
  signal: AbortSignal;
}

const INSTANCE_ID = /^[a-z][a-z0-9-]{1,39}$/;

export function checkInstanceId(id: string | undefined): string {
  if (id === undefined) throw new ChatbotError('invalid_input', 'Missing instance ID');
  if (!INSTANCE_ID.test(id)) {
    throw new ChatbotError('invalid_input', `Instance ID "${id}" must match ${INSTANCE_ID.source}`);
  }
  return id;
}

export function instanceDirectory(context: CliContext, instancesDir: string, id: string): string {
  return resolve(context.cwd, instancesDir, id);
}

export interface LoadedInstance extends LoadedInstanceConfig {
  directory: string;
}

export async function loadInstance(
  context: CliContext,
  instancesDir: string,
  id: string,
): Promise<LoadedInstance> {
  const directory = instanceDirectory(context, instancesDir, id);
  const path = join(directory, 'instance.yaml');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ChatbotError(
      'not_found',
      `Cannot read ${path}; create the instance with "ragctl init ${id}"`,
      { cause: error },
    );
  }
  const loaded = loadInstanceConfig(text, context.env);
  if (loaded.config.id !== id) {
    throw new ChatbotError(
      'invalid_config',
      `${path} has id "${loaded.config.id}"; it must match the directory name "${id}"`,
    );
  }
  return { ...loaded, directory };
}

export function requireEnv(context: CliContext, name: string): string {
  const value = context.env[name];
  if (value === undefined || value === '') {
    throw new ChatbotError('invalid_config', `${name} is not set; see .env.example`);
  }
  return value;
}

export async function withIngestStore<T>(
  context: CliContext,
  fn: (store: IngestStore) => Promise<T>,
): Promise<T> {
  const handle = context.openIngestStore(requireEnv(context, 'DATABASE_INGEST_URL'));
  try {
    return await fn(handle.store);
  } finally {
    await handle.close();
  }
}
