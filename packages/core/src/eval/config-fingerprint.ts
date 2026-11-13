import { createHash } from 'node:crypto';
import type { InstanceConfig } from '../config/schema.js';

/**
 * A digest of the settings that decide what a chat turn can say: the persona, the forbidden
 * topics, the verification judge, the limits and the model names. A chat eval run records it, so
 * a later change to any of them is visible against the run (ADR 0009).
 */
export function chatConfigFingerprint(
  config: InstanceConfig,
  models: { chat: string; router: string },
): string {
  const settings = {
    persona: config.persona,
    verification: config.verification,
    limits: config.limits,
    models,
  };
  return createHash('sha256').update(canonicalJson(settings)).digest('hex');
}

/** JSON with object keys sorted at every level, so the digest does not depend on key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}
