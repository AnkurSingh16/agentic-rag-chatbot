import { createHash } from 'node:crypto';
import { LEXICAL_OVERLAP_MIN } from '../agent/guards.js';
import { ANSWER_RULES, JUDGE_SYSTEM, ROUTE_RULES } from '../agent/prompts.js';
import type { InstanceConfig } from '../config/schema.js';
import { RETRIEVAL } from '../retrieval/types.js';

/**
 * A digest of the settings that decide what a chat turn can say: the persona, the forbidden
 * topics, the verification judge, the limits, the model names and the shared prompts. A chat eval run records it, so
 * a later change to any of them is visible against the run (ADR 0009).
 */
export function chatConfigFingerprint(
  config: InstanceConfig,
  models: { chat: string; router: string },
  runtime: { chatDigest: string } = { chatDigest: 'none' },
): string {
  const settings = {
    persona: config.persona,
    verification: config.verification,
    limits: config.limits,
    models,
    // The model weights (Ollama digest), so a re-pulled tag is a different model.
    runtime,
    // Retrieval and guard constants the run depends on (naysayer, ADR 0009).
    retrieval: {
      maxVectorDistance: RETRIEVAL.maxVectorDistance,
      minFusedScore: RETRIEVAL.minFusedScore,
      rrfK: RETRIEVAL.rrfK,
      candidates: RETRIEVAL.candidates,
      limit: RETRIEVAL.limit,
      retryLimit: RETRIEVAL.retryLimit,
    },
    lexicalOverlapMin: LEXICAL_OVERLAP_MIN,
    // The prompts are part of what the gate measured, so a change to them invalidates the run.
    prompts: { route: ROUTE_RULES, answer: ANSWER_RULES, judge: JUDGE_SYSTEM },
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
