import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ChatbotError,
  authModeOverrideVariable,
  isLoopbackHost,
  loadInstanceConfig,
} from '@agentic-rag/core';
import type { Environment, InstanceConfig } from '@agentic-rag/core';

export interface AppConfig {
  databaseUrl: string;
  instancesDir: string;
  instanceId: string | undefined;
  host: string;
  port: number;
  sessionSecret: string;
  /** True when no SESSION_SECRET was set and a random one was made for this process. */
  sessionSecretGenerated: boolean;
  trustedProxies: string[];
}

const MIN_SECRET_LENGTH = 32;

function setting(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** Reads the server settings from the environment; see .env.example. */
export function readAppConfig(env: Environment, cwd: string): AppConfig {
  const databaseUrl = setting(env, 'DATABASE_URL');
  if (databaseUrl === undefined) {
    throw new ChatbotError('invalid_config', 'DATABASE_URL is not set; see .env.example');
  }
  const port = Number(setting(env, 'PORT') ?? '4100');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ChatbotError('invalid_config', 'PORT must be an integer from 1 to 65535');
  }
  const instanceId = setting(env, 'INSTANCE_ID');
  if (setting(env, 'AUTH_MODE') !== undefined && instanceId === undefined) {
    throw new ChatbotError('invalid_config', 'AUTH_MODE applies to INSTANCE_ID, which is not set');
  }

  const host = setting(env, 'HOST') ?? '127.0.0.1';
  let sessionSecret = setting(env, 'SESSION_SECRET');
  const sessionSecretGenerated = sessionSecret === undefined;
  if (sessionSecret === undefined) {
    // A random secret per start is only acceptable for a local, unbilled server: anywhere else a
    // restart would silently end every session, and live mode spends money per request.
    const loopback = isLoopbackHost(host);
    const reason =
      env.NODE_ENV === 'production'
        ? 'NODE_ENV=production'
        : setting(env, 'LLM_PROVIDER') === 'anthropic'
          ? 'LLM_PROVIDER=anthropic'
          : loopback
            ? undefined
            : `HOST=${host} is not a loopback address`;
    if (reason !== undefined) {
      throw new ChatbotError(
        'invalid_config',
        `SESSION_SECRET is required when ${reason}; generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      );
    }
    sessionSecret = randomBytes(32).toString('base64url');
  } else if (sessionSecret.length < MIN_SECRET_LENGTH) {
    throw new ChatbotError(
      'invalid_config',
      `SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }

  return {
    databaseUrl,
    instancesDir: resolve(cwd, setting(env, 'INSTANCES_DIR') ?? 'instances'),
    instanceId,
    host,
    port,
    sessionSecret,
    sessionSecretGenerated,
    trustedProxies: (setting(env, 'TRUSTED_PROXIES') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  };
}

async function loadOne(directory: string, id: string, env: Environment): Promise<InstanceConfig> {
  const path = join(directory, id, 'instance.yaml');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ChatbotError('invalid_config', `Cannot read ${path}`, { cause: error });
  }
  const { config } = loadInstanceConfig(text, env);
  if (config.id !== id) {
    throw new ChatbotError('invalid_config', `${path} has id "${config.id}", expected "${id}"`);
  }
  // Fail closed: token verification for these modes arrives in phase 5, and serving them
  // without it would leave their documents unprotected (ADR 0003).
  if (config.auth.mode !== 'public') {
    throw new ChatbotError(
      'invalid_config',
      `Instance "${id}" uses auth.mode ${config.auth.mode}, which the server does not implement until phase 5; refusing to start`,
    );
  }
  return config;
}

/**
 * Loads `instances/<id>/instance.yaml` for INSTANCE_ID, or for every instance folder. AUTH_MODE
 * overrides INSTANCE_ID's mode and, like the per-instance variable, may only tighten it.
 */
export async function loadInstances(
  config: AppConfig,
  env: Environment,
): Promise<InstanceConfig[]> {
  if (config.instanceId !== undefined) {
    const authMode = setting(env, 'AUTH_MODE');
    const instanceEnv =
      authMode === undefined
        ? env
        : { ...env, [authModeOverrideVariable(config.instanceId)]: authMode };
    return [await loadOne(config.instancesDir, config.instanceId, instanceEnv)];
  }
  let entries;
  try {
    entries = await readdir(config.instancesDir, { withFileTypes: true });
  } catch (error) {
    throw new ChatbotError('invalid_config', `Cannot read INSTANCES_DIR ${config.instancesDir}`, {
      cause: error,
    });
  }
  const ids = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort();
  const instances: InstanceConfig[] = [];
  for (const id of ids) instances.push(await loadOne(config.instancesDir, id, env));
  if (instances.length === 0) {
    throw new ChatbotError('invalid_config', `No instances found in ${config.instancesDir}`);
  }
  return instances;
}
