import { ChatbotError } from '../errors.js';

/** Longest accepted user message (ADR 0004). */
export const MAX_MESSAGE_CHARS = 2000;

// Control characters other than tab and line breaks have no place in a chat message and can hide
// text from reviewers of logs and transcripts.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * `guard_in`: returns the trimmed message, or throws `invalid_input` for an empty or too long
 * message or one with control characters.
 */
export function guardInput(message: string): string {
  const trimmed = message.trim();
  if (trimmed === '') throw new ChatbotError('invalid_input', 'Message is empty');
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    throw new ChatbotError(
      'invalid_input',
      `Message is longer than ${MAX_MESSAGE_CHARS} characters`,
    );
  }
  if (CONTROL.test(trimmed)) {
    throw new ChatbotError('invalid_input', 'Message contains control characters');
  }
  return trimmed;
}

/** Citation markers as the answer prompt asks for them: `[c` and six hex digits `]`. */
export const CITATION = /\[(c[0-9a-f]{6})\]/g;

export type ParagraphCheck =
  | { ok: true; citationIds: string[] }
  | { ok: false; reason: 'unsupported' | 'unknown_citation' | 'forbidden_topic' };

/**
 * `verify` and `guard_out` for one paragraph, before it is released: every citation must be one
 * of this request's IDs, at least one must be present, and no forbidden topic may appear
 * (case-insensitive). This is not an entailment check (ADR 0005).
 */
export function checkParagraph(
  paragraph: string,
  known: ReadonlySet<string>,
  forbiddenTopics: readonly string[],
): ParagraphCheck {
  const lower = paragraph.toLowerCase();
  if (forbiddenTopics.some((topic) => lower.includes(topic.toLowerCase()))) {
    return { ok: false, reason: 'forbidden_topic' };
  }
  const cited = [...paragraph.matchAll(CITATION)].map((match) => match[1] ?? '');
  if (cited.some((id) => !known.has(id))) return { ok: false, reason: 'unknown_citation' };
  if (cited.length === 0) return { ok: false, reason: 'unsupported' };
  return { ok: true, citationIds: [...new Set(cited)] };
}
