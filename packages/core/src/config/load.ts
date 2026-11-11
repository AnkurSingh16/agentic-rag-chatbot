import { parse } from 'yaml';
import type { z } from 'zod';
import { ChatbotError } from '../errors.js';
import { canonicalJson, sha256Hex } from '../hash.js';
import { ACCESS_MODES, instanceConfigSchema } from './schema.js';
import type { AccessMode, InstanceConfig } from './schema.js';

/** Environment variables as provided by `process.env`. */
export type Environment = Readonly<Record<string, string | undefined>>;

export interface LoadedInstanceConfig {
  config: InstanceConfig;
  /** sha256 of the validated config as canonical JSON; stored on index versions and traces. */
  configHash: string;
}

/** The environment variable that overrides an instance's auth mode, e.g. `RAG_AUTH_MODE__AEGIS_AI`. */
export function authModeOverrideVariable(instanceId: string): string {
  return `RAG_AUTH_MODE__${instanceId.toUpperCase().replaceAll('-', '_')}`;
}

function isAccessMode(value: unknown): value is AccessMode {
  return typeof value === 'string' && (ACCESS_MODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      return `${path === '' ? '(root)' : path}: ${issue.message}`;
    })
    .join('; ');
}

function applyAuthModeOverride(raw: unknown, env: Environment): void {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !isRecord(raw.auth)) return;
  const variable = authModeOverrideVariable(raw.id);
  const override = env[variable];
  if (override === undefined || override === '') return;

  if (!isAccessMode(override)) {
    throw new ChatbotError(
      'invalid_config',
      `${variable}: must be one of ${ACCESS_MODES.join(', ')}, got "${override}"`,
    );
  }
  const configured = raw.auth.mode;
  if (override === 'public' && (configured === 'authenticated' || configured === 'rbac')) {
    throw new ChatbotError(
      'invalid_config',
      `${variable}: cannot change auth.mode from ${configured} to public (ADR 0003)`,
    );
  }
  raw.auth.mode = override;
}

/**
 * Parses and validates an `instance.yaml`, applies the auth mode override from
 * the environment and runs {@link assertBootSafe}.
 *
 * @throws ChatbotError with code `invalid_config` naming the offending field.
 */
export function loadInstanceConfig(yamlText: string, env: Environment): LoadedInstanceConfig {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unreadable YAML';
    throw new ChatbotError('invalid_config', `instance.yaml is not valid YAML: ${reason}`, {
      cause: error,
    });
  }

  applyAuthModeOverride(raw, env);

  const result = instanceConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ChatbotError(
      'invalid_config',
      `Invalid instance config: ${formatIssues(result.error.issues)}`,
    );
  }

  assertBootSafe(result.data);
  return { config: result.data, configHash: sha256Hex(canonicalJson(result.data)) };
}

/**
 * Rejects configurations that ADR 0003 forbids and that can be detected without
 * a database. Checks that need the active index version run in the server.
 *
 * @throws ChatbotError with code `invalid_config` naming the offending field.
 */
export function assertBootSafe(config: InstanceConfig): void {
  const { auth } = config;
  if (auth.mode === 'public' && config.features.adminApi) {
    throw new ChatbotError(
      'invalid_config',
      `features.adminApi: admin and training routes cannot be enabled for public instance "${config.id}"`,
    );
  }
  if (auth.mode === 'rbac' && Object.keys(auth.roles).length === 0) {
    throw new ChatbotError(
      'invalid_config',
      `auth.roles: rbac instance "${config.id}" must map at least one role`,
    );
  }
}
